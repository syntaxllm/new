import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

// Fix Unicode output for Windows - often causes issues in child_process
// if (process.platform === 'win32') {
//    process.stdout.setEncoding('utf8');
// }

const MEETING_URL = process.argv[2];

if (!MEETING_URL) {
    console.error(" FATAL: MEETING_URL is not defined");
    process.exit(1);
}

// --- STRICT STATE MACHINE ---
const STATES = {
    BROWSER_READY: 'BROWSER_READY',
    PRE_JOIN_SCREEN: 'PRE_JOIN_SCREEN',
    JOIN_CLICKED: 'JOIN_CLICKED',
    IN_MEETING_CONFIRMED: 'IN_MEETING_CONFIRMED',
    RECORDING_STARTED: 'RECORDING_STARTED',
    TRANSCRIPTION_PROCESSING: 'TRANSCRIPTION_PROCESSING',
    FAILED: 'FAILED'
};

let currentState = STATES.BROWSER_READY;

function transitionTo(newState) {
    console.log(`[STATE] ${currentState} -> ${newState}`);
    currentState = newState;
    sendIPC('status', newState);
}

// --- CONFIG & PATHS ---
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const RECORDINGS_DIR = path.resolve(process.cwd(), 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
const RECORDING_PATH = path.resolve(RECORDINGS_DIR, `meeting-${timestamp}.webm`);
const TRANSCRIPT_PATH = path.resolve(RECORDINGS_DIR, `transcript-${timestamp}.txt`);

function log(msg) {
    console.log(`[BOT] ${msg}`);
}

// Helper to safely send IPC messages
function sendIPC(type, payload) {
    if (process.send) {
        process.send({ type, payload });
    }
}

// Redirect console.log to IPC for the Manager to capture
const originalLog = console.log;
console.log = (...args) => {
    const msg = args.map(a => String(a)).join(' ');
    if (process.send) {
        sendIPC('log', msg); // Send to manager via IPC (Prevents duplicate stdout)
    } else {
        originalLog.apply(console, args); // Keep stdout for manual terminal debugging
    }
};

const pid = process.pid;

(async () => {
    transitionTo(STATES.BROWSER_READY);
    console.log(`🤖 Bot Launching (State Machine Mode) [PID: ${pid}]...`);

    const browser = await puppeteer.launch({
        headless: 'new', // Use 'new' for modern headless
        defaultViewport: null,
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
            // Added for robustness in audio context creation
            '--disable-features=AudioServiceOutOfProcess'
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
    await page.exposeFunction('sendAudioChunk', (chunkBase64) => {
        const buffer = Buffer.from(chunkBase64, 'base64');
        audioStream.write(buffer);
        totalBytesReceived += buffer.length;

        // Log every ~50KB to show life
        if (Math.floor(totalBytesReceived / (1024 * 50)) > Math.floor((totalBytesReceived - buffer.length) / (1024 * 50))) {
            log(`🎤 Audio Chunk Saved (${Math.round(totalBytesReceived / 1024)}KB total)`);
        }
    });

    // Expose a function to track speaker changes
    await page.exposeFunction('sendSpeakerEvent', (name) => {
        log(`🎤 Speaker Change: ${name}`);
        sendIPC('speaker-change', { name, timestamp: Date.now() });
    });

    // Set viewport explicitly
    await page.setViewport({ width: 1920, height: 1080 });

    // EXPLICITLY GRANT PERMISSIONS
    const context = browser.defaultBrowserContext();
    const origins = ['https://teams.microsoft.com', 'https://teams.live.com', 'https://v-teams.microsoft.com'];
    for (const origin of origins) {
        try {
            await context.overridePermissions(origin, ['microphone', 'camera', 'notifications', 'clipboard-read']);
        } catch (e) { }
    }

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');

    // --- HELPER: Find Element Across Frames ---
    async function findInFrames(page, selector) {
        // Check main page first
        const mainEl = await page.$(selector);
        if (mainEl) return { frame: page, el: mainEl };

        // Check all frames
        for (const frame of page.frames()) {
            try {
                const el = await frame.$(selector);
                if (el) return { frame, el };
            } catch (e) { }
        }
        return null;
    }

    try {
        console.log('🔗 Navigating to meeting...');

        // FIX 1: Use domcontentloaded (prevents network timeouts)
        await page.goto(MEETING_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        // FIX 2: Wait for DOM Body (prevents blind sleep issues)
        console.log('⏳ Waiting for page DOM...');
        await page.waitForSelector('body', { timeout: 30000 });
        console.log('✅ Page Loaded (DOM Ready).');

        // Debug output
        const debugPath = path.resolve(process.cwd(), 'public', 'debug');
        if (!fs.existsSync(debugPath)) fs.mkdirSync(debugPath, { recursive: true });
        await page.screenshot({ path: path.resolve(debugPath, 'step1-hydrated.png') });

        // --- PRE-JOIN SCREEN HANDLING ---
        transitionTo(STATES.PRE_JOIN_SCREEN);

        // 1. Handle "Open in app" popup
        for (let i = 0; i < 3; i++) {
            try {
                const openInAppBtn = await page.$('button:has-text("Open in app"), button:has-text("Open app")');
                if (openInAppBtn) {
                    log('✅ Bypassing app-open popup');
                    await openInAppBtn.click();
                    await new Promise(r => setTimeout(r, 1000));
                }
            } catch (e) { }
        }

        // 2. Handle "Continue on this browser"
        let landed = false;
        try {
            // Check if we already moved past this screen
            const preJoinCheck = await page.$('input[data-tid="prejoin-display-name-input"]');
            if (preJoinCheck) {
                console.log('✅ Already on Pre-Join screen.');
                landed = true;
            } else {
                const clicked = await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const target = buttons.find(b => {
                        const t = b.innerText.toLowerCase();
                        return t.includes('continue on this browser') || t.includes('join on the web');
                    });
                    if (target) {
                        target.click();
                        return true;
                    }
                    return false;
                });

                if (clicked) {
                    console.log('✅ Clicked "Continue on this browser". Waiting for navigation...');
                    try {
                        // Explicitly wait for navigation to complete
                        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
                        log('✅ Navigation complete.');
                    } catch (e) {
                        log('⚠️ Navigation timeout/warning (proceeding)...');
                    }
                }
            }
        } catch (e) {
            console.log('⚠️ Landing page navigation issue:', e.message);
        }

        // 3. Wait for Pre-Join interactions (ROBUST)
        try {
            await page.waitForSelector('input[data-tid="prejoin-display-name-input"], input[id^="username"], input[aria-label*="name" i]', { timeout: 30000 });
            log('✅ Join screen detected');
        } catch (e) {
            log('⚠️ Pre-Join UI slowly loading, checking for "Allow" modals...');

            // Modal Buster (SAFEGUARDED)
            try {
                await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const modalBtn = buttons.find(b => {
                        const txt = b.innerText.toLowerCase();
                        return txt.includes('allow') || txt.includes('dismiss') || txt.includes('got it');
                    });
                    if (modalBtn) modalBtn.click();
                });
            } catch (evalErr) {
                if (!evalErr.message.includes('Protocol error')) console.log('⚠️ ' + evalErr.message);
            }

            await new Promise(r => setTimeout(r, 2000));
            // Re-check
            try {
                await page.waitForSelector('input[data-tid="prejoin-display-name-input"]', { timeout: 10000 });
            } catch (e) { }
        }

        // --- STEP 2.2: ENTER NAME (NUCLEAR OPTION) ---
        log('✍️ Setting bot name (Nuclear Mode)...');
        try {
            const nameEntered = await page.evaluate(async () => {
                const inputs = Array.from(document.querySelectorAll('input[type="text"], input[data-tid*="name"]'));
                const visibleInputs = inputs.filter(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && el.style.visibility !== 'hidden';
                });

                for (const input of visibleInputs) {
                    try {
                        input.focus();
                        input.click();
                        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                        if (setter) {
                            setter.call(input, 'MeetingAI Bot');
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            input.dispatchEvent(new Event('change', { bubbles: true }));
                            input.dispatchEvent(new Event('blur', { bubbles: true }));
                        } else {
                            input.value = 'MeetingAI Bot';
                        }
                        if (input.value === 'MeetingAI Bot') return true;
                    } catch (e) { }
                }
                return false;
            });

            if (!nameEntered) {
                // Fallback to native typing
                const nameInput = await page.$('input[data-tid="prejoin-display-name-input"], input[id^="username"]');
                if (nameInput) {
                    await nameInput.click({ clickCount: 3 });
                    await nameInput.type('MeetingAI Bot');
                }
            }
        } catch (e) { log('⚠️ Name entry warning: ' + e.message); }

        // 5. Force Disable Camera/Mic
        log('🔇 Ensuring Camera and Mic are OFF...');
        try {
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const muteDevice = (keywords) => {
                    const btn = buttons.find(b => {
                        const label = (b.ariaLabel || '').toLowerCase();
                        const text = (b.innerText || '').toLowerCase();
                        return keywords.some(k => label.includes(k) || text.includes(k));
                    });
                    if (btn) {
                        const label = (btn.ariaLabel || '').toLowerCase();
                        const isCurrentlyOn = btn.ariaPressed === 'true' || label.includes('turn off') || label.includes('mute');
                        if (isCurrentlyOn && !label.includes('turn on')) btn.click();
                    }
                };
                muteDevice(['camera', 'video']);
                muteDevice(['microphone', 'mic', 'mute']);
            });
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) { }

        // --- STATE: JOIN CLICKED (ROBUST STRATEGY) ---
        transitionTo(STATES.JOIN_CLICKED);
        log('👇 Executing STABLE join sequence...');

        // 1. Primary Click (Fuzzy & Events)
        log('👆 Clicking Primary Join Button...');
        let joinClicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
            const joinBtn = buttons.find(b => {
                const txt = (b.innerText || '').toLowerCase();
                const tid = (b.getAttribute('data-tid') || '').toLowerCase();
                return txt === 'join now' || txt === 'join' || tid.includes('prejoin-join') || tid.includes('join-button');
            });
            if (joinBtn) {
                joinBtn.click();
                // Dispatch manual events for React
                ['mousedown', 'mouseup', 'click'].forEach(evt => {
                    joinBtn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true }));
                });
                return true;
            }
            return false;
        });

        if (!joinClicked) {
            log('⚠️ Standard join click failed. Searching frames...');
            // Frame fallback handled in loop
        }

        // 3. Wait for Meeting Entry (ROBUST with CONTINUOUS MODAL BUSTER)
        log('⏳ Waiting for meeting entry (Loop with Modal Buster)...');

        let inMeeting = false;
        const startTime = Date.now();
        const maxWait = 60000; // 60s

        while (Date.now() - startTime < maxWait) {
            // A. MODAL BUSTER (Crucial for fake devices)
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
                const busterBtn = buttons.find(b => {
                    const txt = (b.innerText || '').toLowerCase();
                    return txt.includes('continue without audio') ||
                        txt.includes('dismiss') ||
                        txt.includes('got it');
                });
                if (busterBtn) busterBtn.click();
            });

            // B. Detect Meeting
            const detected = await page.evaluate(() => {
                const selectors = [
                    '[data-tid="call-hangup"]',
                    '[aria-label="Hang up"]',
                    'button[aria-label*="leave" i]',
                    'button[id*="hangup"]',
                    'button[data-tid*="leave"]',
                    'video', // Strongest signal
                    '[data-tid*="call-control"]'
                ];
                return selectors.some(s => document.querySelector(s));
            });

            if (detected) {
                inMeeting = true;
                break;
            }

            // C. Frame check fallback
            // C. Frame check fallback
            for (const frame of page.frames()) {
                const frameResult = await frame.evaluate(() => !!(
                    document.querySelector('[data-tid="call-hangup"]') ||
                    document.querySelector('button[aria-label*="leave" i]')
                )).catch(() => false);
                if (frameResult) {
                    inMeeting = true;
                    break;
                }
            }
            if (inMeeting) break;

            await new Promise(r => setTimeout(r, 2000));
        }

        // --- STATE: IN_MEETING_CONFIRMED (FINAL CHECK) ---
        if (inMeeting) {
            transitionTo(STATES.IN_MEETING_CONFIRMED);
        } else {
            // One last check before giving up
            inMeeting = await page.evaluate(() => !!(document.querySelector('[data-tid="call-hangup"]') || document.querySelector('[aria-label="Hang up"]')));
            if (inMeeting) {
                transitionTo(STATES.IN_MEETING_CONFIRMED);
            } else {
                // Final check for Lobby
                const isLobby = await page.evaluate(() => document.body.innerText.includes('waiting to be admitted'));
                if (isLobby) {
                    sendIPC('status', 'IN_LOBBY');
                    log('🟡 Locked in Lobby.');
                    // Infinite Wait Loop for Lobby
                    while (true) {
                        await new Promise(r => setTimeout(r, 5000));
                        const admitted = await page.evaluate(() => !!(document.querySelector('[data-tid="call-hangup"]') || document.querySelector('[aria-label="Hang up"]')));
                        if (admitted) {
                            log('✅ Admitted from Lobby!');
                            transitionTo(STATES.IN_MEETING_CONFIRMED);
                            break;
                        }
                    }
                } else {
                    log('❌ Failed to join after Robust Sequence.');
                    throw new Error('Join Timeout');
                }
            }
        }

        // --- RECORDING START ---
        // At this point, we are strictly IN_MEETING_CONFIRMED

        // --- STATE: RECORDING_STARTED ---
        transitionTo(STATES.RECORDING_STARTED);
        log('🎤 Starting INGEST MODE (Stable/Robust)...');

        await page.evaluate(async () => {
            console.log('[EAR] Initializing Virtual Ear...');
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();

                // Resume context if suspended (common in headless/autoplay scenarios)
                if (ctx.state === 'suspended') {
                    await ctx.resume();
                    console.log('[INGEST] Audio Context Resumed');
                }

                const destination = ctx.createMediaStreamDestination();

                // Track captured elements
                const capturedElements = new WeakSet();

                const captureAudioElements = () => {
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
                        if (stream && stream.getAudioTracks().length > 0 && !capturedElements.has(el)) {
                            try {
                                const source = ctx.createMediaStreamSource(stream);
                                source.connect(destination);
                                capturedElements.add(el);
                                found++;
                                console.log(`[EAR] Hooked participant stream: ${stream.id}`);
                            } catch (err) {
                                // Already connected
                            }
                        }
                    });
                    if (found > 0) console.log(`[EAR] New streams hooked: ${found}`);
                };

                // Poll for new speakers (Recursive)
                setInterval(captureAudioElements, 3000);
                captureAudioElements();

                // Setup Recorder
                const mimeType = 'audio/webm;codecs=opus'; // Standard for webm
                const recorder = new MediaRecorder(destination.stream, { mimeType });

                recorder.ondataavailable = (event) => {
                    if (event.data && event.data.size > 0) {
                        const reader = new FileReader();
                        reader.onload = () => {
                            const base64 = reader.result.split(',')[1];
                            window.sendAudioChunk(base64);
                        };
                        reader.readAsDataURL(event.data);
                    }
                };

                recorder.start(1000); // 1s chunks
                window.meetingMediaRecorder = recorder;
                console.log(`[INGEST] MediaRecorder started (${mimeType})`);

            } catch (err) {
                console.error('[INGEST] Start failed:', err.message);
            }
        });

        // --- STATE: TRANSCRIPTION_PROCESSING ---
        transitionTo(STATES.TRANSCRIPTION_PROCESSING);

        let lastTranscriptionSize = 0;
        let meetingEnded = false;

        const heartbeatInterval = setInterval(async () => {
            if (meetingEnded) return;

            sendIPC('heartbeat', {});

            // 1. Check for End of Meeting
            const isStillActive = await page.evaluate(() => {
                const hangupBtn = document.querySelector('button[aria-label*="hang up" i], button[id*="hangup"], button[aria-label*="leave" i]');
                const endedText = document.body.innerText.includes('Call ended') || document.body.innerText.includes('was removed');
                if (!hangupBtn || endedText) return false;
                return true;
            });

            if (!isStillActive) {
                log('🚩 Meeting end detected via UI signals.');
                meetingEnded = true;
                return;
            }

            // 2. Transcribe periodically
            try {
                const stats = fs.statSync(RECORDING_PATH);
                if (stats.size > lastTranscriptionSize + (1024 * 50)) { // Every 50KB
                    log(`🤖 Updating transcript (${Math.round(stats.size / 1024)}KB)...`);
                    try {
                        // Dynamic import for service.js to avoid top-level await issues if not supported
                        // or just use consistent import if typical Node
                        // NOTE: Changed to relative path based on usage
                        const { transcribeAudio } = await import('../stt/service.js');
                        const result = await transcribeAudio(RECORDING_PATH);
                        if (result && (result.text || result.segments)) {
                            sendIPC('transcript', result);
                            sendIPC('stt-success', { count: result.segments?.length });
                            fs.writeFileSync(TRANSCRIPT_PATH, result.text || '');
                        }
                    } catch (innerErr) {
                        // ignore partial import errors
                    }
                    lastTranscriptionSize = stats.size;
                }
            } catch (e) {
                log(`⚠️ STT partial failed: ${e.message}`);
            }

        }, 15000); // Check every 15s

        // Keep Alive Loop
        const maxTime = Date.now() + (120 * 60 * 1000); // 2 hours hard limit
        while (!meetingEnded && Date.now() < maxTime) {
            await new Promise(r => setTimeout(r, 5000));
        }

        clearInterval(heartbeatInterval);
        console.log('✅ Meeting ended. Stopping recorder...');

        // Stop Recorder
        try {
            await page.evaluate(() => {
                if (window.meetingMediaRecorder) window.meetingMediaRecorder.stop();
            });
            await new Promise(r => setTimeout(r, 2000));
            audioStream.end();
        } catch (e) { }

        // Final Transcription
        console.log('🤖 Triggering Final STT...');
        try {
            const { transcribeAudio } = await import('../stt/service.js');
            const result = await transcribeAudio(RECORDING_PATH);
            if (result && result.text) {
                fs.writeFileSync(TRANSCRIPT_PATH, result.text);
                sendIPC('transcript', result.text);
            }
        } catch (e) {
            console.error('❌ Final STT failed:', e.message);
        }

        console.log('🔴 Bot shutting down gracefully...');
        await browser.close();
        process.exit(0);

    } catch (err) {
        transitionTo(STATES.FAILED);
        console.error('❌ FATAL:', err.message);
        try {
            console.log('📸 Attempting to save fatal error screenshot...');
            await page.screenshot({ path: path.resolve(process.cwd(), 'public', 'debug', 'fatal-error.png') });
            console.log('📸 Saved fatal-error.png');
        } catch (e) {
            console.error('⚠️ Failed to save screenshot:', e.message);
        }
        // Keep browser open for debugging if HEADLESS is false
        if (!process.argv.includes('--headless')) { // Simple check, or just wait a bit
            console.log('🛑 Keeping browser open for 30s for inspection...');
            await new Promise(r => setTimeout(r, 30000));
        }
        process.exit(1);
    }
})();
