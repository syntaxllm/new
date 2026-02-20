# Problem Statement: The "Silent Hallucination" Trap in Teams Audio Capture

## 1. The Core Conflict
We are building a Microsoft Teams Meeting Assistant (Bot + STT), but we are trapped in a dilemma where we must choose between **Total Silence** (missing data) or **Garbage Hallucinations**.

### Scenario A: VAD Enabled (The Void)
*   **Settings:** `vad_filter=True` in Faster-Whisper.
*   **Result:** The system filters out **everything**. Even clear speech is rejected.
*   **Logs:** `VAD returned 0 segments. Accepting as silence.`
*   **Hypothesis:** The audio captured by Puppeteer is too quiet (Low RMS) or the chunks are too short/fragmented for the VAD to trigger.

### Scenario B: VAD Disabled (The Hallucination)
*   **Settings:** `vad_filter=False`.
*   **Result:** The system transcribes **silence** as text.
*   **Symptoms:**
    *   "Thanks for watching"
    *   "Subtitles by..."
    *   "Copyright 2024"
    *   "Audio check"
*   **Impact:** The transcript is unusable due to noise.

## 2. The Failed "Normalization" Fix
We attempted to fix **Scenario A** by normalizing the audio volume before sending it to Whisper.
*   **Approach:** Use `librosa` / `soundfile` to read the WebM chunk, calculate RMS, and boost gain if it's too low.
*   **The Failure:**
    *   On Windows, `librosa.load(webm_file)` fails with `PySoundFile failed`.
    *   Fallback to `audioread` also fails or returns zeros.
    *   Result: `Audio RMS: 0.000000`. The system thinks the file is empty, skips normalization, and we are back to square one.

## 3. Architecture Overview
*   **Capture:**
    *   Node.js + Puppeteer (Headless Chrome).
    *   Technique: `AudioContext` hooking `HTMLMediaElement.prototype.play`.
    *   Format: `MediaRecorder` -> `audio/webm;codecs=opus`.
    *   Chunk Size: Increased to **12 seconds** (was 2s) to try and help VAD context.
*   **Processing:**
    *   FastAPI Server (Python).
    *   Model: `faster-whisper` (model: `turbo`).

## 4. Current working theory
The **Browser Audio Capture** is likely producing valid but **extremely low amplitude** audio, or the files are slightly malformed in a way that `librosa` hates but `ffmpeg` (used by Whisper) tolerates—barely.

## 5. What We Need
A way to **Reliably Detect Speech** in this specific audio stream without:
1.  Hallucinating on silence.
2.  Dropping valid (but quiet) speech.
3.  Crashing on Windows audio library incompatibilities.
