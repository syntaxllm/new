import os
import time
from typing import List, Optional
from fastapi import FastAPI, UploadFile, File, BackgroundTasks, Form
from pydantic import BaseModel
import torch
from faster_whisper import WhisperModel
import uuid
import sys

# Initialize FastAPI
app = FastAPI(title="MeetingAI STT Service")

print(f"🚀 STT Service Starting on Python {sys.version}")

# Load Whisper Model - Upgraded to 'turbo' for maximum accuracy/speed ratio
device = "cuda" if torch.cuda.is_available() else "cpu"
model_size = os.getenv("WHISPER_MODEL_SIZE", "turbo") # v3-turbo is the sweet spot
# Using float32 for CPU compatibility, int8_float16 or float16 for CUDA
compute_type = "float32" if device == "cpu" else "float16" 

model = WhisperModel(model_size, device=device, compute_type=compute_type)

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
        # 1. Transcribe with faster-whisper
        print(f"🎙️ Starting transcription for {meeting_id}...")
        segments, info = model.transcribe(
            file_path, 
            beam_size=5, 
            vad_filter=True, 
            vad_parameters=dict(min_silence_duration_ms=500),
            initial_prompt="This is a Microsoft Teams meeting transcript. Capture all participant names and technical terms accurately.",
            repetition_penalty=1.1 # Prevent looping on background noise
        )
        
        transcript_entries = []
        for segment in segments:
            # For now, speaker_id is a placeholder. 
            # In a full flow, this would come from diarization or UI metadata.
            speaker_id = "Meeting Participant" 
            
            transcript_entries.append(TranscriptEntry(
                start_time=segment.start,
                end_time=segment.end,
                speaker_id=speaker_id,
                text=segment.text.strip()
            ))
            # Immediate feedback in terminal
            print(f"[{segment.start:.2f}s -> {segment.end:.2f}s] {segment.text.strip()}")

        end_ts = time.time()
        print(f"✅ Transcribed {len(transcript_entries)} segments in {end_ts - start_ts:.2f}s")
        
        return TranscriptionResponse(
            meeting_id=meeting_id,
            status="completed",
            transcript=transcript_entries,
            duration=end_ts - start_ts,
            audio_path=filename
        )
        
    except Exception as e:
        print(f"❌ Transcription failed: {str(e)}")
        if os.path.exists(file_path):
            os.remove(file_path)
        raise e

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=4545)
