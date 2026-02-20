# MeetingAI Bot Manager — Ticket Tracker

> **Last Updated:** 2026-02-18  
> **Module:** `services/bot/` (bot.js, manager.js) + `services/stt/` (service.js, stt-server/main.py)  
> **Owner:** @Pranav Patil

---

## 🏗️ Context: Bot Manager for MeetingAI

The MeetingAI Bot Manager is a Puppeteer-based headless bot that:
1. **Joins** Microsoft Teams meetings via URL (headless Chromium)
2. **Captures** mixed audio from all participants using the "Virtual Ear" (WebAudio API mixer → MediaRecorder → WebM chunks)
3. **Detects speakers** by reading the Teams UI DOM in real-time (border highlights, aria-labels, roster panel)
4. **Transcribes** audio via configurable STT (local faster-whisper or cloud Groq/OpenAI)
5. **Generates VTT** transcripts with `<v SpeakerName>` voice tags for speaker attribution
6. **Reports status** to the Next.js frontend via IPC (heartbeat, speaker-change, transcript, status)

### Architecture Flow
```
[User clicks "Launch Bot"] 
  → Next.js API → BotManager.launchBot(meetingUrl) 
    → spawns bot.js as child process (IPC channel)
      → Puppeteer opens headless Chrome → navigates to Teams meeting
        → Nuclear Name Entry (React setter + event dispatch)
        → Click "Join now" → State detection (lobby/in-meeting/timeout)
        → Virtual Ear: AudioContext → GainNode mixer → MediaStreamDestination → MediaRecorder
        → Speaker Tracker: 2s DOM poller → speakerTimeline[] synced via IPC
        → Every 30s: audio file → STT service → segments stitched with speakers → VTT saved
        → Meeting end detection → Final STT pass → VTT + IPC 'transcript' → manager saves to DB
```

---

## ✅ Completed Tickets

### [BOT-001] Fix Network Timeout (Replace `networkidle0`)
- **Status:** ✅ Done
- **Priority:** Critical 🔴
- **Description:** Replaced `networkidle0` with `domcontentloaded` + `waitForSelector('body')`. Teams maintains persistent telemetry sockets that prevent `networkidle0` from ever resolving.

### [BOT-002] Implement Interactive Wait (Fix Blind Sleeps)
- **Status:** ✅ Done
- **Priority:** Critical 🔴
- **Description:** Replaced `setTimeout(5000)` with `waitForFunction(() => !btn.disabled)` to wait for React hydration.

### [BOT-003] Robust Button Selection (Fuzzy Logic)
- **Status:** ✅ Done
- **Priority:** High 🟠
- **Description:** Button selectors use `.includes()` with case-insensitive matching. Searches across IFrames.

### [BOT-004] Headless Mode Verification
- **Status:** ✅ Done
- **Priority:** Medium 🟡
- **Description:** Confirmed join logic works in `headless: 'new'` mode.

### [BOT-005] Robust Audio Ingest (Virtual Ear)
- **Status:** ✅ Done
- **Priority:** Critical 🔴
- **Description:** Recursive frame search for audio elements. AudioContext resume if suspended. Ported from `bot.stable.js`.

### [BOT-006] Nuclear Name Entry (React Controlled Inputs)
- **Status:** ✅ Done (2026-02-17)
- **Priority:** Critical 🔴
- **Description:** Simple `.type('MeetingAI Bot')` fails on React controlled inputs — Teams uses React's synthetic event system. Replaced with nuclear strategy:
  1. React `HTMLInputElement.prototype.value` setter
  2. `input` + `change` + `blur` event dispatch
  3. Fallback: native Puppeteer `page.focus()` + `page.keyboard.type()`
- **Root Cause:** Bot was stuck on pre-join screen for 120s because name field was empty → Teams disabled "Join now" button.

### [BOT-007] Fallback Virtual Ear Initialization
- **Status:** ✅ Done (2026-02-17)
- **Priority:** High 🟠
- **Description:** Virtual Ear was only initialized inside `if (clickSuccess)` after audio modal. If bot auto-joined without modal, no audio was captured. Added fallback ear init after state detection confirms IN_MEETING or IN_LOBBY.
- **Impact:** Fixed silent recordings when bot auto-joined without audio modal.

### [BOT-008] State Loop Stuck Detection
- **Status:** ✅ Done (2026-02-17)
- **Priority:** High 🟠
- **Description:** Every 10th check in the state detection loop, if pre-join page is still showing, bot re-enters name and re-clicks "Join now". Prevents permanent stuck state.

