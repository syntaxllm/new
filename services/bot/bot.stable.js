import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

// Fix Unicode output for Windows - REMOVED to prevent crash in child_process
// if (process.platform === 'win32') {
//    process.stdout.setEncoding('utf8');
// }

const MEETING_URL = process.argv[2];

if (!MEETING_URL) {
    console.error(" FATAL: MEETING_URL is not defined");
    process.exit(1);
}

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
    sendIPC('log', msg); // Send to manager
    originalLog.apply(console, args); // Keep stdout for debugging
};

const pid = process.pid;

(async () => {
    sendIPC('status', 'LAUNCHING'); // Initial status
    console.log(`🤖 Bot Launching (Stable Mode) [PID: ${pid}]...`);

    const browser = await puppeteer.launch({
        headless: 'new',
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
            '--allow-loopback-in-peer-connection'
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

    // EXPLICITLY GRANT PERMISSIONS (Fixes headless permission stalls)
    const context = browser.defaultBrowserContext();
    const origins = ['https://teams.microsoft.com', 'https://teams.live.com', 'https://v-teams.microsoft.com'];
    for (const origin of origins) {
        try {
            await context.overridePermissions(origin, ['microphone', 'camera', 'notifications', 'clipboard-read']);
        } catch (e) { }
    }

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');

    try {
        sendIPC('status', 'NAVIGATING');
        console.log('🔗 Navigating to meeting...');
        // FIX: 'domcontentloaded' is too fast for Teams. Use 'networkidle0' and explicit sleep.
        await page.goto(MEETING_URL, { waitUntil: 'networkidle0', timeout: 90000 });

        console.log('⏳ Waiting for page hydration (rendering)...');
        await new Promise(r => setTimeout(r, 5000)); // Give React time to paint

        console.log('✅ Page Loaded & Hydrated.');

        // DEBUG: Take screenshot after hydration
        const debugPath = path.resolve(process.cwd(), 'public', 'debug');
        if (!fs.existsSync(debugPath)) fs.mkdirSync(debugPath, { recursive: true });
        await page.screenshot({ path: path.resolve(debugPath, 'step1-hydrated.png') });
        console.log('📸 Screenshot taken: step1-hydrated.png');

        // --- STEP 1: HANDLE REDIRECT / LAUNCHER ---
        console.log('🔍 Checking for "Continue on this browser"...');

        // Handle "Open in app" popup first
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

        // Retry loop for clicking the landing page button
        let landed = false;
        for (let i = 0; i < 5; i++) {
            try {
                // Check if we already moved past this screen
                const preJoinCheck = await page.$('input[data-tid="prejoin-display-name-input"]');
                if (preJoinCheck) {
                    console.log('✅ Already on Pre-Join screen.');
                    landed = true;
                    break;
                }

                // Find valid buttons
                const buttons = await page.$$('button');
                let targetBtn = null;

                for (const btn of buttons) {
                    try {
                        const text = (await page.evaluate(el => el.innerText, btn) || '').toLowerCase();
                        const tid = (await page.evaluate(el => el.getAttribute('data-tid'), btn) || '').toLowerCase();

                        if (text.includes('continue on this browser') ||
                            text.includes('use the web app') ||
                            text.includes('join on the web') ||
                            text.includes('continue') ||
                            tid.includes('join-on-web') ||
                            tid.includes('continue-on-browser')) {
                            targetBtn = btn;
                            break;
                        }
                    } catch (e) { }
                }

                if (targetBtn) {
                    console.log(`[${new Date().toISOString()}] ✅ Clicking landing button: "${await page.evaluate(el => el.innerText, targetBtn)}" (Attempt ${i + 1})...`);

                    // Diagnostic screenshot
                    try {
                        await page.screenshot({ path: path.resolve(debugPath, `landing-attempt-${i + 1}.png`) });
                    } catch (e) { }

                    // Robust click
                    try {
                        await Promise.all([
                            page.evaluate(b => b.click(), targetBtn),
                            new Promise(r => setTimeout(r, 500))
                        ]);
                    } catch (e) {
                        console.log(`[${new Date().toISOString()}] ⚠️ Click interrupted (likely navigation):`, e.message);
                    }

                    // WAIT FOR NAVIGATION START (Optimized)
                    await new Promise(r => setTimeout(r, 8000));
                } else {
                    console.log(`[${new Date().toISOString()}] ℹ️ No "Continue" button found yet (Attempt ${i + 1})...`);
                    try {
                        await page.screenshot({ path: path.resolve(debugPath, `no-button-attempt-${i + 1}.png`) });
                    } catch (e) { }
                    await new Promise(r => setTimeout(r, 3000));
                }
            } catch (error) {
                console.log(`[${new Date().toISOString()}] ⚠️ Navigation/Context error in loop:`, error.message);
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        // --- STEP 2: PRE-JOIN SCREEN ---
        sendIPC('status', 'PRE_JOIN');
        log('🔍 Preparing to join meeting...');
        try {
            console.log(`🔗 Current URL: ${page.url()}`);
            await page.waitForSelector('input[data-tid="prejoin-display-name-input"]', { timeout: 30000 });
            log('✅ Join screen detected');
        } catch (e) {
            log('⚠️ Pre-Join UI loading slowly, checking for "Allow" modals...');

            // MODAL BUSTER: Click past the "Allow" overlay if it exists
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const modalBtn = buttons.find(b => {
                    const txt = b.innerText.toLowerCase();
                    return txt.includes('allow') ||
                        txt.includes('dismiss') ||
                        txt.includes('got it') ||
                        txt.includes('ok') ||
                        txt.includes('continue without audio or video');
                });

                if (modalBtn) {
                    modalBtn.click();
                } else if (document.body.innerText.includes('Select Allow')) {
                    // Force click center of screen to dismiss informational overlays
                    const x = window.innerWidth / 2;
                    const y = window.innerHeight / 2;
                    const el = document.elementFromPoint(x, y);
                    if (el) el.click();
                }
            });
            await new Promise(r => setTimeout(r, 2000));

            // Re-check for Join Screen after potential modal clearance
            try {
                await page.waitForSelector('input[data-tid="prejoin-display-name-input"]', { timeout: 5000 });
                log('✅ Join screen detected (Post-Modal Buster)');
            } catch (retryErr) { }
        }

        // --- STEP 2.2: ENTER NAME ---
        const nameInput = await page.$('input[data-tid="prejoin-display-name-input"], input[id^="username"], input[type="text"]');
        if (nameInput) {
            log('✍️ Setting bot name...');
            await nameInput.click({ clickCount: 3 });
            await nameInput.press('Backspace');
            await nameInput.type('MeetingAI Bot');
            await new Promise(r => setTimeout(r, 500));
        }

        // --- STEP 2.5: FORCE DISABLE CAMERA AND MIC (SILENT MODE) ---
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
                        const isCurrentlyOn = btn.ariaPressed === 'true' ||
                            label.includes('turn off') ||
                            label.includes('mute');

                        // Only click if it's currently "ON"
                        if (isCurrentlyOn && !label.includes('turn on')) {
                            btn.click();
                        }
                    }
                };

                muteDevice(['camera', 'video']);
                muteDevice(['microphone', 'mic', 'mute']);
            });
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            log('⚠️ Pre-join mute failed: ' + e.message);
        }

        // --- STEP 3: JOIN ---
        sendIPC('status', 'JOINING');
        log('👆 Joining meeting...');
        await new Promise(r => setTimeout(r, 1500));

        let joinClicked = false;

        // STRATEGY 1: Smart selector + robust click
        try {
            const joinButton = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                return buttons.find(b => {
                    const txt = b.innerText.trim().toLowerCase();
                    const tid = b.getAttribute('data-tid') || '';
                    return txt === 'join now' ||
                        txt === 'join' ||
                        txt === 'join meeting' ||
                        tid.includes('join-button') ||
                        tid.includes('prejoin-join') ||
                        tid.includes('submit-button');
                }) || document.querySelector('button[data-tid="prejoin-join-button"]');
            });

            if (joinButton && joinButton.asElement()) {
                log('🎯 Join button found, attempting robust click...');
                const btn = joinButton.asElement();

                // Strategy A: Native click
                await btn.click({ delay: 100 });

                // Strategy B: Focus + Enter (for React/Angular handlers)
                await btn.focus();
                await new Promise(r => setTimeout(r, 200));
                await page.keyboard.press('Enter');

                console.log('✅ Join sequence initiated');
                joinClicked = true;
            } else {
                // Fallback: evaluate click (direct DOM manipulation)
                joinClicked = await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const joinBtn = buttons.find(b => {
                        const txt = b.innerText.trim().toLowerCase();
                        const tid = b.getAttribute('data-tid') || '';
                        return txt === 'join now' || txt === 'join' || tid.includes('join-button');
                    });
                    if (joinBtn) {
                        joinBtn.click();
                        // Dispatch additional events just in case
                        ['mousedown', 'mouseup', 'click'].forEach(evt => {
                            joinBtn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true }));
                        });
                        return true;
                    }
                    return false;
                });
                if (joinClicked) console.log('✅ Join initiated via fallback injection');
            }
        } catch (e) {
            if (e.message.includes('detached') || e.message.includes('Target closed')) {
                console.log('✅ Join triggered navigation (frame detached)');
                joinClicked = true;
            } else {
                console.error('❌ Join button interaction failed:', e.message);
            }
        }

        if (!joinClicked) {
            console.error('❌ Could not find or click Join button');
            await page.screenshot({ path: path.resolve(debugPath, 'join-button-missing.png') });
            sendIPC('status', 'FAILED');
            throw new Error('JOIN_BUTTON_NOT_FOUND');
        }

        // --- STEP 3.5: HANDLE AUDIO SELECTION MODAL ---
        console.log('🔍 Checking for audio selection modal (Waiting up to 10s)...');
        await new Promise(r => setTimeout(r, 10000));

        // Take diagnostic screenshot before second join
        try {
            await page.screenshot({ path: path.resolve(debugPath, 'before-second-join.png') });
            console.log('📸 Screenshot: before-second-join.png');
        } catch (e) { }

        try {
            // Strategy 1: Look for "Computer audio" text (confirms we're on audio modal)
            const hasAudioModal = await page.evaluate(() => {
                return document.body.innerText.includes('Computer audio') ||
                    document.body.innerText.includes('Phone audio') ||
                    document.body.innerText.includes('Fake Default Audio');
            });

            if (hasAudioModal) {
                console.log('✅ Audio selection modal confirmed (Computer audio detected)');

                // CRITICAL FIX: NUCLEAR OPTION FOR NAME ENTRY
                // The specific selectors failed. We will try ALL visible text inputs.
                try {
                    console.log('☢️ Initiating NUCLEAR name entry...');

                    const nameEntered = await page.evaluate(async () => {
                        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[data-tid*="name"]'));
                        // Filter for visible inputs only
                        const visibleInputs = inputs.filter(el => {
                            const rect = el.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0 && el.style.visibility !== 'hidden';
                        });

                        console.log(`Found ${visibleInputs.length} visible inputs`);

                        for (const input of visibleInputs) {
                            try {
                                input.focus();
                                input.click();
                                input.value = ''; // Direct JS clear
                                // Try native typing simulation if allowed, otherwise set value
                                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                                if (setter) {
                                    setter.call(input, 'MeetingAI Bot');
                                    input.dispatchEvent(new Event('input', { bubbles: true }));
                                    input.dispatchEvent(new Event('change', { bubbles: true }));
                                    input.dispatchEvent(new Event('blur', { bubbles: true })); // Trigger validation
                                } else {
                                    input.value = 'MeetingAI Bot';
                                }
                                if (input.value === 'MeetingAI Bot') return true;
                            } catch (e) { }
                        }
                        return false;
                    });

                    if (nameEntered) {
                        console.log('✅ Name set via JS injection (Nuclear option)');
                    } else {
                        console.log('⚠️ JS name entry failed, trying Puppeteer native typing...');
                        try {
                            // Focus any text input and type
                            await page.focus('input[type="text"]');
                            await page.keyboard.down('Control');
                            await page.keyboard.press('A');
                            await page.keyboard.up('Control');
                            await page.keyboard.press('Backspace');
                            await page.type('input[type="text"]', 'MeetingAI Bot', { delay: 100 });
                            console.log('✅ Name set via native typing fallback');
                        } catch (err) {
                            console.log('❌ All name entry strategies FAILED');
                        }
                    }

                    if (!nameEntered) {
                        // Diagnostic screenshot after typing attempts
                        await page.screenshot({ path: path.resolve(debugPath, 'after-name-entry.png') });

                        // Dump HTML for debugging if still suspicious
                        const html = await page.content();
                        fs.writeFileSync(path.resolve(debugPath, 'page_dump.html'), html);
                        console.log('📄 Saved HTML dump and screenshot for debugging');
                    }

                    await new Promise(r => setTimeout(r, 1000));
                } catch (e) {
                    console.log(`⚠️ Nuclear name entry error: ${e.message}`);
                }

                // Strategy 2: Find and click the "Join now" button on this modal
                let clickSuccess = false;
                for (let j = 0; j < 3; j++) {
                    clickSuccess = await page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('button'));
                        const joinBtn = buttons.find(b => {
                            const txt = b.innerText.trim().toLowerCase();
                            return txt === 'join now' || txt === 'join meeting';
                        });

                        if (joinBtn) {
                            joinBtn.click();
                            return true;
                        }
                        return false;
                    });

                    if (clickSuccess) {
                        log(`✅ Clicked SECOND "Join now" button (Attempt ${j + 1})`);
                        break;
                    } else {
                        console.log(`ℹ️ "Join now" button not found (Attempt ${j + 1}), waiting 3s...`);
                        await page.screenshot({ path: path.resolve(debugPath, `join-modal-attempt-${j + 1}.png`) });
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }

                if (clickSuccess) {
                    // START LISTENING IMMEDIATELY (Don't wait for confirmation)
                    log('🎤 Starting LISTEN MODE immediately...');
                    const recordingStartTime = Date.now();
                    sendIPC('recording-start', { timestamp: recordingStartTime });

                    await page.evaluate(async () => {
                        console.log('[EAR] Initializing Virtual Ear...');
                        const ctx = new (window.AudioContext || window.webkitAudioContext)();
                        const dest = ctx.createMediaStreamDestination();

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
                                        const source = ctx.createMediaStreamSource(stream);
                                        source.connect(dest);
                                        found++;
                                        console.log(`[EAR] Hooked participant stream: ${stream.id}`);
                                    } catch (err) { console.warn(`[EAR] Stream hook failed: ${err.message}`); }
                                }
                            });
                            if (found > 0) console.log(`[EAR] Total active streams: ${found}`);
                        };

                        const analyser = ctx.createAnalyser();
                        dest.connect(analyser);
                        analyser.fftSize = 256;
                        const dataArray = new Uint8Array(analyser.frequencyBinCount);

                        setInterval(() => {
                            analyser.getByteFrequencyData(dataArray);
                            let sum = 0;
                            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                            const avg = sum / dataArray.length;
                            if (avg > 0) console.log(`[EAR] Volume Level: ${Math.round(avg)} (GENUINE AUDIO)`);
                        }, 5000);

                        if (ctx.state === 'suspended') { await ctx.resume(); console.log('[EAR] Context Resumed'); }

                        setInterval(captureAudio, 5000);
                        captureAudio();

                        const stream = dest.stream;
                        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
                        const mediaRecorder = new MediaRecorder(stream, { mimeType });

                        mediaRecorder.ondataavailable = async (e) => {
                            if (e.data && e.data.size > 0) {
                                const reader = new FileReader();
                                reader.onload = () => window.sendAudioChunk(reader.result.split(',')[1]);
                                reader.readAsDataURL(e.data);
                            }
                        };
                        mediaRecorder.start(2000);
                        window.meetingMediaRecorder = mediaRecorder;
                        console.log(`[EAR] MediaRecorder active (${mimeType})`);
                    });

                    await new Promise(r => setTimeout(r, 3000));
                } else {
                    console.log('⚠️ Audio modal detected but no Join button found');
                }
            } else {
                console.log('ℹ️ No audio modal detected (may have auto-joined)');
            }
        } catch (e) {
            log(`⚠️ Join process error: ${e.message}`);
        }

        // --- STEP 4: STATE CONFIRMATION (LOBBY vs IN_MEETING vs TIMEOUT) ---
        console.log('🔍 Confirming join state...');
        await new Promise(r => setTimeout(r, 5000)); // Allow UI transition

        // Priority 1: Check for LOBBY (this is SUCCESS, not failure)
        const checkLobby = async () => {
            try {
                const lobbyIndicators = await page.$x(
                    "//*[contains(text(), \"let people know you're waiting\") or " +
                    "contains(text(), 'waiting to be admitted') or " +
                    "contains(text(), 'Someone will let you in shortly') or " +
                    "contains(text(), 'Please wait for the host')]"
                );
                return lobbyIndicators.length > 0;
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

                // DIAGNOSTIC: Save screenshot every 5 seconds
                const now = Date.now();
                if (now - lastScreenshotTime > 5000) {
                    try {
                        const screenshotName = `state-check-${checkCount}.png`;
                        await page.screenshot({ path: path.resolve(debugPath, screenshotName) });
                        console.log(`📸 Diagnostic screenshot: ${screenshotName}`);
                        lastScreenshotTime = now;
                    } catch (screenshotErr) {
                        console.log(`⚠️ Screenshot failed: ${screenshotErr.message}`);
                    }
                }

                try {
                    const inLobby = await checkLobby();
                    const inMeeting = await checkInMeeting();

                    // MODAL BUSTER (Side-channel): Clear any shims that might be blocking state detection
                    await page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('button'));
                        const busterBtn = buttons.find(b => {
                            const txt = b.innerText.toLowerCase();
                            return txt.includes('continue without audio or video') ||
                                txt.includes('dismiss') ||
                                txt.includes('got it');
                        });
                        if (busterBtn) busterBtn.click();
                    });

                    if (inLobby) {
                        console.log('✅ Lobby detected!');
                        finalState = 'IN_LOBBY';
                        break;
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
            console.log('❌ JOIN TIMEOUT: No lobby or meeting UI detected after 60s');
            console.log('⚠️ Likely cause: UI selector mismatch or authentication required');
            console.log('🔍 CHECK SCREENSHOTS in public/debug/ for visual proof');
            try {
                await page.screenshot({ path: path.resolve(debugPath, 'join-timeout-final.png') });
            } catch (e) { }
        }

        // --- STEP 5: LISTEN MODE (INGEST + MINIMAL) ---
        if (finalState === 'IN_MEETING' || finalState === 'IN_LOBBY') {
            console.log('🎤 Starting INGEST MODE (Minimal, Stable)...');

            await page.evaluate(async () => {
                try {
                    const ctx = new (window.AudioContext || window.webkitAudioContext)();
                    const destination = ctx.createMediaStreamDestination();

                    // Track captured elements to avoid double-connecting
                    const capturedElements = new WeakSet();

                    const captureAudioElements = () => {
                        const audioEls = document.querySelectorAll('audio');

                        audioEls.forEach(el => {
                            try {
                                if (el.srcObject && !capturedElements.has(el)) {
                                    const source = ctx.createMediaStreamSource(el.srcObject);
                                    source.connect(destination);
                                    capturedElements.add(el);
                                    console.log('[INGEST] Attached new audio element stream');
                                }
                            } catch (err) {
                                console.warn('[INGEST] Attach failed for element:', err.message);
                            }
                        });
                    };

                    // Poll every 3 seconds to catch new speakers/streams
                    setInterval(captureAudioElements, 3000);
                    captureAudioElements();

                    // Resume context if suspended (common in headless/autoplay scenarios)
                    if (ctx.state === 'suspended') {
                        await ctx.resume();
                        console.log('[INGEST] Audio Context Resumed');
                    }

                    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                        ? 'audio/webm;codecs=opus'
                        : 'audio/webm';

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

                    recorder.start(2000); // 2-second chunks
                    window.meetingMediaRecorder = recorder;

                    console.log(`[INGEST] MediaRecorder started (${mimeType})`);
                } catch (err) {
                    console.error('[INGEST] Failed to initialize:', err.message);
                }
            });
        }

        // --- STEP 6: KEEP ALIVE + SMART END DETECTION ---
        console.log('⏳ Bot active (Smart End Detection enabled)...');
        console.log('🔊 Transcription results and speaker detection active.');

        let lastTranscriptionSize = 0;
        let meetingEnded = false;

        const heartbeatInterval = setInterval(async () => {
            if (meetingEnded) return;

            sendIPC('heartbeat', {});

            // 1. SMART END DETECTION
            try {
                const isStillActive = await page.evaluate(() => {
                    const hangupBtn = document.querySelector('button[aria-label*="hang up" i], button[id*="hangup"], button[aria-label*="leave" i]');
                    const endedText = document.body.innerText.includes('Call ended') || document.body.innerText.includes('was removed');
                    const rejoinBtn = document.querySelector('button[aria-label*="rejoin" i]');

                    if (!hangupBtn || endedText || rejoinBtn) return false;
                    return true;
                });

                if (!isStillActive) {
                    console.log('🚩 Meeting end detected via UI signals.');
                    meetingEnded = true;
                    return;
                }
            } catch (e) {
                console.log('⚠️ Status check failed');
            }

            // SAFETY SWEEP: Ensure mic/cam didn't accidentally turn on
            try {
                await page.evaluate(() => {
                    const toolbarButtons = Array.from(document.querySelectorAll('button[aria-label*="camera" i], button[aria-label*="mic" i], button[aria-label*="mute" i]'));
                    toolbarButtons.forEach(btn => {
                        const label = (btn.ariaLabel || '').toLowerCase();
                        const isCurrentlyOn = btn.ariaPressed === 'true' || label.includes('turn off') || label.includes('mute');
                        if (isCurrentlyOn && !label.includes('turn on')) {
                            btn.click();
                        }
                    });
                });
            } catch (e) { }

            // PERIODIC STT TRIGGER: If file has grown, transcribe
            try {
                const stats = fs.statSync(RECORDING_PATH);
                // INCREASED SENSITIVITY: 20KB threshold for faster updates
                if (stats.size > lastTranscriptionSize + (1024 * 20)) {
                    log(`🤖 Updating transcript (${Math.round(stats.size / 1024)}KB recorded)...`);
                    const { transcribeAudio } = await import('../stt/service.js');
                    const result = await transcribeAudio(RECORDING_PATH);
                    if (result && (result.text || result.segments)) {
                        log(`📝 New Text Found (${result.segments?.length || 0} segments)`);

                        // Save locally for quick debug
                        fs.writeFileSync(TRANSCRIPT_PATH, result.text || '');

                        // Send full result to Manager for VTT conversion
                        sendIPC('transcript', result);
                        sendIPC('stt-success', { count: result.segments?.length });
                    }
                    lastTranscriptionSize = stats.size;
                }
                log(`📸 Active - monitoring meeting status...`);
            } catch (e) {
                log(`⚠️ Periodic task failed: ${e.message}`);
            }
        }, 30000); // Check every 30s

        // Wait until meeting ends or max timeout
        const maxTime = Date.now() + (120 * 60 * 1000); // 2 hours
        while (!meetingEnded && Date.now() < maxTime) {
            await new Promise(r => setTimeout(r, 5000));
        }

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

        // Trigger STT
        console.log('🤖 Triggering STT Transcription...');
        try {
            const { transcribeAudio } = await import('../stt/service.js');
            const result = await transcribeAudio(RECORDING_PATH);
            if (result && result.text) {
                fs.writeFileSync(TRANSCRIPT_PATH, result.text);
                console.log(`✅ STT Transcript generated: ${TRANSCRIPT_PATH}`);
                sendIPC('transcript', result.text);
            }
        } catch (sttErr) {
            console.error('❌ STT Transcription failed:', sttErr.message);
        }

        console.log('🔴 Bot shutting down gracefully...');

    } catch (err) {
        sendIPC('status', 'FAILED');
        console.error('❌ FATAL:', err.message);

        // CAPTURE FATAL ERROR SCREENSHOT
        try {
            const debugPath = path.resolve(process.cwd(), 'public', 'debug');
            if (!fs.existsSync(debugPath)) fs.mkdirSync(debugPath, { recursive: true });
            await page.screenshot({ path: path.resolve(debugPath, 'fatal-error.png') });
            console.log('📸 FATAL ERROR SCREENSHOT SAVED: fatal-error.png');
        } catch (e) {
            console.error('Failed to save fatal screenshot:', e);
        }

        // Don't take screenshot to avoid page close errors
        try {
            await browser.close();
        } catch (e) {
            // Browser already closed
        }
        process.exit(1);
    }
})();