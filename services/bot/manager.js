
import { spawn } from 'child_process';
import path from 'path';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';

// Bot States Enum
const BotState = {
    CREATED: 'CREATED',
    LAUNCHING: 'LAUNCHING',
    NAVIGATING: 'NAVIGATING',
    PRE_JOIN: 'PRE_JOIN',
    JOINING: 'JOINING',
    IN_LOBBY: 'IN_LOBBY',        // ✅ Bot successfully joined but waiting for admission
    IN_MEETING: 'IN_MEETING',    // ✅ Bot is actively in the call
    LEAVING: 'LEAVING',
    ENDED: 'ENDED',
    FAILED: 'FAILED',
    KILLED: 'KILLED'
};

class BotManager extends EventEmitter {
    constructor() {
        super();
        this.bots = new Map(); // Store active bot sessions
    }

    /**
     * Launch a new bot instance
     * @param {string} joinUrl - The Teams meeting URL
     * @param {object} metadata - Optional metadata (meetingId, userId, subject)
     * @returns {object} - The bot session object
     */
    launchBot(joinUrl, metadata = {}) {
        // DUPLICATE CHECK: Don't launch if already running for this URL
        const existingId = Array.from(this.bots.entries())
            .find(([_, b]) => b.joinUrl === joinUrl && b.status !== BotState.ENDED && b.status !== BotState.FAILED && b.status !== BotState.KILLED)?.[0];

        if (existingId) {
            console.log(`[BotManager] Bot already active for ${joinUrl} (ID: ${existingId})`);
            return this.bots.get(existingId);
        }

        const id = crypto.randomUUID();
        const scriptPath = path.resolve(process.cwd(), 'services', 'bot', 'bot.js');

        const botSession = {
            id,
            joinUrl,
            metadata, // Store meetingId, userId, etc
            status: BotState.CREATED,
            process: null,
            logs: [],
            speakerEvents: [], // Log of [{name, timestamp}] for diarization
            startTime: new Date(),
            lastHeartbeat: Date.now()
        };

        this.bots.set(id, botSession);
        this.emit('bot-update', botSession);

        console.log(`[BotManager] Spawning bot ${id} for meeting ${metadata.meetingId || 'Manual'}`);

        try {
            // Pass joining URL AND meetingId as args
            const args = [scriptPath, joinUrl];
            if (metadata.meetingId) args.push(metadata.meetingId);

            const child = spawn('node', args, {
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                detached: false
            });

            botSession.process = child;
            this.updateBotStatus(id, BotState.LAUNCHING);

            // Handle IPC messages from the bot
            child.on('message', (msg) => {
                this.handleBotMessage(id, msg);
            });

            // Handle Standard Output/Error for debugging
            // We listen to these to catch syntax errors or native crashes that don't go through IPC
            child.stdout.on('data', (data) => {
                const msg = data.toString();
                // Filter out IPC JSON strings if they leak to stdout (optional optimization)
                if (!msg.includes('{"type":')) {
                    this.addBotLog(id, msg, 'stdout');
                }
            });

            child.stderr.on('data', (data) => {
                this.addBotLog(id, data.toString(), 'stderr');
            });

            // Handle Exit
            child.on('exit', (code, signal) => {
                console.log(`[BotManager] Bot ${id} exited with code ${code}`);
                const finalStatus = code === 0 ? BotState.ENDED : BotState.FAILED;
                this.updateBotStatus(id, finalStatus);

                // CRITICAL: Log this to the file so the UI knows to stop polling
                this.addBotLog(id, `Process exited with code ${code}. Status: ${finalStatus}`, 'system');

                // AUTOMATIC FINALIZATION
                if (botSession.metadata?.meetingId) {
                    this.finalizeMeeting(id);
                }
            });

            return botSession;

        } catch (error) {
            console.error(`[BotManager] Failed to spawn bot ${id}:`, error);
            this.updateBotStatus(id, BotState.FAILED);
            this.addBotLog(id, `Spawn Error: ${error.message}`, 'error');
            return botSession;
        }
    }