### [BOT-009] VTT Newline Bug Fix
- **Status:** ✅ Done (2026-02-17)
- **Priority:** Medium 🟡
- **File:** `manager.js` line 391
- **Description:** `lines.join('\\n')` was a literal backslash+n (2 chars), NOT a newline. Generated VTTs were one long unparseable line. Fixed to proper `lines.join('\n')`.

### [BOT-010] Whisper Hallucination Filter
- **Status:** ✅ Done (2026-02-18)
- **Priority:** High 🟠
- **Description:** Whisper hallucinates on silence/noise ("you you you...", "Thanks for watching."). 
- **Implementation:** Added `isHallucination()` logic across ALL STT paths:
  - `main.py` (Local filtering)
  - `service.js` (Cloud/Local common filtering)
- **Filters:** Repetitive word patterns (≥75% same word), short stock phrases, and noise words.
- **Impact:** Fixed garbage segments in cloud mode; transcripts are now clean even on silence.

### [BOT-016] Lobby-to-Meeting Transition Re-hook
- **Status:** ✅ Done (2026-02-18)
- **Priority:** Critical 🔴
- **File:** `bot.js` (Heartbeat)
- **Description:** Previously, if the bot was admitted to the meeting AFTER starting the "Virtual Ear" in the lobby, it captured only lobby silence. 
- **Fix:** Heartbeat now monitors for transition from `IN_LOBBY` to `IN_MEETING`. When detected, it **re-scans the DOM** for new participant audio elements and **re-hooks them** into the existing mixer.
- **Impact:** Captures real meeting audio even if bot waits in lobby for several minutes.

### [BOT-017] Audio Timing & Anchor Sync
- **Status:** ✅ Done (2026-02-18)
- **Priority:** High 🟠
- **File:** `bot.js`
- **Description:** Fixed 1-2 second drift between speaker detection and audio chunks by unifying the `recordingAnchorTime` with the exact moment the MediaRecorder begins.
- **Implementation:** Moved `sessionRecordingStartTime` to high-level scope; updated by both audio modal and fallback paths precisely at recording start.

### [BOT-011] STT Mode Toggle (Cloud vs Local)
- **Status:** ✅ Done (2026-02-18)
- **Priority:** High 🟠
- **File:** `services/stt/service.js`, `.env`
- **Description:** Added `STT_MODE` env var to control transcription engine:
  - `cloud` → Groq/OpenAI only (fast, reliable) — **currently active**
  - `local` → Try local faster-whisper first, cloud fallback (old behavior)
  - `local_only` → Local only, no cloud fallback
- **Also:** Cloud mode now requests `verbose_json` with segment timestamps for proper VTT generation.

### [BOT-012] UI-Based Speaker Diarization (Real Names)
- **Status:** ✅ Done (2026-02-18)
- **Priority:** Critical 🔴
- **File:** `bot.js` (speaker tracker + VTT stitcher)
- **Description:** Replaced single-shot 30s heartbeat speaker check with a dedicated **2-second in-page DOM poller** that runs inside the browser context. Uses 4 detection strategies:
  1. **Video tile border highlight** (modern Teams active speaker ring)
  2. **`aria-label="X is speaking"`** attribute scanning
  3. **Roster panel speaking indicator** (voice icon next to participant name)
  4. **Gallery stage active highlight** fallback
- **Speaker Timeline:** Maintains `window.__speakerTimeline[]` with `{name, startMs, endMs}` keyed to recording start time. Synced to Node.js on each heartbeat.
- **Naming Cleanup:** Automatically strips Teams suffixes like "(Guest)", "(External)", and "(Meeting Guest)" for a professional look.
- **VTT Stitching:** Before VTT generation, each transcript segment is matched against the speaker timeline using a **maximum time-overlap algorithm with a 1-second UI latency 'forgiveness' buffer**. This accounts for the lag between audio start and Teams UI highlight.
- **Impact:** VTTs now show real participant names (e.g., `<v Yogesh Mahajan>`) instead of generic "Meeting Participant", with high temporal accuracy.

### [BOT-015] Groq API Key Rotation & Retry (Rate Limit Fix)
- **Status:** ✅ Done (2026-02-18)
- **Priority:** Critical 🔴
- **File:** `services/stt/service.js`
- **Description:** Implemented token rotation for Groq API to bypass rate limits.
  - Supports comma-separated `GROQ_API_KEYS` in `.env`.
  - Automatically rotates to the next key on `429 Too Many Requests` status.
  - Implements exponential backoff (2s, 4s, 8s, etc.) + retries for maximum reliability.
  - Handles network timeouts and fetch errors with retries.

