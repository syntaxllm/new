import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

// Fix Unicode output for Windows - REMOVED to prevent crash in child_process
// if (process.platform === 'win32') {
//    process.stdout.setEncoding('utf8');
// }

const MEETING_URL = process.argv[2];

if (!MEETING_URL) {
    console.error("Please provide a Teams URL!");
    process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const RECORDINGS_DIR = path.resolve(process.cwd(), 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
const RECORDING_PATH = path.resolve(RECORDINGS_DIR, `meeting-${timestamp}.webm`);
const TRANSCRIPT_PATH = path.resolve(RECORDINGS_DIR, `transcript-${timestamp}.txt`);

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
            // We removed --use-fake-device-for-media-stream to stop the green screen
            '--disable-infobars',
            '--ignore-certificate-errors',
            '--disable-gpu',
            '--window-size=1920,1080',
            '--disable-dev-shm-usage',
            '--autoplay-policy=no-user-gesture-required'
        ]
    });

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();

    // Create a write stream for the audio data
    const audioStream = fs.createWriteStream(RECORDING_PATH);

    // Expose a function to the page to receive audio chunks
    await page.exposeFunction('sendAudioChunk', (chunkBase64) => {
        const buffer = Buffer.from(chunkBase64, 'base64');
        audioStream.write(buffer);
    });

    // Set viewport explicitly
    await page.setViewport({ width: 1920, height: 1080 });

    // EXPLICITLY GRANT PERMISSIONS (Fixes headless permission stalls)
    const context = browser.defaultBrowserContext();
    await context.overridePermissions('https://teams.microsoft.com', ['microphone', 'camera', 'notifications']);

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
                // Look for and close "Open in app" popups
                const openInAppBtn = await page.$('button:has-text("Open in app"), button:has-text("Open app")');
                if (openInAppBtn) {
                    console.log('✅ Closing "Open in app" popup');
                    await openInAppBtn.click();
                    await new Promise(r => setTimeout(r, 1000));
                }
            } catch (e) {
                // No popup found, continue
            }
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
                        const text = await page.evaluate(el => el.innerText, btn);
                        if (text.includes('Continue on this browser') || text.includes('Use the web app') || text.includes('Continue')) {
                            targetBtn = btn;
                            break;
                        }
                    } catch (e) {
                        // Element might be detached if page is navigating
                    }
                }

                if (targetBtn) {
                    console.log(`[${new Date().toISOString()}] ✅ Clicking "Continue" (Attempt ${i + 1})...`);

                    // Robust click with race condition handling
                    try {
                        await Promise.all([
                            page.evaluate(b => b.click(), targetBtn),
                            new Promise(r => setTimeout(r, 500)) // Small delay to allow click to register
                        ]);
                    } catch (e) {
                        console.log(`[${new Date().toISOString()}] ⚠️ Click interrupted (likely navigation):`, e.message);
                    }

                    // WAIT FOR NAVIGATION START (Optimized)
                    // Instead of blind sleep, we assume click worked and give it a moment
                    await new Promise(r => setTimeout(r, 5000));
                } else {
                    console.log(`[${new Date().toISOString()}] ℹ️ No "Continue" button visible yet (Attempt ${i + 1})... waiting`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            } catch (error) {
                console.log(`[${new Date().toISOString()}] ⚠️ Navigation/Context error in loop:`, error.message);
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        // --- STEP 2: PRE-JOIN SCREEN ---
        sendIPC('status', 'PRE_JOIN');
        console.log(`[${new Date().toISOString()}] 🔍 Waiting for Pre-Join Controls...`);
        try {
            // Increased timeout to 60s for slow loading
            await page.waitForSelector('input[data-tid="prejoin-display-name-input"]', { timeout: 60000 });
            console.log(`[${new Date().toISOString()}] ✅ Guest input found`);
        } catch (e) {
            console.log('⚠️ Timed out waiting for Pre-Join UI. Taking screenshot...');
            await page.screenshot({ path: 'recordings/debug-stuck-prejoin.png' });
            const bodyText = await page.evaluate(() => document.body.innerText);
            console.log('--- PAGE DUMP ---\n', bodyText, '\n-------------------');
            const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => b.innerText));
            console.log('Buttons found:', buttons);
        }

        const nameInput = await page.$('input[data-tid="prejoin-display-name-input"], input[id^="username"], input[type="text"]');
        if (nameInput) {
            console.log('✍️ Entering Name...');
            // Clear existing text if any (robust typing)
            await nameInput.click({ clickCount: 3 });
            await nameInput.press('Backspace');
            await nameInput.type('MeetingAI Bot');
            await new Promise(r => setTimeout(r, 1000));
        }

        // ... [Skipping to Step 3 Join Logic] ...

        // --- STEP 2.5: DISABLE CAMERA AND MIC (SILENT MODE) ---
        console.log('🔇 Disabling Camera and Mic...');
        try {
            // Updated selectors for Teams New UI
            const cameraBtn = await page.$('button[data-tid="toggle-video"], [aria-label*="camera" i], [aria-label*="video" i]');
            if (cameraBtn) {
                const isCameraOn = await page.evaluate(btn => {
                    const ariaPressed = btn.getAttribute('aria-pressed');
                    const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                    return ariaPressed === 'true' || ariaLabel.includes('turn off');
                }, cameraBtn);
                if (isCameraOn) {
                    await cameraBtn.click();
                    console.log('📷 Camera turned OFF');
                } else {
                    console.log('📷 Camera already OFF');
                }
            } else {
                console.log('📷 Camera button not found');
            }

            const micBtn = await page.$('button[data-tid="toggle-mute"], [aria-label*="microphone" i], [aria-label*="mute" i]');
            if (micBtn) {
                const isMicOn = await page.evaluate(btn => {
                    const ariaPressed = btn.getAttribute('aria-pressed');
                    const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                    return ariaPressed === 'true' || ariaLabel.includes('turn off') || ariaLabel.includes('mute');
                }, micBtn);
                if (isMicOn) {
                    await micBtn.click();
                    console.log('🎤 Microphone turned OFF');
                } else {
                    console.log('🎤 Microphone already OFF');
                }
            } else {
                console.log('🎤 Microphone button not found');
            }
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            console.log('⚠️ Could not toggle cam/mic:', e.message);
        }

        // --- STEP 3: JOIN (PRODUCTION-GRADE STRATEGY) ---
        sendIPC('status', 'JOINING');
        console.log('👆 Attempting to JOIN...');
        await new Promise(r => setTimeout(r, 3000)); // Allow media checks

        let joinClicked = false;

        // STRATEGY 1: Smart selector + robust click
        try {
            const joinButton = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                return buttons.find(b => {
                    const txt = b.innerText.trim().toLowerCase();
                    return txt === 'join now' || txt === 'join';
                }) || document.querySelector('button[data-tid="prejoin-join-button"]');
            });

            if (joinButton && joinButton.asElement()) {
                // Production click: focus + keyboard (bypasses React event issues)
                await joinButton.asElement().focus();
                await new Promise(r => setTimeout(r, 500));
                await page.keyboard.press('Enter');
                console.log('✅ Join initiated via Enter key');
                joinClicked = true;
            } else {
                // Fallback: evaluate click (direct DOM manipulation)
                joinClicked = await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const joinBtn = buttons.find(b => {
                        const txt = b.innerText.trim().toLowerCase();
                        return txt === 'join now' || txt === 'join';
                    });
                    if (joinBtn) {
                        joinBtn.click();
                        return true;
                    }
                    return false;
                });
                if (joinClicked) console.log('✅ Join initiated via fallback click');
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

        // --- STEP 3.5: HANDLE AUDIO SELECTION MODAL (CRITICAL FIX) ---
        // Teams shows a SECOND pre-join screen with audio options after first Join click
        console.log('🔍 Checking for audio selection modal...');
        await new Promise(r => setTimeout(r, 3000)); // Wait for modal to appear

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
                        console.log('❌ Nuclear name entry FAILED - DUMPING HTML');
                        // Use fs in Node context, not browser context
                        // We will return false here and handle dumping outside evaluate
                    }

                    if (!nameEntered) {
                        // Dump HTML for debugging
                        const fs = require('fs');
                        const html = await page.content();
                        fs.writeFileSync(path.resolve(debugPath, 'page_dump.html'), html);
                        console.log('📄 Saved HTML dump to public/debug/page_dump.html');
                    }

                    await new Promise(r => setTimeout(r, 1000));
                } catch (e) {
                    console.log(`⚠️ Nuclear name entry error: ${e.message}`);
                }

                // Strategy 2: Find and click the "Join now" button on this modal
                const clickSuccess = await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const joinBtn = buttons.find(b => {
                        const txt = b.innerText.trim().toLowerCase();
                        return txt === 'join now';
                    });

                    if (joinBtn) {
                        joinBtn.click();
                        return true;
                    }
                    return false;
                });

                if (clickSuccess) {
                    console.log('✅ Clicked SECOND "Join now" button (audio modal)');
                    await new Promise(r => setTimeout(r, 3000)); // Wait for join to process

                    // Take screenshot after clicking
                    try {
                        await page.screenshot({ path: path.resolve(debugPath, 'after-second-join.png') });
                        console.log('📸 Screenshot: after-second-join.png');
                    } catch (e) { }
                } else {
                    console.log('⚠️ Audio modal detected but no Join button found');
                }
            } else {
                console.log('ℹ️ No audio modal detected (may have auto-joined)');
            }
        } catch (e) {
            console.log(`⚠️ Audio modal handling error: ${e.message}`);
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
                    const hangup = document.querySelector('button[data-tid="call-hangup"]');
                    const leaveBtn = Array.from(document.querySelectorAll('button')).some(b => {
                        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                        return aria.includes('leave') || aria.includes('hang up');
                    });
                    const toolbar = document.querySelector('[data-tid="calling-roster"]') ||
                        document.querySelector('.meeting-action-bar') ||
                        document.querySelector('[aria-label="Meeting controls"]');
                    return !!(hangup || leaveBtn || toolbar);
                });
            } catch (e) {
                return false;
            }
        };

        // State detection loop (60s timeout)
        let finalState = 'UNKNOWN';
        const startTime = Date.now();
        const maxWait = 60000; // 60 seconds
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

        // --- STEP 5: LISTEN MODE (AUDIO RECORDING & STT) ---
        if (finalState === 'IN_MEETING' || finalState === 'IN_LOBBY') {
            console.log('🎤 Starting LISTEN MODE (Recording audio for STT)...');

            await page.evaluate(async () => {
                window.recordedChunks = [];

                // Helper to find audio stream
                const getMeetingAudioStream = async () => {
                    // Method 1: Capture tab audio via extension (not available here)
                    // Method 2: Capture via navigator.mediaDevices.getUserMedia (self-record)
                    // Method 3 (Best for Teams): Capture the audio from all <audio> elements
                    const ctx = new AudioContext();
                    const dest = ctx.createMediaStreamDestination();

                    const captureAudio = () => {
                        const audios = document.querySelectorAll('audio');
                        audios.forEach(audio => {
                            if (audio.srcObject && !audio.dataset.captured) {
                                audio.dataset.captured = 'true';
                                console.log('Captured audio element stream');
                                const source = ctx.createMediaStreamSource(audio.srcObject);
                                source.connect(dest);
                            }
                        });
                    };

                    // Polling to catch new audio elements (speakers joining)
                    setInterval(captureAudio, 5000);
                    captureAudio();

                    return dest.stream;
                };

                const stream = await getMeetingAudioStream();
                const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

                mediaRecorder.ondataavailable = async (event) => {
                    if (event.data.size > 0) {
                        const reader = new FileReader();
                        reader.onload = () => {
                            const base64 = reader.result.split(',')[1];
                            window.sendAudioChunk(base64);
                        };
                        reader.readAsDataURL(event.data);
                    }
                };

                mediaRecorder.start(1000); // 1 second chunks
                window.meetingMediaRecorder = mediaRecorder;
                console.log('MediaRecorder started');
            });
        }

        // --- STEP 6: KEEP ALIVE + INCREMENTAL TRANSCRIPTION ---
        console.log('⏳ Bot staying alive for 10 minutes (transcription mode)...');
        console.log('🔊 Transcription results will appear every 30 seconds');

        const keepAliveUntil = Date.now() + (10 * 60 * 1000); // 10 minutes from now
        let lastTranscriptionSize = 0;

        const heartbeatInterval = setInterval(async () => {
            const remaining = Math.floor((keepAliveUntil - Date.now()) / 1000);
            if (remaining > 0) {
                sendIPC('heartbeat', {});

                // PERIODIC STT TRIGGER: If file has grown, transcribe the whole thing to update results
                // Faster-whisper is fast enough to handle 10min files repeatedy
                try {
                    const stats = fs.statSync(RECORDING_PATH);
                    if (stats.size > lastTranscriptionSize + (1024 * 50)) { // Every ~50KB (~10-20s of audio)
                        console.log('🤖 Updating transcript from latest audio...');
                        const { transcribeAudio } = await import('../stt/service.js');
                        const result = await transcribeAudio(RECORDING_PATH);
                        if (result && result.text) {
                            console.log(`📝 TRANSCRIPT (Update): ${result.text.substring(0, 100)}...`);
                            fs.writeFileSync(TRANSCRIPT_PATH, result.text);
                            sendIPC('transcript', result.text);
                        }
                        lastTranscriptionSize = stats.size;
                    }
                } catch (e) {
                    // Silently fail if file busy
                }

                console.log(`📸 Bot active - ${remaining}s remaining...`);
            }
        }, 15000); // Check every 15s

        // Wait for 10 minutes
        await new Promise(r => setTimeout(r, 10 * 60 * 1000));

        clearInterval(heartbeatInterval);

        // Save transcript if any
        if (transcriptLines.length > 0) {
            const transcriptPath = path.resolve(debugPath, 'transcript.txt');
            fs.writeFileSync(transcriptPath, transcriptLines.join('\n'));
            console.log(`📄 Transcript saved to ${transcriptPath}`);
        } else {
            console.log('ℹ️ No captions captured (live captions may not be enabled)');
        }

        console.log('✅ Transcription period complete');

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