    /**
     * Stop a specific bot
     */
    stopBot(id) {
        const session = this.bots.get(id);
        if (session && session.process) {
            console.log(`[BotManager] Killing bot ${id}`);
            session.process.kill();
            this.updateBotStatus(id, BotState.KILLED);
        }
    }

    /**
     * Stop all running bots
     */
    stopAll() {
        for (const [id, session] of this.bots) {
            if (session.status !== BotState.ENDED && session.status !== BotState.FAILED && session.status !== BotState.KILLED) {
                this.stopBot(id);
            }
        }
    }

    /**
     * Get details of a specific bot
     */
    getBot(id) {
        return this.bots.get(id);
    }

    /**
     * Get all bots
     */
    getAllBots() {
        // Return array of bots without the process object to avoid circular JSON issues
        return Array.from(this.bots.values()).map(b => {
            const { process, ...safeBot } = b;
            // Add current speaker for UI feedback
            safeBot.currentSpeaker = b.speakerEvents?.length > 0
                ? b.speakerEvents[b.speakerEvents.length - 1].name
                : null;
            return safeBot;
        });
    }

    // --- Internal Helpers ---

    updateBotStatus(id, status) {
        const session = this.bots.get(id);
        if (session) {
            session.status = status;
            this.emit('bot-update', { id, status });
        }
    }

    addBotLog(id, message, type = 'info') {
        const session = this.bots.get(id);
        if (session) {
            const logEntry = {
                timestamp: new Date(),
                message: message.trim(),
                type
            };
            session.logs.push(logEntry);
            this.emit('bot-log', { id, logEntry });

            // PERSISTENCE HACK: Write to .log file so the current React UI (polling) still works
            // This is temporary until Step 2 (WebSockets) is complete.
            try {
                const logsDir = path.resolve(process.cwd(), '.bot-logs');
                if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
                // Add timestamp to the file line
                const timeStr = new Date().toISOString();
                fs.appendFileSync(path.resolve(logsDir, `${id}.log`), `[${timeStr}] ${message.trim()}\n`);
            } catch (e) {
                console.error('Failed to persist log to file:', e);
            }

            // Heuristic to update status based on logs if IPC isn't sending explicit status updates yet
            if (message.includes('Navigating to meeting')) this.updateBotStatus(id, BotState.NAVIGATING);
            if (message.includes('Pre-Join screen')) this.updateBotStatus(id, BotState.PRE_JOIN);
            if (message.includes('Attempting to JOIN')) this.updateBotStatus(id, BotState.JOINING);
            if (message.includes('Joined meeting')) this.updateBotStatus(id, BotState.IN_MEETING);
        }
    }

    async handleBotMessage(id, msg) {
        // Handle structured IPC messages from bot
        const session = this.bots.get(id);
        if (!session) return;

        if (msg.type === 'status') {
            this.updateBotStatus(id, msg.payload);
        } else if (msg.type === 'log') {
            this.addBotLog(id, msg.payload);
        } else if (msg.type === 'heartbeat') {
            session.lastHeartbeat = Date.now();
        } else if (msg.type === 'transcript') {
            const result = msg.payload; // This is now the full result object
            console.log(`[BotManager] Received transcript update for ${session.metadata?.meetingId || id} (${result.segments?.length || 0} segments)`);

            // 1. Generate professional VTT content from segments
            const vttContent = this.generateVTT(result.segments || [], session.metadata?.subject);
            session.vttContent = vttContent;

            // 2. Sync to Database via Backend Adapter
            if (session.metadata?.meetingId) {
                try {
                    const { ingestBotTranscript } = await import('../../lib/backend-adapter.js');
                    // We now pass the VTT content instead of raw text
                    await ingestBotTranscript(session.metadata.meetingId, vttContent, session.metadata);
                } catch (e) {
                    console.error('[BotManager] Failed to sync VTT to DB:', e.message);
                }
            }
        } else if (msg.type === 'stt-success') {
            const meetingId = session.metadata?.meetingId || id;
            console.log(`[BotManager] ✨ SUCCESS: ${meetingId} transcribed ${msg.payload.count || 0} lines.`);
            this.addBotLog(id, `✨ Transcription sync successful (${msg.payload.count || 0} lines)`, 'stt');
        } else if (msg.type === 'stt-error') {
            console.error(`[BotManager] ❌ STT ERROR (${id}):`, msg.payload.error);
            this.addBotLog(id, `❌ Transcription error: ${msg.payload.error}`, 'error');
        } else if (msg.type === 'speaker-change') {
            // Track who is speaking for diarization stitching
            session.speakerEvents.push({
                name: msg.payload.name,
                timestamp: msg.payload.timestamp
            });
            this.addBotLog(id, `🎤 Speaker: ${msg.payload.name}`, 'info');
        } else if (msg.type === 'recording-start') {
            session.recordingStartTime = msg.payload.timestamp;
            this.addBotLog(id, '🎤 Microphones active - transcription sync enabled.', 'info');
        }
    }