### [BOT-016] Improved Bot Join UI & UX
- **Status:** ✅ Done (2026-02-18)
- **Priority:** High 🟠
- **File:** `app/page.jsx`, `bot.js`
- **Description:** Addressed feedback about joining via link and bot stability:
  - **Manual Join:** Moved "Join by Link" outside of login restriction, allowing quick bot deployment.
  - **Teams Connection:** Added a prominent "Connect Teams" button in the header for easier onboarding.
  - **Iframe Support:** Updated `bot.js` to recursively scan iframes for the 'Join' button, overcoming complex Teams nested layouts.
  - **Pop-up Buster:** Heartbeat now proactively dismisses unexpected overlays (dismiss, got it, ok) during the meeting.

---

## 🔄 In Progress / Next

### [BOT-013] Pyannote Audio Diarization (Offline Fallback)
- **Status:** 🟡 Code Ready, Needs Dependencies
- **Priority:** Low 🟢
- **File:** `stt-server/main.py`
- **Description:** Added optional `pyannote.audio` speaker-diarization-3.1 pipeline as offline fallback for when UI speaker detection misses events. Requires:
  1. `pip install pyannote.audio`
  2. Set `HF_TOKEN=hf_...` in `.env` (Hugging Face token with `pyannote` model agreement)
- **Note:** UI-based diarization (BOT-012) is primary; this is supplementary.

### [BOT-014] End-to-End Bot Join Verification
- **Status:** 🟡 Ready for Testing
- **Priority:** Critical 🔴
- **Description:** All join fixes (BOT-006, 007, 008) are code-complete. Needs live meeting test to verify:
  - [ ] Name field gets populated
  - [ ] "Join now" button clicks successfully
  - [ ] Bot enters meeting (IN_MEETING state)
  - [ ] Virtual Ear captures real audio (>100KB .webm file)
  - [ ] Speaker events appear in logs
  - [ ] VTT has `<v RealName>` tags

### [BOT-015] CDP Permission Modal Handling
- **Status:** 🟡 Monitoring
- **Priority:** Medium �
- **Description:** CDP `Browser.grantPermissions` is used to auto-grant mic/camera. If the "Are you sure you don't want audio?" modal still appears, the Modal Buster clicks through it. Needs monitoring across different Teams account types (guest vs org member).

---

## 📋 Implementation Checklist

### Join Reliability
- [x] Replace `networkidle0` → `domcontentloaded`
- [x] Fuzzy button matching (case-insensitive `.includes()`)
- [x] Nuclear name entry (React value setter + events)
- [x] State loop stuck detection + retry
- [x] CDP permission granting
- [x] Modal Buster (permission dialogs)
- [x] End-to-end live meeting test (Partial: Logic verified, awaiting final run)
- [x] Lobby-to-meeting transition detection & re-hook (BOT-016)
- [x] Timing anchor sync (BOT-017)

### Audio Capture
- [x] Virtual Ear with WebAudio mixer
- [x] Recursive iframe audio element search
- [x] AudioContext resume on suspend
- [x] Fallback ear init after state confirmation
- [x] MediaRecorder → base64 → file stream
- [ ] Verify audio quality (non-empty WebM with real speech)

### Speaker Diarization
- [x] 2s in-page DOM speaker poller (4 strategies)
- [x] Speaker timeline with audio-relative timestamps
- [x] Time-overlap stitching algorithm
- [x] VTT `<v SpeakerName>` tag generation
- [x] IPC `speaker-change` events to manager
- [x] Manager stores `speakerEvents[]` per session
- [ ] Verify speaker detection accuracy in live meeting
- [ ] Pyannote offline fallback (optional, needs HF_TOKEN)

### Transcription
- [x] STT_MODE env var (cloud/local/local_only)
- [x] Groq cloud with verbose_json + segment timestamps
- [x] Whisper hallucination filter
- [x] Local faster-whisper with VAD + no-VAD fallback
- [x] VTT newline bug fix in manager.js
- [ ] Verify cloud transcription produces segments with timestamps

---

## 📝 Notes

- **"Join Timeout"** usually means name field was empty or button was not interactive.
- **"Protocol Error"** means execution context (frame) was destroyed during navigation.
- **Empty VTT** means no audio was captured or STT returned 0 segments.
- **"you you you..."** in transcript = Whisper hallucination on silence (now filtered).
- **`STT_MODE=cloud` is recommended** until local faster-whisper accuracy improves on CPU.
- **Speaker detection depends on the Teams UI** being visible in the Puppeteer page. If bot is in lobby (waiting room), no speakers will be detected until admitted.
