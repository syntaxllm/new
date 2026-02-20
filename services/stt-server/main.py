import os
import time
from typing import List, Optional
from fastapi import FastAPI, UploadFile, File, Form
from pydantic import BaseModel
import torch
from faster_whisper import WhisperModel
import uuid
import sys
from dotenv import load_dotenv
import subprocess
import wave
import tempfile
import numpy as np

# Load environment variables
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), '.env'))

# Ensure FFmpeg is in the PATH for this process
FFMPEG_PATH = r"C:\Users\PRANAV PATIL\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.0.1-full_build\bin"
os.environ["PATH"] = FFMPEG_PATH + os.pathsep + os.environ.get("PATH", "")

# Initialize FastAPI
app = FastAPI(title="MeetingAI STT Service")

print(f"🚀 STT Service Starting on Python {sys.version}")

# Load Whisper Model - Upgraded to 'turbo' for maximum accuracy/speed ratio
device = "cuda" if torch.cuda.is_available() else "cpu"
model_size = os.getenv("WHISPER_MODEL_SIZE", "turbo") # v3-turbo is the sweet spot
# Using float32 for CPU compatibility, int8_float16 or float16 for CUDA
compute_type = "float32" if device == "cpu" else "float16" 

print(f"📦 Loading Whisper model '{model_size}' on {device} ({compute_type})...")
model = WhisperModel(model_size, device=device, compute_type=compute_type)
print("✅ Whisper model loaded successfully")

class TranscriptEntry(BaseModel):
    start_time: float
    end_time: float
    speaker_id: str
    text: str

class TranscriptionResponse(BaseModel):
    meeting_id: str
    status: str
    transcript: List[TranscriptEntry]
    text: str = ""  # Full concatenated text for quick access
    duration: float
    audio_path: Optional[str] = None

@app.get("/")
def root():
    return {"message": "MeetingAI STT Service is running!", "endpoints": ["/health", "/transcribe"]}

@app.get("/health")
def health():
    return {"status": "ok", "device": device, "model": model_size}

def convert_and_normalize(input_path: str) -> str:
    """Converts WebM to 16kHz mono WAV and normalizes loudness using FFmpeg."""
    try:
        output_path = input_path.replace(".webm", ".wav")
        # FFmpeg command: Convert to 16k mono WAV (Standard for Whisper)
        # REMOVED loudnorm for live chunks to prevent distortion on short segments
        cmd = [
            "ffmpeg", "-y",
            "-i", input_path,
            "-ac", "1",
            "-ar", "16000",
            output_path
        ]
        # Run FFmpeg silently
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return output_path
    except subprocess.CalledProcessError as e:
        print(f"❌ FFmpeg conversion failed: {e}")
        return None

def get_rms_energy(wav_path: str) -> float:
    # Kept for debugging/logging, but not used for gating anymore
    try:
        with wave.open(wav_path, 'rb') as wf:
            frames = wf.readframes(wf.getnframes())
            if not frames:
                return 0.0
            samples = np.frombuffer(frames, dtype=np.int16)
            if len(samples) == 0:
                return 0.0
            rms = np.sqrt(np.mean(samples.astype(np.float64)**2))
            return rms
    except:
        return 0.0

def is_hallucination(text: str) -> bool:
    """Detect common Whisper hallucination patterns on silence/noise."""
    text = text.strip()
    if not text or len(text) < 2:
        return True
    
    # Shared Hallucination Set - RELAXED
    HARD_HALLUCINATIONS = {
        'thanks for watching', 'thank you for watching', 'subscribe', 
        'like and subscribe', 'bye', 'goodbye', 'see you next time', 
        'the end', 'music', 'applause', 'laughter', 'silence',
        'thanks for listening', 'thank you very much',
        'please subscribe', 'you you', 'you you you',
        'subtitles', 'captioned by', 'copyright', 'all rights reserved', 
        'no audio'
    }

    clean = "".join(c for c in text if c.isalnum() or c.isspace()).lower().strip()
    if not clean:
        return True
    
    for phrase in HARD_HALLUCINATIONS:
        if phrase in clean:
            return True

    words = clean.split()
    if len(words) >= 3:
        unique_words = set(words)
        if len(unique_words) == 1:
            return True
        for w in unique_words:
            if words.count(w) / len(words) >= 0.8:
                return True

    return False

# Global Session Stats for "Smart Terminal"
session_stats = {}

@app.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe(
    file: UploadFile = File(...), 
    meeting_id: Optional[str] = Form(None),
    speaker_names: Optional[str] = Form(None)
):
    if not meeting_id:
        meeting_id = f"anon-{str(uuid.uuid4())[:8]}"
    
    # Initialize session stats if new
    if meeting_id not in session_stats:
        print(f"\n✨ [NEW SESSION] Detected bot: {meeting_id}")
        session_stats[meeting_id] = {"count": 0, "total_duration": 0.0}
    
    session_stats[meeting_id]["count"] += 1
    batch_num = session_stats[meeting_id]["count"]
    
    start_ts = time.time()
    
    # Create recordings directory if not exists
    storage_dir = os.path.join(os.getcwd(), "recordings")
    os.makedirs(storage_dir, exist_ok=True)

    # Save file temporarily
    filename = f"{meeting_id}_{int(time.time())}.webm"
    file_path = os.path.join(storage_dir, filename)
    
    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)
    
    # FFmpeg Conversion (No Loudnorm)
    normalized_path = convert_and_normalize(file_path)
    if not normalized_path:
        print(f"⚠️ [{meeting_id}] FFmpeg failed. Using original.")
        normalized_path = file_path
    
    try:
        print(f"🎙️ [{meeting_id}] Processing Batch #{batch_num}...", end="\r")
        
        # Transcribe with faster-whisper WITH VAD
        segments, info = model.transcribe(
            normalized_path, 
            beam_size=5, 
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
            initial_prompt="This is a meeting transcript. The speakers are discussing technical details.",
            condition_on_previous_text=False,
            repetition_penalty=1.1,
            temperature=0.0
        )
        
        segments_list = list(segments)
        transcript_entries = []
        snippet = ""
        
        for segment in segments_list:
            text = segment.text.strip()
            if is_hallucination(text):
                continue
            
            transcript_entries.append(TranscriptEntry(
                start_time=segment.start,
                end_time=segment.end,
                speaker_id="Meeting Participant",
                text=text
            ))
            if not snippet: snippet = text

        end_ts = time.time()
        process_time = end_ts - start_ts
        audio_dur = info.duration
        
        # Update Stats
        session_stats[meeting_id]["total_duration"] += audio_dur
        
        # Smart Log Output
        full_text = ' '.join(e.text for e in transcript_entries)
        if transcript_entries:
            print(f"✅ [{meeting_id}] Batch #{batch_num} ({audio_dur:.1f}s audio / {process_time:.2f}s proc) -> \"{snippet[:40]}...\"")
        else:
            print(f"💤 [{meeting_id}] Batch #{batch_num} (Silence/No Speech) - {process_time:.2f}s proc")

        return TranscriptionResponse(
            meeting_id=meeting_id,
            status="completed",
            transcript=transcript_entries,
            text=full_text,
            duration=info.duration,
            audio_path=filename
        )
        
    except Exception as e:
        print(f"❌ [{meeting_id}] Error: {str(e)}")
        raise e

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=4545)