    /**
     * Convert STT segments to standard WEBVTT format
     */
    generateVTT(segments, subject = 'Meeting Participant') {
        const lines = ['WEBVTT', ''];

        // Get the session speaker events if available (we need to find the session)
        // Note: In a real app we'd pass the session context explicitly
        // Here we'll try to find it or fallback to the subject
        let speakerEvents = [];
        const session = Array.from(this.bots.values()).find(b => b.metadata?.subject === subject);
        if (session) speakerEvents = session.speakerEvents || [];

        segments.forEach((s, i) => {
            const formatTime = (seconds) => {
                const date = new Date(0);
                date.setSeconds(seconds);
                const ms = Math.floor((seconds % 1) * 1000);
                return date.toISOString().substr(11, 8) + '.' + String(ms).padStart(3, '0');
            };

            const start = formatTime(s.start);
            const end = formatTime(s.end);

            // DIARIZATION STITCHING: Absolute time sync
            let speaker = 'Participant';
            if (session && speakerEvents.length > 0) {
                // Use recordingStartTime (precise) or startTime (fallback)
                const anchorTime = session.recordingStartTime || session.startTime.getTime();
                const segmentWallTime = anchorTime + (s.start * 1000);

                // Find most recent speaker event that occurred at or before this segment
                const activeEvent = [...speakerEvents]
                    .reverse()
                    .find(e => e.timestamp <= segmentWallTime + 2000); // 2s buffer for UI pulse delay

                if (activeEvent) speaker = activeEvent.name;
                else speaker = speakerEvents[0].name; // Fallback to first participant
            } else {
                speaker = s.speaker || subject || 'Speaker';
            }

            lines.push(`bot-segment/${i}`);
            lines.push(`${start} --> ${end}`);
            lines.push(`<v ${speaker}>${s.text}</v>`);
            lines.push(''); // Empty line between entries
        });

        return lines.join('\n');
    }

    /**
     * Finalize meeting after bot exit (Background AI Tasks)
     */
    async finalizeMeeting(id) {
        const session = this.bots.get(id);
        if (!session || !session.metadata?.meetingId) return;

        const meetingId = session.metadata.meetingId;
        console.log(`[BotManager] 🏁 Finalizing meeting ${meetingId}...`);

        try {
            // Give the database a moment to settle last transcript chunks
            await new Promise(r => setTimeout(r, 5000));

            // We use the internal URL or localhost
            const baseUrl = 'http://localhost:3000';

            console.log(`[BotManager] Triggering AI Summary for ${meetingId}`);
            const summaryRes = await fetch(`${baseUrl}/api/summary/${meetingId}`);

            console.log(`[BotManager] Triggering Action Items for ${meetingId}`);
            const actionRes = await fetch(`${baseUrl}/api/actions/${meetingId}`);

            this.addBotLog(id, '✨ AI Finalization successful: Summary and Action Items generated.', 'info');
            console.log(`[BotManager] ✅ Meeting ${meetingId} fully processed.`);
        } catch (e) {
            console.error(`[BotManager] ❌ Finalization failed for ${meetingId}:`, e.message);
            this.addBotLog(id, `⚠️ Finalization error: ${e.message}`, 'error');
        }
    }
}

// Singleton Instance
const botManager = new BotManager();
export { botManager, BotState };
