import os
import time
from typing import List, Optional
from fastapi import FastAPI, UploadFile, File, BackgroundTasks, Form
from pydantic import BaseModel
import torch
from faster_whisper import WhisperModel
# from pyannote.audio import Pipeline # Will need token
import uuid

import sys

app = FastAPI(title="MeetingAI STT Service")

print(f"🚀 STT Service Starting on Python {sys.version}")


# Load Whisper Model
# Using 'base' or 'small' for dev to be fast
device = "cuda" if torch.cuda.is_available() else "cpu"
model_size = os.getenv("WHISPER_MODEL_SIZE", "base")
model = WhisperModel(model_size, device=device, compute_type="float32")

class TranscriptEntry(BaseModel):
    start_time: float
    end_time: float
    speaker_id: str
    text: str

class TranscriptionResponse(BaseModel):
    meeting_id: str
    status: str
    transcript: List[TranscriptEntry]
    duration: float
    audio_path: Optional[str] = None

@app.get("/")
def root():
    return {"message": "MeetingAI STT Service is running!", "endpoints": ["/health", "/transcribe"]}

@app.get("/health")
def health():
    return {"status": "ok", "device": device, "model": model_size}

@app.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe(
    file: UploadFile = File(...), 
    meeting_id: Optional[str] = Form(None),
    speaker_names: Optional[str] = Form(None)
):
    if not meeting_id:
        meeting_id = str(uuid.uuid4())
    
    # Parse real speaker names if provided
    real_speakers = []
    if speaker_names:
        try:
            import json
            real_speakers = json.loads(speaker_names)
        except:
            pass

    start_ts = time.time()
    
    # Create recordings directory if not exists
    storage_dir = os.path.join(os.getcwd(), "recordings")
    os.makedirs(storage_dir, exist_ok=True)

    # Save file permanently
    filename = f"{meeting_id}_{int(time.time())}.wav"
    file_path = os.path.join(storage_dir, filename)
    
    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)
        print(f"📁 Received {len(content)} bytes. Saved to: {file_path}")
    
    try:
        # 1. Transcribe with faster-whisper + Silero VAD
        print(f"🎙️ Starting transcription for {meeting_id}...")
        segments, info = model.transcribe(
            file_path, 
            beam_size=5, 
            vad_filter=True, 
            vad_parameters=dict(min_silence_duration_ms=500)
        )
        
        transcript = []
        for segment in segments:
            # Map segment timestamp to the closest real speaker name from the log
            speaker_id = "SPEAKER_00"
            if real_speakers:
                # Find speaker active at this segment's start time
                # log: [{name, timestamp}, ...]
                current_speaker = "Unknown"
                # Use a simple heuristic: who was speaking MOST RECENTLY before this segment started?
                # Sort speakers by timestamp just in case
                sorted_speakers = sorted(real_speakers, key=lambda x: x['timestamp'])
                
                for entry in sorted_speakers:
                    if entry['timestamp'] <= segment.start + 1.0: # Add 1s buffer/overlap
                        current_speaker = entry['name']
                    else:
                        break
                speaker_id = current_speaker

            transcript.append(TranscriptEntry(
                start_time=segment.start,
                end_time=segment.end,
                speaker_id=speaker_id, 
                text=segment.text.strip()
            ))
            
        full_text = " ".join([t.text for t in transcript])
        print(f"✅ Transcribed {len(transcript)} segments. Text: {full_text[:100]}...")
        
        end_ts = time.time()
        
        return TranscriptionResponse(
            meeting_id=meeting_id,
            status="completed",
            transcript=transcript,
            duration=end_ts - start_ts,
            audio_path=filename # Return relative path
        )
    except Exception as e:
        print(f"❌ Transcription failed: {str(e)}")
        # Delete on error only
        if os.path.exists(file_path):
            os.remove(file_path)
        raise e

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=4545)
