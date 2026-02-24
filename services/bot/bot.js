import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

// Fix Unicode output for Windows - REMOVED to prevent crash in child_process
// if (process.platform === 'win32') {
//    process.stdout.setEncoding('utf8');
// }

const MEETING_URL = process.argv[2];
const MEETING_ID_ARG = process.argv[3]; // Capture optional meeting ID
const MEETING_ID = MEETING_ID_ARG || MEETING_URL.split('/').pop().split('?')[0] || `session-${Date.now()}`;

if (!MEETING_URL) {
    console.error(" FATAL: MEETING_URL is not defined");
    process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const RECORDINGS_DIR = path.resolve(process.cwd(), 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
const RECORDING_PATH = path.resolve(RECORDINGS_DIR, `meeting-${MEETING_ID}-${timestamp}.webm`);
const TRANSCRIPT_PATH = path.resolve(RECORDINGS_DIR, `transcript-${MEETING_ID}-${timestamp}.txt`);

function log(msg) {
    console.log(`[BOT ${MEETING_ID.substring(0, 8)}...] ${msg}`);
}

// Helper to safely send IPC messages
function sendIPC(type, payload) {
    if (process.send) {
        process.send({ type, payload });
    }
}

// Redirect ALL console output to IPC for the Manager to capture
// NOTE: Only send via IPC. Manager also listens on stdout which caused DUPLICATE logs.
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
    const msg = args.map(a => String(a)).join(' ');
    sendIPC('log', msg);
};
console.error = (...args) => {
    const msg = args.map(a => String(a)).join(' ');
    sendIPC('log', `❌ ${msg}`);
};
console.warn = (...args) => {
    const msg = args.map(a => String(a)).join(' ');
    sendIPC('log', `⚠️ ${msg}`);
};

const pid = process.pid;

(async () => {
    let sessionRecordingStartTime = null;
    const speakerTimeline = [];
    let recordingAnchorTime = Date.now();

    let soloTicks = 0; // NEW: Track how long bot is alone
    let isTranscribingIncrementally = false;
    sendIPC('status', 'LAUNCHING'); // Initial status
    console.log(`🤖 Bot Launching (Stable Mode) [PID: ${pid}]...`);

    const browser = await puppeteer.launch({
        headless: 'new',
        defaultViewport: { width: 1920, height: 1080 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-notifications',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            // Hardcorded silence and black frame to prevent ANY meeting disruption
            '--use-file-for-fake-audio-capture=NUL',
            '--use-file-for-fake-video-capture=NUL',
            '--disable-infobars',
            '--ignore-certificate-errors',
            '--disable-gpu',
            '--window-size=1920,1080',
            '--disable-dev-shm-usage',
            '--autoplay-policy=no-user-gesture-required',
            // WebRTC Stabilization
            '--disable-webrtc-hw-encoding',
            '--disable-webrtc-hw-decoding',
            '--enable-features=WebRtcHideLocalIpsWithMdns',
            '--allow-loopback-in-peer-connection',
            // Iframe/Security Bypass (Critical for cross-origin join buttons)
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            // High Performance / Background Timer bypass
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ]
    });

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();

    // Catch browser console logs
    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('%c')) return; // Skip styled noise
        log(`[BROWSER] ${text}`);
    });



    // Create a write stream for the audio data
    const audioStream = fs.createWriteStream(RECORDING_PATH);

    // Expose a function to the page to receive audio chunks
    let totalBytesReceived = 0;
    let audioHeader = null;
    let activeChunks = []; // NEW: Buffer for incremental transcription
    let fullSegments = []; // NEW: All segments found so far
    let globalOffset = 0.0; // Track total duration for timestamp shifting
    let chunkBatchCount = 0; // Track batches sent

    await page.exposeFunction('sendAudioChunk', (chunkBase64) => {
        const buffer = Buffer.from(chunkBase64, 'base64');

        activeChunks.push(buffer); // Since each chunk is now a full file, just push it

        audioStream.write(buffer);
        totalBytesReceived += buffer.length;

        // Log every ~5MB to show life (less noisy)
        if (Math.floor(totalBytesReceived / (1024 * 1024 * 5)) > Math.floor((totalBytesReceived - buffer.length) / (1024 * 1024 * 5))) {
            log(`🎤 Audio Data Ingested (${Math.round(totalBytesReceived / 1024 / 1024)}MB total)`);
        }
    });

    // Expose IPC dispatcher so browser DOM can send status updates to Manager
    await page.exposeFunction('sendIPC', (type, payload) => {
        sendIPC(type, payload);
    });

    // --- INCREMENTAL TRANSCRIPTION LOOP (Queue Processor) ---
    const incrementalIntervalId = setInterval(async () => {
        if (activeChunks.length === 0 || isTranscribingIncrementally) return;

        isTranscribingIncrementally = true;
        const queue = [...activeChunks];
        activeChunks = []; // Clear current queue to collect new chunks

        log(`📤 [Queue] Processing ${queue.length} chunks...`);

        for (const batchBuffer of queue) {
            chunkBatchCount++;

            // Check for minimum viable size (e.g., ~1KB) to avoid processing tiny/noise chunks
            if (batchBuffer.length < 1000) {
                log(`ℹ️ [Batch #${chunkBatchCount}] Skipped (Small buffer: ${batchBuffer.length} bytes)`);
                continue;
            }

            const chunkPath = path.resolve(RECORDINGS_DIR, `live_chunk_${MEETING_ID}_${Date.now()}.webm`);
            let retryCount = 0;
            const maxRetries = 2;
            let success = false;

            while (retryCount <= maxRetries && !success) {
                try {
                    fs.writeFileSync(chunkPath, batchBuffer);

                    // 2. Send to Local STT Service
                    const formData = new FormData();
                    const blob = new Blob([batchBuffer], { type: 'audio/webm' });
                    formData.append('file', blob, 'chunk.webm');
                    formData.append('meeting_id', MEETING_ID);

                    // Use 127.0.0.1 for more reliable localhost resolution on Windows
                    const sttUrl = 'http://127.0.0.1:4545/transcribe';
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 180000); // Increased from 60s to 180s for slow CPUs

                    const response = await fetch(sttUrl, {
                        method: 'POST',
                        body: formData,
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    if (response.ok) {
                        const result = await response.json();
                        success = true;

                        if (result.transcript && result.transcript.length > 0) {
                            // 3. Shift timestamps and append
                            const shifted = result.transcript.map(s => ({
                                ...s,
                                start_time: s.start_time + globalOffset, // Update for UI (JSON)
                                end_time: s.end_time + globalOffset,     // Update for UI (JSON)
                                start: s.start_time + globalOffset,      // Update for Manager (VTT)
                                end: s.end_time + globalOffset           // Update for Manager (VTT)
                            }));

                            fullSegments.push(...shifted);

                            // Log the update
                            const snippet = shifted.map(s => s.text).join(' ').substring(0, 40);
                            log(`✅ [Batch #${chunkBatchCount}] Transcribed: "${snippet}..." (+${Math.round(result.duration)}s audio)`);

                            // 4. Send Update to Manager (which saves to DB)
                            sendIPC('transcript', { segments: fullSegments });
                        }

                        // Update offset (approximate with decoded duration)
                        globalOffset += result.duration;

                    } else {
                        const errText = await response.text().catch(() => 'No error body');
                        log(`⚠️ STT Server Error (Batch #${chunkBatchCount}): ${response.status} ${errText.substring(0, 100)}`);
                        if (response.status >= 500 && retryCount < maxRetries) {
                            throw new Error(`Server error ${response.status}`);
                        } else {
                            success = true;
                        }
                    }

                } catch (e) {
                    retryCount++;
                    const isTimeout = e.name === 'AbortError';
                    log(`❌ Live Transcription Failed (Batch #${chunkBatchCount}, Attempt ${retryCount}/${maxRetries + 1}): ${isTimeout ? 'Timeout (60s)' : e.message}`);

                    if (retryCount <= maxRetries) {
                        log(`🔄 Retrying Batch #${chunkBatchCount} in 3s...`);
                        await new Promise(r => setTimeout(r, 3000));
                    }
                } finally {
                    try { if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath); } catch (e) { }
                }
            }
        }
        isTranscribingIncrementally = false;
    }, 10000); // Run every 10 seconds

    // Expose a function to track speaker changes
    await page.exposeFunction('sendSpeakerEvent', (name) => {
        log(`🎤 Speaker Change: ${name}`);
        const now = Date.now();
        const startMs = now - recordingAnchorTime;

        // Close previous event if exists
        if (speakerTimeline.length > 0) {
            const last = speakerTimeline[speakerTimeline.length - 1];
            if (!last.endMs) last.endMs = startMs;
        }

        speakerTimeline.push({
            name,
            startMs,
            endMs: null
        });

        sendIPC('speaker-change', { name, timestamp: now });
    });

    // Set viewport explicitly
    await page.setViewport({ width: 1920, height: 1080 });

    // ============ CRITICAL: GRANT PERMISSIONS VIA CDP ============
    // The --use-fake-ui-for-media-stream flag doesn't always work in headless.
    // CDP Browser.grantPermissions is the most reliable way to grant mic/cam.
    try {
        const cdpSession = await page.target().createCDPSession();
        await cdpSession.send('Browser.grantPermissions', {
            permissions: ['audioCapture', 'videoCapture', 'notifications'],
            origin: 'https://teams.microsoft.com'
        });
        await cdpSession.send('Browser.grantPermissions', {
            permissions: ['audioCapture', 'videoCapture', 'notifications'],
            origin: 'https://teams.live.com'
        });
        console.log('✅ CDP permissions granted (audioCapture, videoCapture)');
        await cdpSession.detach();
    } catch (cdpErr) {
        console.log(`⚠️ CDP permission grant failed: ${cdpErr.message}`);
    }

    // Fallback: Also try Puppeteer-level permission override
    const context = browser.defaultBrowserContext();
    const origins = ['https://teams.microsoft.com', 'https://teams.live.com', 'https://v-teams.microsoft.com'];
    for (const origin of origins) {
        try {
            await context.overridePermissions(origin, ['microphone', 'camera', 'notifications', 'clipboard-read']);
        } catch (e) { }
    }

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');

    // ============ HEADLESS AUDIO FIX: MONKEY PATCH WEBRTC ============
    // Chrome Headless 'new' mode often detaches audio from <audio> elements.
    // We must intercept the raw MediaStreamTrack from RTCPeerConnection to get signal.
    await page.evaluateOnNewDocument(() => {
        window.__remoteAudioTracks = [];
        window.__peerConnections = []; // Capture PC instances

        // Hook RTCPeerConnection Constructor
        const origPC = window.RTCPeerConnection;
        window.RTCPeerConnection = function (...args) {
            const pc = new origPC(...args);
            window.__peerConnections.push(pc);
            console.log(`[WEBRTC-HOOK] 🔌 New RTCPeerConnection created. Total: ${window.__peerConnections.length}`);

            // Hook track event
            pc.addEventListener('track', (event) => {
                if (event.track && event.track.kind === 'audio') {
                    console.log(`[WEBRTC-HOOK] 🎤 Captured remote audio track (event): ${event.track.id}`);
                    if (!window.__remoteAudioTracks.some(t => t.id === event.track.id)) {
                        window.__remoteAudioTracks.push(event.track);
                    }
                }
            });

            return pc;
        };
        // Copy prototype chain
        window.RTCPeerConnection.prototype = origPC.prototype;

        // Helper to scan for missed tracks (fallback)
        window.__scanRemoteTracks = () => {
            let newTracks = 0;
            window.__peerConnections.forEach(pc => {
                const receivers = pc.getReceivers();
                receivers.forEach(r => {
                    if (r.track && r.track.kind === 'audio') {
                        if (!window.__remoteAudioTracks.some(t => t.id === r.track.id)) {
                            window.__remoteAudioTracks.push(r.track);
                            console.log(`[WEBRTC-HOOK] 🔍 Found existing audio track: ${r.track.id}`);
                            newTracks++;
                        }
                    }
                });
            });
            return newTracks;
        };
        console.log('[WEBRTC-HOOK] 💉 WebRTC Interception Injected (Constructor + Events).');
    });

    try {
        sendIPC('status', 'NAVIGATING');
        log('🔗 Navigating to meeting URL...');
        // FAST LANDING: Use 'networkidle2' or similar instead of 'domcontentloaded' because Teams telemetry hangs networkidle0.
        await page.goto(MEETING_URL, { waitUntil: 'networkidle2', timeout: 90000 });

        log('⏳ Waiting for core page assets...');
        await new Promise(r => setTimeout(r, 10000)); // Fixed 10s wait for initial React paint

        console.log('⏳ Waiting for page hydration (rendering)...');
        await new Promise(r => setTimeout(r, 5000)); // Give React time to paint

        console.log('✅ Page Loaded & Hydrated.');

        // DEBUG: Take screenshot after hydration
        const debugPath = path.resolve(process.cwd(), 'public', 'debug');
        if (!fs.existsSync(debugPath)) fs.mkdirSync(debugPath, { recursive: true });
        await page.screenshot({ path: path.resolve(debugPath, 'step1-hydrated.png') });
        console.log('📸 Screenshot taken: step1-hydrated.png');

        // --- STEP 1: HANDLE REDIRECT / LAUNCHER ---
        log('🔍 Bypassing Redirects & Popups...');
        // Removed problematic evaluateOnNewDocument

        // Click "Continue on browser"
        let landed = false;
        for (let i = 0; i < 7; i++) {
            const status = await page.evaluate(() => {
                const text = document.body.innerText.toLowerCase();
                if (text.includes("this browser isn't supported") || text.includes("unsupported browser")) return 'BROWSER_BLOCKED';

                const scan = (doc) => {
                    const nameInput = doc.querySelector('input[data-tid="prejoin-display-name-input"]');
                    if (nameInput) return 'ALREADY_LANDED';

                    const btns = Array.from(doc.querySelectorAll('button'));
                    const b = btns.find(b => {
                        const t = (b.innerText || b.textContent || '').toLowerCase();
                        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                        const tid = (b.getAttribute('data-tid') || '').toLowerCase();

                        return t.includes('continue on this browser') ||
                            t.includes('use the web app') ||
                            t.includes('join on the web') ||
                            t === 'continue' ||
                            aria.includes('join on the web') ||
                            tid.includes('join-on-web') ||
                            tid.includes('continue-on-browser');
                    });

                    if (b) { b.click(); return 'CLICKED'; }
                    const iframes = doc.querySelectorAll('iframe');
                    for (const f of iframes) {
                        try { if (f.contentDocument) { const r = scan(f.contentDocument); if (r) return r; } } catch (e) { }
                    }
                    return null;
                };
                return scan(document);
            });

            if (status === 'BROWSER_BLOCKED') {
                log('❌ FATAL: Teams blocked the browser (Unsupported User Agent).');
                await page.screenshot({ path: path.resolve(debugPath, 'browser-blocked.png') });
                throw new Error('BROWSER_UNSUPPORTED');
            }
            if (status === 'ALREADY_LANDED') { landed = true; break; }
            if (status === 'CLICKED') {
                landed = true;
                log('✅ Clicked "Continue on browser"');
                await new Promise(r => setTimeout(r, 10000));
                break;
            }
            log(`ℹ️ Landing button not found yet (Attempt ${i + 1}/7)...`);
            await new Promise(r => setTimeout(r, 4000));
        }


        // --- STEP 2: WAIT FOR PRE-JOIN UI ---
        sendIPC('status', 'PRE_JOIN');
        log('⌛ Waiting for Pre-Join UI (Nuclear Wait)...');
        let uiReady = false;
        const uiStart = Date.now();
        while (Date.now() - uiStart < 90000) {
            try {
                // MODAL BUSTER: Click past any "Allow" or informational overlays
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button'));
                    const modalBtn = btns.find(b => {
                        const txt = (b.innerText || '').toLowerCase();
                        return txt.includes('allow') ||
                            txt.includes('dismiss') ||
                            txt.includes('got it') ||
                            txt.includes('ok') ||
                            txt.includes('continue without audio');
                    });
                    if (modalBtn) modalBtn.click();
                });

                uiReady = await page.evaluate(() => {
                    const check = (doc) => {
                        if (doc.querySelector('input[data-tid="prejoin-display-name-input"], input[placeholder*="name" i], input[id*="username"], input[name*="username"]')) return true;
                        // If we see the join button already, then UI is "ready" (maybe name skipped)
                        const btns = Array.from(doc.querySelectorAll('button'));
                        if (btns.some(b => b.innerText.toLowerCase().includes('join now'))) return true;

                        const iframes = doc.querySelectorAll('iframe');
                        for (const f of iframes) {
                            try { if (f.contentDocument && check(f.contentDocument)) return true; } catch (e) { }
                        }
                        return false;
                    };
                    return check(document);
                });
            } catch (e) { }
            if (uiReady) break;
            await new Promise(r => setTimeout(r, 3000));
        }
        log(uiReady ? '✅ Pre-Join UI Ready.' : '⚠️ Pre-Join UI Timeout (Continuing anyway)');

        // --- STEP 2.2: ENTER NAME (DEEP RECURSION) ---
        log('✍️ Setting bot name (Deep Recursive strategy)...');
        try {
            const nameEntered = await page.evaluate(() => {
                const scanAndType = (doc) => {
                    if (!doc) return false;
                    const inputs = Array.from(doc.querySelectorAll('input[type="text"], input[data-tid*="name"], input[placeholder*="name" i]'));
                    const target = inputs.find(el => {
                        const rect = el.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    });

                    if (target) {
                        try {
                            target.focus();
                            target.click();
                            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                            if (setter) {
                                setter.call(target, 'MeetingAI Bot');
                                target.dispatchEvent(new Event('input', { bubbles: true }));
                                target.dispatchEvent(new Event('change', { bubbles: true }));
                                target.dispatchEvent(new Event('blur', { bubbles: true }));
                            } else {
                                target.value = 'MeetingAI Bot';
                            }
                            return target.value === 'MeetingAI Bot';
                        } catch (e) { return false; }
                    }

                    const iframes = doc.querySelectorAll('iframe');
                    for (const f of iframes) {
                        try { if (f.contentDocument && scanAndType(f.contentDocument)) return true; } catch (e) { }
                    }
                    return false;
                };
                return scanAndType(document);
            });

            if (nameEntered) {
                log('✅ Name set successfully across frames');
            } else {
                log('⚠️ Automated name entry failed, UI might be pre-filled or blocked.');
            }
            // Diagnostic: screenshot after name entry attempt
            try {
                await new Promise(r => setTimeout(r, 500));
                await page.screenshot({ path: path.resolve(debugPath, 'after-name-entry.png') });
            } catch (e) { }
        } catch (e) {
            log('⚠️ Name entry error: ' + e.message);
        }

        // --- STEP 2.5: FORCE DISABLE CAMERA AND MIC (DEEP RECURSION) ---
        log('🔇 Ensuring Camera and Mic are OFF (Deep Recursive)...');
        try {
            await page.evaluate(() => {
                const scanAndMute = (doc) => {
                    if (!doc) return;
                    const buttons = Array.from(doc.querySelectorAll('button'));

                    const muteDevice = (keywords) => {
                        const btn = buttons.find(b => {
                            const label = (b.ariaLabel || '').toLowerCase();
                            const text = (b.innerText || '').toLowerCase();
                            return keywords.some(k => label.includes(k) || text.includes(k));
                        });

                        if (btn) {
                            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                            const text = (btn.innerText || '').toLowerCase();
                            const pressed = btn.getAttribute('aria-pressed');

                            // It's already OFF/MUTED if:
                            // 1. Label says "Unmute" or "Turn on"
                            // 2. aria-pressed is true (standard for toggle buttons in ON state, but Teams uses it for "Mute is Active")
                            // 3. Label explicitly says "off" (e.g. "Camera is off")
                            const isOff = label.includes('unmute') ||
                                label.includes('turn on') ||
                                (label.includes('camera') && label.includes('off')) ||
                                pressed === 'true';

                            if (!isOff) {
                                btn.click();
                                console.log(`[MUTE] Clicked to disable: ${label || text}`);
                            }
                        }
                    };

                    muteDevice(['camera', 'video']);
                    muteDevice(['microphone', 'mic', 'mute']);

                    const iframes = doc.querySelectorAll('iframe');
                    for (const f of iframes) {
                        try { if (f.contentDocument) scanAndMute(f.contentDocument); } catch (e) { }
                    }
                };
                scanAndMute(document);
            });
            await new Promise(r => setTimeout(r, 1500));
        } catch (e) {
            log('⚠️ Pre-join mute failed: ' + e.message);
        }

        // --- STEP 3: NUCLEAR JOIN BUTTON ---
        sendIPC('status', 'JOINING');
        log('👆 Attempting to Join meeting (Nuclear loop)...');
        let joined = false;
        const joinStart = Date.now();
        while (Date.now() - joinStart < 60000) {
            try {
                joined = await page.evaluate(() => {
                    const scan = (doc) => {
                        const btns = Array.from(doc.querySelectorAll('button'));
                        const j = btns.find(b => {
                            const t = (b.innerText || '').toLowerCase();
                            const lid = (b.getAttribute('data-tid') || '').toLowerCase();
                            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                            return t.includes('join now') ||
                                t === 'join' ||
                                t === 'join meeting' ||
                                lid.includes('prejoin-join') ||
                                lid.includes('join-button') ||
                                aria.includes('join now') ||
                                aria === 'join';
                        });
                        if (j) {
                            j.focus();
                            j.click();
                            return true;
                        }
                        const iframes = doc.querySelectorAll('iframe');
                        for (const f of iframes) {
                            try { if (f.contentDocument && scan(f.contentDocument)) return true; } catch (e) { }
                        }
                        return false;
                    };
                    return scan(document);
                });
            } catch (e) {
                // Ignore navigation errors during join attempt
            }
            if (joined) break;
            await new Promise(r => setTimeout(r, 2000));
        }

        if (!joined) {
            log('❌ FATAL: JOIN_BUTTON_NOT_FOUND after 60s of active scanning.');
            await page.screenshot({ path: path.resolve(debugPath, 'join-button-missing.png') });
            sendIPC('status', 'FAILED');
            throw new Error('JOIN_BUTTON_NOT_FOUND');
        }
        log('🎯 Join button clicked.');

        // --- STEP 3.5: HANDLE AUDIO SELECTION MODAL (SMART POLLING) ---
        console.log('🔍 Checking for audio selection modal (Polling up to 15s)...');
        let modalHandled = false;
        try {
            for (let m = 0; m < 15; m++) {

                modalHandled = await page.evaluate(() => {
                    const scanAndFinalize = (doc) => {
                        if (!doc) return false;

                        const buttons = Array.from(doc.querySelectorAll('button'));

                        // 1. Explicitly select "Computer audio" if the option is shown
                        const labels = Array.from(doc.querySelectorAll('label, div, span, p'));
                        const caLabel = labels.find(el => {
                            const txt = (el.textContent || '').trim().toLowerCase();
                            return txt === 'computer audio' || txt === 'use computer audio' || txt.includes('computer-audio');
                        });
                        if (caLabel) {
                            caLabel.click();
                            console.log('[AUDIO] Selected Computer Audio option');
                        }

                        // 2. Click "Join now" if it appears again on a second screen
                        const finalJoin = buttons.find(b => {
                            const txt = b.innerText.trim().toLowerCase();
                            const tid = b.getAttribute('data-tid') || '';
                            return txt === 'join now' || txt === 'join' || tid === 'prejoin-join-button' || tid.includes('final-join');
                        });
                        if (finalJoin) {
                            finalJoin.click();
                            console.log('[AUDIO] Clicked final Join Now');
                            return true;
                        }

                        // 3. Muting "Continue without audio" modal if it appears
                        const blockingBtn = buttons.find(b => {
                            const txt = b.innerText.toLowerCase();
                            return txt.includes('continue without audio') || txt.includes('join without audio');
                        });
                        if (blockingBtn) {
                            blockingBtn.click();
                            console.log('[AUDIO] Bypassed blocking audio modal');
                            return true;
                        }

                        const iframes = doc.querySelectorAll('iframe');
                        for (const f of iframes) {
                            try { if (f.contentDocument && scanAndFinalize(f.contentDocument)) return true; } catch (e) { }
                        }
                        return false;
                    };
                    return scanAndFinalize(document);
                });
                if (modalHandled) {
                    log('✅ Audio selection modal handled.');
                    break;
                }
                await new Promise(r => setTimeout(r, 1000));
            }
            await new Promise(r => setTimeout(r, 3000));
        } catch (e) {
            log('⚠️ Post-join finalization warning: ' + e.message);
        }

        // --- STEP 4: ROOM HANDLER (FINAL ENTRANCE) ---
        log('🕒 Final entrance check...');
        try {
            await page.evaluate(() => {
                const scanFinalJoin = (doc) => {
                    if (!doc) return false;
                    const buttons = Array.from(doc.querySelectorAll('button'));
                    const btn = buttons.find(b => {
                        const txt = b.innerText.toLowerCase();
                        return txt === 'join now' || txt.includes('join meeting');
                    });
                    if (btn) { btn.click(); return true; }

                    const iframes = doc.querySelectorAll('iframe');
                    for (const f of iframes) {
                        try { if (f.contentDocument && scanFinalJoin(f.contentDocument)) return true; } catch (e) { }
                    }
                    return false;
                };
                scanFinalJoin(document);
            });
        } catch (e) { }

        log('🏁 Bot should be in meeting now.');

        // --- STEP 5: START LISTEN MODE ---
        log('🎤 Starting LISTEN MODE immediately...');
        sessionRecordingStartTime = Date.now();
        recordingAnchorTime = sessionRecordingStartTime;
        sendIPC('recording-start', { timestamp: sessionRecordingStartTime });

        try {
            await page.evaluate(async () => {
                if (window.__earInitialized) {
                    console.log('[EAR] Already initialized. Resuming context if needed...');
                    if (window.__earAudioContext && window.__earAudioContext.state === 'suspended') {
                        window.__earAudioContext.resume();
                    }
                    return;
                }
                window.__earInitialized = true;

                console.log('[EAR] Initializing Virtual Ear (Aggressive Mode)...');
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const mixer = ctx.createGain();
                const dest = ctx.createMediaStreamDestination();
                mixer.connect(dest);

                window.__earAudioContext = ctx;
                window.__earMixer = mixer;

                // Ensure AudioContext is running (headless fix)
                if (ctx.state === 'suspended') {
                    await ctx.resume();
                    console.log('[EAR] Resumed AudioContext from suspended state.');
                }

                const analyser = ctx.createAnalyser();
                mixer.connect(analyser);
                analyser.fftSize = 256;
                const dataArray = new Uint8Array(analyser.frequencyBinCount);

                // Intercept ALL media play events - REMOVED (WebRTC Intercept Strategy)
                // const originalPlay = HTMLMediaElement.prototype.play;
                // HTMLMediaElement.prototype.play = function () {
                //     this.muted = false;
                //     this.volume = 1.0;
                //     return originalPlay.apply(this, arguments);
                // };

                const captureAudio = () => {
                    // HEADLESS FIX: Consume intercepted WebRTC tracks
                    // 1. Force a scan of known PCs to catch missed tracks
                    if (window.__scanRemoteTracks) window.__scanRemoteTracks();

                    const tracks = window.__remoteAudioTracks || [];
                    let found = 0;

                    tracks.forEach(track => {
                        if (track.kind === 'audio' && !track.dataset_captured) {
                            try {
                                track.dataset_captured = true;
                                // Create a stream from the track
                                const stream = new MediaStream([track]);

                                // Debug: Log track status
                                console.log(`[EAR] 🎯 Processing WebRTC Track: ${track.id} (ReadyState: ${track.readyState})`);

                                // Monitor track mute/unmute
                                track.onmute = () => console.log(`[EAR] 🔇 Track ${track.id} MUTED`);
                                track.onunmute = () => console.log(`[EAR] 🔊 Track ${track.id} UNMUTED`);

                                const source = ctx.createMediaStreamSource(stream);
                                source.connect(mixer);

                                // Debug: Analyser for this specific track
                                const trackAnalyser = ctx.createAnalyser();
                                trackAnalyser.fftSize = 256;
                                source.connect(trackAnalyser);
                                const trackData = new Uint8Array(trackAnalyser.frequencyBinCount);

                                // Poll this track for signal (briefly)
                                setTimeout(() => {
                                    trackAnalyser.getByteFrequencyData(trackData);
                                    const sum = trackData.reduce((a, b) => a + b, 0);
                                    const avg = sum / trackData.length;
                                    console.log(`[EAR] 📊 Track ${track.id} Initial Signal Avg: ${avg.toFixed(2)}`);
                                }, 2000);

                                found++;
                                console.log(`[EAR] ✅ Hooked WebRTC Audio Track: ${track.id}`);
                            } catch (err) {
                                console.warn(`[EAR] Hook failed for track ${track.id}:`, err.message);
                            }
                        }
                    });

                    if (found > 0) console.log(`[EAR] Synced ${found} new remote audio tracks.`);
                };

                let silenceCount = 0;
                setInterval(() => {
                    analyser.getByteFrequencyData(dataArray);
                    let sum = 0;
                    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                    const avg = sum / dataArray.length;

                    if (avg > 0.5) { // Lower threshold slightly
                        silenceCount = 0;
                        if (Math.random() > 0.95) console.log(`[EAR] 🎵 Mixer Signal: Vol=${Math.round(avg)}`);
                    } else {
                        silenceCount++;
                        if (silenceCount % 12 === 0) {
                            console.log('[EAR] 🔇 WARNING: Absolute silence in mixer (headless behavior?)');
                            if (ctx.state === 'suspended') ctx.resume();
                            // Trigger re-scan of tracks
                            captureAudio();
                        }
                    }
                }, 5000);

                setInterval(captureAudio, 10000); // Check every 10s
                captureAudio(); // Initial check

                // FALLBACK: Capture any <audio> elements in the DOM
                const captureDOMElements = () => {
                    const audios = document.querySelectorAll('audio');
                    audios.forEach(a => {
                        if (!a.dataset_captured && a.srcObject) { // ONLY if it has a stream
                            try {
                                const source = ctx.createMediaStreamSource(a.srcObject);
                                source.connect(mixer);
                                a.dataset_captured = "true";
                                console.log('[EAR] 🔗 Captured DOM <audio> element stream');
                            } catch (e) { }
                        }
                    });
                };
                setInterval(captureDOMElements, 5000);

                const stream = dest.stream;
                const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
                const mediaRecorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });

                mediaRecorder.ondataavailable = async (e) => {
                    if (e.data && e.data.size > 0) {
                        const reader = new FileReader();
                        reader.onload = () => window.sendAudioChunk(reader.result.split(',')[1]);
                        reader.readAsDataURL(e.data);
                    }
                };

                // NEW: Stop & Start Strategy for perfect standalone chunks
                setInterval(() => {
                    try {
                        if (mediaRecorder.state === 'recording') {
                            mediaRecorder.stop();
                            mediaRecorder.start();
                            // console.log('[EAR] Rotated recording for clean chunking.');
                        }
                    } catch (e) {
                        console.error('[EAR] Rotation failed:', e.message);
                    }
                }, 30000); // Rotate every 30s for perfect Whisper alignment

                try {
                    if (mediaRecorder.state !== 'recording') {
                        mediaRecorder.start();
                        console.log('[EAR] MediaRecorder started clean.');
                        if (window.sendIPC) window.sendIPC('recording-start', { timestamp: Date.now() });
                    }
                } catch (e) {
                    console.error('[EAR] Initial start error:', e.message);
                }
                // --- DIARIZATION: SPEAKER SCRAPER ---
                window.__speakerTimeline = [];
                const sessionStartTs = Date.now();

                const scanSpeakers = () => {
                    const nowMs = Date.now() - sessionStartTs;
                    let activeSpeakerName = null;

                    // Method 1: Check Aria-Labels (Most robust for accessibility compliance)
                    // Teams often uses "Name, Speaking" or "Name is speaking"
                    const speakingEls = document.querySelectorAll('[aria-label*="speaking" i], [aria-label*="Speaking" i]');
                    if (speakingEls.length > 0) {
                        // Get the text, remove "Speaking", trim
                        const raw = speakingEls[0].getAttribute('aria-label') || '';
                        activeSpeakerName = raw.replace(/,?\s*is speaking.*/i, '').replace(/,?\s*speaking.*/i, '').trim();
                    }

                    if (activeSpeakerName) {
                        // Send to Node process
                        if (window.sendSpeakerEvent) window.sendSpeakerEvent(activeSpeakerName, nowMs);
                    }

                    // Method 2: Check standard avatar rings (backup)
                    if (!activeSpeakerName) {
                        const avatarRing = document.querySelector('.ui-avatar--speaking, .ui-list__item--speaking');
                        if (avatarRing) {
                            const parent = avatarRing.closest('[role="listitem"]') || avatarRing.parentElement;
                            activeSpeakerName = parent ? (parent.innerText || '').split('\n')[0].trim() : 'Active Speaker';
                        }
                    }

                    // Push to timeline if changed
                    if (activeSpeakerName && activeSpeakerName !== 'You' && activeSpeakerName !== 'Meeting Participant') {
                        const last = window.__speakerTimeline[window.__speakerTimeline.length - 1];
                        if (!last || last.name !== activeSpeakerName) {
                            // Close previous
                            if (last) last.endMs = nowMs;
                            // Open new
                            window.__speakerTimeline.push({
                                name: activeSpeakerName,
                                startMs: nowMs,
                                timestamp: Date.now()
                            });
                            console.log(`[EAR] 🗣️ Speaker detected: ${activeSpeakerName}`);
                        } else {
                            // Extend current
                            last.endMs = nowMs + 1000; // Keep alive
                        }
                    }
                };
                setInterval(scanSpeakers, 500); // Check every 500ms

                // Start call REMOVED (handled above with robust checks)
                // mediaRecorder.start(5000); 

                window.meetingMediaRecorder = mediaRecorder;
                console.log(`[EAR] Live Stream Active (${mimeType}) - Recorder assigned to window.`);
            });
        } catch (e) {
            log('❌ Virtual Ear Init Error (Non-Fatal): ' + e.message);
        }

        await new Promise(r => setTimeout(r, 3000));


        // --- STEP 6: STATE CONFIRMATION (LOBBY vs IN_MEETING vs TIMEOUT) ---
        console.log('🔍 Confirming join state...');
        await new Promise(r => setTimeout(r, 5000)); // Allow UI transition

        // Priority 1: Check for LOBBY (this is SUCCESS, not failure)
        const checkLobby = async () => {
            try {
                return await page.evaluate(() => {
                    const text = document.body.innerText;
                    return text.includes("let people know you're waiting") ||
                        text.includes('waiting to be admitted') ||
                        text.includes('Someone will let you in shortly') ||
                        text.includes('Please wait for the host');
                });
            } catch (e) {
                return false;
            }
        };

        // Priority 2: Check for IN_MEETING (call toolbar visible)
        const checkInMeeting = async () => {
            try {
                return await page.evaluate(() => {
                    const hangup = document.querySelector('button[data-tid="call-hangup"]') ||
                        document.querySelector('button[data-tid="hangup-button"]');
                    const leaveBtn = Array.from(document.querySelectorAll('button')).some(b => {
                        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                        const txt = (b.innerText || '').toLowerCase();
                        return aria.includes('leave') || aria.includes('hang up') || txt.includes('leave');
                    });
                    const toolbar = document.querySelector('[data-tid="calling-roster"]') ||
                        document.querySelector('.meeting-action-bar') ||
                        document.querySelector('[aria-label="Meeting controls"]') ||
                        document.querySelector('[data-tid="calling-header"]');
                    return !!(hangup || leaveBtn || toolbar);
                });
            } catch (e) {
                return false;
            }
        };

        // State detection loop (120s timeout)
        let finalState = 'UNKNOWN';
        const startTime = Date.now();
        const maxWait = 120000; // 120 seconds
        let checkCount = 0;
        let lastScreenshotTime = 0;

        try {
            while (Date.now() - startTime < maxWait) {
                checkCount++;
                console.log(`🔍 State check #${checkCount}...`);

                // DIAGNOSTIC: Save screenshot periodically
                const now = Date.now();
                if (now - lastScreenshotTime > 15000) { // Every 15s (was 5s — too aggressive)
                    try {
                        const screenshotName = `state-check-${checkCount}.png`;
                        await page.screenshot({ path: path.resolve(debugPath, screenshotName) });
                        console.log(`📸 Diagnostic screenshot: ${screenshotName}`);
                        lastScreenshotTime = now;

                        // NEW: Dump page text for debugging without image
                        const pageText = await page.evaluate(() => {
                            const getText = (doc) => {
                                let txt = doc.body.innerText.substring(0, 500); // First 500 chars
                                const frames = doc.querySelectorAll('iframe');
                                frames.forEach(f => {
                                    try { if (f.contentDocument) txt += '\n[FRAME] ' + getText(f.contentDocument); } catch (e) { }
                                });
                                return txt;
                            };
                            return getText(document);
                        });
                        console.log('📄 Page Content Snapshot:\n' + pageText.substring(0, 1000) + '...');
                    } catch (screenshotErr) {
                        console.log(`⚠️ Screenshot failed: ${screenshotErr.message}`);
                    }
                }

                try {
                    const inLobby = await checkLobby();
                    const inMeeting = await checkInMeeting();

                    // MODAL BUSTER: Clear blocking modals
                    // Handle the "Are you sure" modal if it reappears
                    // MODAL BUSTER: Clear blocking modals (RECURSIVE)
                    await page.evaluate(() => {
                        const scanner = (doc) => {
                            if (!doc || !doc.body) return;
                            const buttons = Array.from(doc.querySelectorAll('button'));

                            // First priority: dismiss the blocking permission modal
                            const continueBtn = buttons.find(b =>
                                b.innerText.toLowerCase().includes('continue without audio or video') ||
                                b.innerText.toLowerCase().includes('use the web app'));
                            if (continueBtn) {
                                continueBtn.click();
                                console.log('[MODAL] Clicked Continue without audio/web app (unblocking)');
                                return;
                            }

                            // Second priority: dismiss non-destructive modals
                            const busterBtn = buttons.find(b => {
                                const txt = b.innerText.toLowerCase();
                                return txt.includes('dismiss') ||
                                    txt.includes('got it') ||
                                    txt.includes('close') ||
                                    txt.includes('not now');
                            });
                            if (busterBtn) {
                                busterBtn.click();
                                console.log(`[MODAL] Dismissed popup: ${busterBtn.innerText}`);
                            }

                            // If audio modal reappears (e.g. after lobby admission),
                            // ensure "Computer audio" is selected and click "Join now"
                            const bodyText = doc.body.innerText;
                            const isWaitingInLobby = bodyText.includes("waiting to be admitted") ||
                                bodyText.includes("Someone will let you in shortly");

                            if (!isWaitingInLobby && (bodyText.includes('Computer audio') || bodyText.includes('Don\'t use audio'))) {
                                // Select Computer audio
                                const labels = Array.from(doc.querySelectorAll('label, div, span'));
                                const caLabel = labels.find(el => el.textContent?.trim().toLowerCase() === 'computer audio');
                                if (caLabel) caLabel.click();

                                // Click Join now on the audio modal
                                const joinBtn = buttons.find(b => {
                                    const txt = b.innerText.trim().toLowerCase();
                                    return txt === 'join now' || txt === 'join meeting';
                                });
                                if (joinBtn) {
                                    joinBtn.click();
                                    console.log('[MODAL] Re-clicked Join now with Computer audio');
                                }
                            }

                            // FORCE JOIN RETRY: If we see "Join now" but no "Waiting...", click it!
                            // This covers cases where we fell out of lobby or didn't click correctly
                            const mainJoin = buttons.find(b => {
                                const txt = b.innerText.trim().toLowerCase();
                                return txt === 'join now' || txt === 'join meeting';
                            });
                            if (mainJoin) {
                                // Only click if we are NOT in a "Connecting..." state? 
                                // Actually, if "Join now" is visible and enabled, we should probably click it.
                                // But prevent double-clicking if we just clicked.
                                // We rely on the loop speed (2s).
                                // console.log('[MODAL] Found Join text, ensuring we click it...');
                                // mainJoin.click(); 
                                // CAUTION: This might loop. Let's rely on the explicit checkLobby/checkInMeeting
                            }

                            // Recurse into iframes
                            const frames = doc.querySelectorAll('iframe');
                            frames.forEach(f => {
                                try { if (f.contentDocument) scanner(f.contentDocument); } catch (e) { }
                            });
                        };
                        scanner(document);
                    });

                    if (inLobby) {
                        if (finalState !== 'IN_LOBBY') {
                            console.log('✅ Lobby detected! Waiting for admission...');
                            sendIPC('status', 'IN_LOBBY'); // Report immediately to UI
                        }
                        finalState = 'IN_LOBBY';

                        // Extend wait loop if we are sitting in lobby
                        if (Date.now() - startTime > 100000) {
                            console.log('⏳ Still in lobby... extending wait timeout.');
                            startTime = Date.now(); // Reset timeout clock
                        }
                    }
                    if (inMeeting) {
                        console.log('✅ Meeting UI detected!');
                        finalState = 'IN_MEETING';
                        break;
                    }
                } catch (checkErr) {
                    console.log(`⚠️ Check error: ${checkErr.message}`);
                    // Continue checking despite errors
                }

                await new Promise(r => setTimeout(r, 2000)); // Check every 2s

                // STUCK DETECTION: If still on pre-join page, retry name + join
                if (checkCount > 5 && checkCount % 10 === 0) {
                    try {
                        const stillOnPreJoin = await page.evaluate(() => {
                            return document.body.innerText.includes('Type your name') ||
                                document.body.innerText.includes('Enter the name') ||
                                (document.querySelector('input[type="text"]') && document.body.innerText.includes('Join now'));
                        });
                        if (stillOnPreJoin) {
                            console.log('⚠️ STILL ON PRE-JOIN PAGE — retrying name entry + join...');
                            // Re-enter name
                            await page.evaluate(() => {
                                const inputs = Array.from(document.querySelectorAll('input[type="text"], input[data-tid*="name"], input[placeholder*="name" i]'));
                                for (const input of inputs) {
                                    const rect = input.getBoundingClientRect();
                                    if (rect.width > 0 && rect.height > 0) {
                                        input.focus();
                                        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                                        if (setter) {
                                            setter.call(input, 'MeetingAI Bot');
                                            input.dispatchEvent(new Event('input', { bubbles: true }));
                                            input.dispatchEvent(new Event('change', { bubbles: true }));
                                        }
                                    }
                                }
                            });
                            await new Promise(r => setTimeout(r, 1000));
                            // Click Join now
                            await page.evaluate(() => {
                                const buttons = Array.from(document.querySelectorAll('button'));
                                const joinBtn = buttons.find(b => {
                                    const txt = b.innerText.trim().toLowerCase();
                                    return txt === 'join now' || txt === 'join meeting';
                                });
                                if (joinBtn) {
                                    joinBtn.click();
                                    console.log('[RETRY] Re-clicked Join now after name re-entry');
                                }
                            });
                            await new Promise(r => setTimeout(r, 3000));
                        }
                    } catch (e) { }
                }
            }
        } catch (loopErr) {
            console.error('❌ State detection loop crashed:', loopErr.message);
        }

        console.log(`🔍 Final state after ${checkCount} checks: ${finalState}`);

        // Report final state (HONEST REPORTING - NO LIES)
        if (finalState === 'IN_LOBBY') {
            sendIPC('status', 'IN_LOBBY');
            console.log('🟡 Bot is in the LOBBY (waiting for host admission)');
            console.log('✅ This is a SUCCESS state - bot joined successfully');
        } else if (finalState === 'IN_MEETING') {
            sendIPC('status', 'IN_MEETING');
            console.log('🟢 Bot confirmed IN MEETING (call toolbar detected)');
        } else {
            // Timeout - honest reporting but KEEP ALIVE for manual verification
            sendIPC('status', 'JOIN_TIMEOUT_NO_MEDIA');
            console.log('❌ JOIN TIMEOUT: No lobby or meeting UI detected after 120s');
            console.log('⚠️ Likely cause: UI selector mismatch or authentication required');
            console.log('🔍 CHECK SCREENSHOTS in public/debug/ for visual proof');
            try {
                await page.screenshot({ path: path.resolve(debugPath, 'join-timeout-final.png') });
            } catch (e) { }
        }

        // --- STEP 5: FALLBACK VIRTUAL EAR INIT ---
        // If audio modal path didn't initialize the ear (auto-join, no modal, failed click),
        // start it now that we've confirmed we're in the meeting.
        if (finalState === 'IN_MEETING' || finalState === 'IN_LOBBY') {
            try {
                const hasEar = await page.evaluate(() => !!window.meetingMediaRecorder);
                if (!hasEar) {
                    console.log('🔊 FALLBACK: Virtual Ear not running — starting now...');
                    sessionRecordingStartTime = Date.now();
                    recordingAnchorTime = sessionRecordingStartTime;
                    sendIPC('recording-start', { timestamp: sessionRecordingStartTime });

                    await page.evaluate(async () => {
                        console.log('[EAR-FALLBACK] Initializing Virtual Ear...');
                        const ctx = new (window.AudioContext || window.webkitAudioContext)();
                        const mixer = ctx.createGain();
                        const dest = ctx.createMediaStreamDestination();
                        mixer.connect(dest);

                        // Store as globals for re-hook access from heartbeat
                        window.__earAudioContext = ctx;
                        window.__earMixer = mixer;

                        const analyser = ctx.createAnalyser();
                        mixer.connect(analyser);

                        const captureAudio = () => {
                            const getAllElements = (doc) => {
                                let els = [...doc.querySelectorAll('audio'), ...doc.querySelectorAll('video'), ...doc.querySelectorAll('[data-tid*="participant-audio"]')];
                                doc.querySelectorAll('iframe').forEach(iframe => {
                                    try { if (iframe.contentDocument) els = [...els, ...getAllElements(iframe.contentDocument)]; } catch (e) { }
                                });
                                return els;
                            };
                            const elements = getAllElements(document);
                            let found = 0;
                            elements.forEach(el => {
                                const stream = el.srcObject || (el.captureStream ? el.captureStream() : null);
                                if (stream && stream.getAudioTracks().length > 0 && !el.dataset.captured) {
                                    try {
                                        el.dataset.captured = 'true';
                                        el.muted = false;
                                        el.volume = 1.0;
                                        // Force playback
                                        if (el.paused) el.play().catch(e => { });

                                        const source = ctx.createMediaStreamSource(stream);
                                        try {
                                            source.connect(mixer);
                                            found++;
                                            console.log(`[EAR-FB] Hooked stream: ${stream.id} (paused=${el.paused})`);
                                        } catch (connErr) { }
                                    } catch (err) { }
                                }
                            });
                            if (found > 0) console.log(`[EAR-FB] Active streams: ${found}`);
                        };

                        analyser.fftSize = 256;
                        const dataArray = new Uint8Array(analyser.frequencyBinCount);
                        let silenceCheckCount = 0;
                        setInterval(() => {
                            analyser.getByteFrequencyData(dataArray);
                            let sum = 0;
                            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                            const avg = sum / dataArray.length;
                            if (avg > 0) {
                                silenceCheckCount = 0;
                                console.log(`[EAR-FB] Volume: ${Math.round(avg)} (GENUINE AUDIO)`);
                            } else {
                                silenceCheckCount++;
                                if (silenceCheckCount % 12 === 0) {
                                    console.log('[EAR-FB] 🔇 Silence detected in fallback ear');
                                }
                            }
                        }, 5000);

                        if (ctx.state === 'suspended') { await ctx.resume(); }

                        setInterval(captureAudio, 5000);
                        captureAudio();

                        const stream = dest.stream;
                        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
                        const mediaRecorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
                        mediaRecorder.ondataavailable = async (e) => {
                            if (e.data && e.data.size > 0) {
                                const reader = new FileReader();
                                reader.onload = () => window.sendAudioChunk(reader.result.split(',')[1]);
                                reader.readAsDataURL(e.data);
                            }
                        };

                        // NEW: Stop & Start Strategy for perfect standalone chunks
                        setInterval(() => {
                            try {
                                if (mediaRecorder.state === 'recording') {
                                    mediaRecorder.stop();
                                    mediaRecorder.start();
                                }
                            } catch (e) {
                                console.error('[EAR-FB] Rotation failed:', e.message);
                            }
                        }, 30000); // Rotate every 30s

                        mediaRecorder.start();
                        window.meetingMediaRecorder = mediaRecorder;
                        console.log(`[EAR-FB] MediaRecorder active (${mimeType}) with 30s rotation`);
                        if (window.sendIPC) window.sendIPC('recording-start', { timestamp: Date.now() });
                    });

                    await new Promise(r => setTimeout(r, 3000));
                    console.log('✅ Fallback Virtual Ear initialized');
                } else {
                    console.log('✅ Virtual Ear already running (started via audio modal path)');
                }
            } catch (e) {
                console.log('⚠️ Fallback ear init error: ' + e.message);
            }
        }

        // --- STEP 6: KEEP ALIVE + SMART END DETECTION + SPEAKER TRACKING ---
        console.log('⏳ Bot active (Smart End Detection + Speaker Tracking enabled)...');

        let lastTranscriptionSize = 0;
        let meetingEnded = false;
        let lastDetectedSpeaker = null;


        // Find the recording anchor (when ear started)
        recordingAnchorTime = sessionRecordingStartTime || Date.now();
        console.log(`⏱️ Speaker Anchor: ${new Date(recordingAnchorTime).toISOString()}`);

        // Inject a fast speaker poller into the page (runs every 2s inside browser)
        try {
            await page.evaluate((anchorTime) => {
                window.__speakerTimeline = [];
                window.__lastSpeaker = null;
                window.__speakerAnchor = anchorTime;

                const detectSpeaker = () => {
                    try {
                        let speaker = null;

                        const scanDocument = (doc) => {
                            if (speaker) return; // Found already

                            // Strategy 1: Active speaker border/ring (modern Teams)
                            const videoTiles = doc.querySelectorAll('[data-tid*="video-tile"], [data-cid*="calling-participant"], .ts-calling-screen [role="listitem"]');
                            for (const tile of videoTiles) {
                                try {
                                    const style = window.getComputedStyle(tile);
                                    const hasSpeakingBorder = style.borderColor && style.borderColor !== 'rgb(0, 0, 0)' && style.borderWidth && parseInt(style.borderWidth) > 2;
                                    const hasSpeakingClass = tile.className && (tile.className.includes('speaking') || tile.className.includes('active-speaker'));
                                    const hasSpeakingAttr = tile.getAttribute('data-tid')?.includes('active') || tile.getAttribute('aria-label')?.toLowerCase().includes('speaking');

                                    if (hasSpeakingBorder || hasSpeakingClass || hasSpeakingAttr) {
                                        const nameEl = tile.querySelector('[data-tid*="participant-name"], [data-tid*="display-name"], .ui-chat__message__author, span[class*="displayName"]');
                                        if (nameEl) {
                                            speaker = nameEl.textContent.trim();
                                        } else {
                                            const label = tile.getAttribute('aria-label') || '';
                                            const parts = label.split(',');
                                            if (parts[0] && parts[0].trim().length > 1) speaker = parts[0].trim();
                                        }
                                        if (speaker) return;
                                    }
                                } catch (e) { }
                            }

                            // Strategy 2: "is speaking" aria-label
                            if (!speaker) {
                                const speakingEls = doc.querySelectorAll('[aria-label*="is speaking" i], [aria-label*="is talking" i], [data-tid*="active-speaker"]');
                                for (const el of speakingEls) {
                                    const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
                                    const match = label.match(/^(.+?)\s+(is speaking|is talking)/i);
                                    if (match) { speaker = match[1].trim(); return; }
                                    // Sometimes labels are just "Name" but have an active icon
                                    if (el.getAttribute('data-tid')?.includes('active')) {
                                        speaker = label.split('\n')[0].trim();
                                        if (speaker) return;
                                    }
                                }
                            }

                            // Strategy 3: Roster panel speaking indicator
                            if (!speaker) {
                                const rosterItems = doc.querySelectorAll('[data-tid*="roster"] li, [data-tid*="participant-list"] [role="listitem"], [data-tid*="roster-participant"]');
                                for (const item of rosterItems) {
                                    const speakingIcon = item.querySelector('[data-tid*="speaking"], [class*="speaking"], svg[class*="Voice"]');
                                    if (speakingIcon) {
                                        const nameEl = item.querySelector('[data-tid*="participant-name"], span');
                                        if (nameEl) { speaker = nameEl.textContent.trim().split('\n')[0]; return; }
                                    }
                                }
                            }

                            // Strategy 4: Meeting stage highlight
                            if (!speaker) {
                                const highlighted = doc.querySelector('[data-tid*="video-stream"][class*="highlight"], [data-tid*="video-stream"][class*="active"]');
                                if (highlighted) {
                                    const nameEl = highlighted.closest('[data-tid*="video-tile"]')?.querySelector('[data-tid*="display-name"]');
                                    if (nameEl) { speaker = nameEl.textContent.trim(); return; }
                                }
                            }

                            // Strategy 5: Single participant in focus
                            if (!speaker) {
                                const mainStage = doc.querySelector('[data-tid="meeting-stage"]');
                                if (mainStage) {
                                    const nameEl = mainStage.querySelector('[data-tid*="display-name"]');
                                    if (nameEl && nameEl.textContent.trim().length > 1) {
                                        speaker = nameEl.textContent.trim();
                                        return;
                                    }
                                }
                            }

                            // RECURSE INTO IFRAMES
                            doc.querySelectorAll('iframe').forEach(iframe => {
                                try {
                                    if (iframe.contentDocument) scanDocument(iframe.contentDocument);
                                } catch (e) { }
                            });
                        };

                        const cleanName = (raw) => {
                            if (!raw) return 'Participant';
                            return raw.replace(/(\(Guest\)|\(External\)|\(Meeting Guest\)|\(Presenter\))/gi, '').trim();
                        };

                        scanDocument(document);

                        if (speaker) {
                            speaker = cleanName(speaker);
                        }

                        if (speaker && speaker !== window.__lastSpeaker) {
                            const now = Date.now();
                            if (window.__lastSpeaker && window.__speakerTimeline.length > 0) {
                                const last = window.__speakerTimeline[window.__speakerTimeline.length - 1];
                                if (!last.endMs) last.endMs = now - window.__speakerAnchor;
                            }
                            window.__speakerTimeline.push({
                                name: speaker,
                                startMs: now - window.__speakerAnchor,
                                endMs: null
                            });
                            window.__lastSpeaker = speaker;
                            if (window.sendSpeakerEvent) window.sendSpeakerEvent(speaker);
                            console.log(`[SPEAKER] ${speaker}`);
                        }
                    } catch (e) { }
                };

                // Poll every 2 seconds
                setInterval(detectSpeaker, 2000);
                detectSpeaker(); // immediate first check
                console.log('[SPEAKER] High-frequency speaker tracker started (2s interval)');
            }, recordingAnchorTime);
            log('✅ Speaker tracker injected into page');
        } catch (e) {
            log('⚠️ Speaker tracker injection failed: ' + e.message);
        }

        let noControlsTicks = 0;
        const heartbeatInterval = setInterval(async () => {
            if (meetingEnded) return;

            sendIPC('heartbeat', {});

            try {
                // 0. LOBBY-TO-MEETING TRANSITION DETECTION
                if (finalState === 'IN_LOBBY') {
                    try {
                        const nowInMeeting = await page.evaluate(() => {
                            const hangup = document.querySelector('button[data-tid="call-hangup"]') ||
                                document.querySelector('button[data-tid="hangup-button"]');
                            const leaveBtn = Array.from(document.querySelectorAll('button')).some(b => {
                                const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                                return aria.includes('leave') || aria.includes('hang up');
                            });
                            const toolbar = document.querySelector('[data-tid="calling-roster"]') ||
                                document.querySelector('.meeting-action-bar') ||
                                document.querySelector('[aria-label="Meeting controls"]') ||
                                document.querySelector('[data-tid="calling-header"]');
                            const lobbyGone = !document.body.innerText.includes('will let you in') &&
                                !document.body.innerText.includes('waiting to be admitted');
                            return !!(hangup || leaveBtn || toolbar) && lobbyGone;
                        });

                        if (nowInMeeting) {
                            console.log('🟢 LOBBY → IN_MEETING transition detected! Bot has been admitted.');
                            finalState = 'IN_MEETING';
                            sendIPC('status', 'IN_MEETING');

                            // Re-hook audio streams after admission
                            try {
                                await page.evaluate(() => {
                                    console.log('[EAR] Re-scanning for audio streams after lobby admission...');
                                    const getAllElements = (doc) => {
                                        let els = [...doc.querySelectorAll('audio'), ...doc.querySelectorAll('video')];
                                        doc.querySelectorAll('iframe').forEach(iframe => {
                                            try { if (iframe.contentDocument) els = [...els, ...getAllElements(iframe.contentDocument)]; } catch (e) { }
                                        });
                                        return els;
                                    };
                                    const ctx = window.__earAudioContext;
                                    const mixer = window.__earMixer;
                                    if (!ctx || !mixer) return;
                                    const elements = getAllElements(document);
                                    elements.forEach(el => {
                                        const stream = el.srcObject || (el.captureStream ? el.captureStream() : null);
                                        if (stream && stream.getAudioTracks().length > 0 && !el.dataset.captured) {
                                            try {
                                                el.dataset.captured = 'true';
                                                el.muted = false;
                                                el.volume = 1.0;
                                                const source = ctx.createMediaStreamSource(stream);
                                                source.connect(mixer);
                                            } catch (e) { }
                                        }
                                    });
                                });
                            } catch (e) { }
                        }
                    } catch (e) { }
                }

                // 1. SMART END DETECTION
                if (finalState === 'IN_MEETING') {
                    const isStillActive = await page.evaluate(() => {
                        const hangupBtn = document.querySelector('button[aria-label*="hang up" i], button[id*="hangup"], button[aria-label*="leave" i]');
                        const endedText = document.body.innerText.includes('Call ended') || document.body.innerText.includes('was removed') || document.body.innerText.includes('You were removed');
                        const rejoinBtn = document.querySelector('button[aria-label*="rejoin" i]');

                        if (!hangupBtn || endedText || rejoinBtn) return false;
                        return true;
                    }).catch(() => false);

                    if (!isStillActive) {
                        noControlsTicks++;
                        if (noControlsTicks >= 3) {
                            log('🚩 Meeting end detected via UI signals (controls vanished or end screen displayed).');
                            meetingEnded = true;
                            return;
                        }
                    } else {
                        noControlsTicks = 0;
                    }
                }

                // 2. SAFETY SWEEP & POP-UP BUSTER
                await page.evaluate(() => {
                    // Mute check
                    const buttons = Array.from(document.querySelectorAll('button[aria-label*="camera" i], button[aria-label*="mic" i], button[aria-label*="mute" i]'));
                    buttons.forEach(btn => {
                        const label = (btn.ariaLabel || '').toLowerCase();
                        const isMuted = btn.ariaPressed === 'false' || label.includes('turn on') || label.includes('unmute');
                        if (!isMuted && !label.includes('mute')) btn.click();
                    });

                    // Popup buster
                    const dismissBtn = Array.from(document.querySelectorAll('button')).find(b => {
                        const t = b.innerText.toLowerCase();
                        return t.includes('dismiss') || t.includes('got it') || t.includes('not now') || t.includes('ok');
                    });
                    if (dismissBtn) dismissBtn.click();
                }).catch(() => { });

                // 3. WEBRTC TRACK SCAN
                try {
                    const tracksAdded = await page.evaluate(() => window.__scanRemoteTracks ? window.__scanRemoteTracks() : 0);
                    if (tracksAdded > 0) log(`🎧 Re-hooked ${tracksAdded} new tracks`);
                } catch (e) { }

                // 4. MEETING END SCREEN CHECK
                const hasEndScreen = await page.evaluate(() => {
                    const txt = document.body.innerText;
                    return txt.includes("Meeting ended") ||
                        txt.includes("The meeting has ended") ||
                        txt.includes("Call ended") ||
                        txt.includes("How was the call quality") ||
                        txt.includes("You left the call") ||
                        txt.includes("Rate the quality");
                }).catch(() => false);
                if (hasEndScreen) {
                    log('🛑 End screen detected.');
                    meetingEnded = true;
                }

                // 5. SPEAKER SYNC
                const timeline = await page.evaluate(() => window.__speakerTimeline || []).catch(() => []);
                if (timeline.length > speakerTimeline.length) {
                    for (let i = speakerTimeline.length; i < timeline.length; i++) {
                        const ev = timeline[i];
                        speakerTimeline.push(ev);
                        if (ev.name !== lastDetectedSpeaker) {
                            lastDetectedSpeaker = ev.name;
                            sendIPC('speaker-change', {
                                name: ev.name,
                                timestamp: recordingAnchorTime + ev.startMs,
                                startMs: ev.startMs
                            });
                        }
                    }
                }

            } catch (err) {
                log(`⚠️ Heartbeat Error: ${err.message}`);
            }
        }, 10000); // Heartbeat every 10s

        // --- STEP 6: WAIT FOR MEETING END ---
        log('🎤 Recording Active - Waiting for meeting end...');

        // Wait until meeting ends or max timeout
        const maxTime = Date.now() + (120 * 60 * 1000); // 2 hours
        while (!meetingEnded && Date.now() < maxTime) {
            await new Promise(r => setTimeout(r, 5000));
        }

        // --- STOP ALL BACKGROUND WORKERS ---
        clearInterval(incrementalIntervalId);
        clearInterval(heartbeatInterval);
        console.log('✅ Transcription period complete (Meeting fully ingested)');

        // Stop recording
        try {
            await page.evaluate(() => {
                if (window.meetingMediaRecorder) {
                    window.meetingMediaRecorder.stop();
                    console.log('MediaRecorder stopped');
                }
            });
            await new Promise(r => setTimeout(r, 2000)); // Wait for last chunks
            audioStream.end();
        } catch (e) {
            console.error('Error stopping recorder:', e.message);
        }

        // The manager.js already holds the complete VTT aggressively synced.
        // There is absolutely no need to run a "Final Full Pass" on a 2-hour audio file,
        // which was causing massive hallucination timeouts and crashing the finalization.

        console.log('✅ Notifying manager of successful completion.');
        sendIPC('status', 'ENDED');
        // Give manager a moment to process before exiting
        await new Promise(r => setTimeout(r, 2000));

        try {
            if (browser) await browser.close();
        } catch (e) { }
        process.exit(0);

    } catch (err) {
        sendIPC('status', 'FAILED');
        console.error('❌ FATAL:', err.message);
        try {
            if (browser) await browser.close();
        } catch (e) { }
        process.exit(1);
    }
})();
