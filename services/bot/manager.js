
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
     * @returns {object} - The bot session object
     */
    launchBot(joinUrl) {
        // DUPLICATE CHECK: Don't launch if already running for this URL
        const existingId = Array.from(this.bots.entries())
            .find(([_, b]) => b.joinUrl === joinUrl && b.status !== BotState.ENDED && b.status !== BotState.FAILED && b.status !== BotState.KILLED)?.[0];

        if (existingId) {
            console.log(`[BotManager] Bot already active for ${joinUrl} (ID: ${existingId})`);
            return this.bots.get(existingId);
        }

        const id = crypto.randomUUID();
        // Ensure we are getting the correct path to bot.js
        const scriptPath = path.resolve(process.cwd(), 'services', 'bot', 'bot.js');

        const botSession = {
            id,
            joinUrl,
            status: BotState.CREATED,
            process: null,
            logs: [],
            startTime: new Date(),
            lastHeartbeat: Date.now()
        };

        this.bots.set(id, botSession);
        this.emit('bot-update', botSession);

        console.log(`[BotManager] Spawning bot ${id} for ${joinUrl}`);

        try {
            // Spawn the bot process
            // Note: We use 'detached: false' to keep it linked to this manager for now, 
            // but in a full service architecture, we might want detached.
            // Using IPC for communication.
            const child = spawn('node', [scriptPath, joinUrl], {
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

    handleBotMessage(id, msg) {
        // Handle structured IPC messages from bot
        // Expected format: { type: 'status'|'log'|'heartbeat', payload: ... }
        if (msg.type === 'status') {
            this.updateBotStatus(id, msg.payload);
        } else if (msg.type === 'log') {
            this.addBotLog(id, msg.payload);
        } else if (msg.type === 'heartbeat') {
            const session = this.bots.get(id);
            if (session) session.lastHeartbeat = Date.now();
        }
    }
}

// Singleton Instance
const botManager = new BotManager();
export { botManager, BotState };
