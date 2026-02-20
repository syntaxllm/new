
import os
import sys
import wave
import struct
import math
import json
import time

try:
    import requests
except ImportError:
    print("❌ 'requests' library not found. Please run: pip install requests")
    sys.exit(1)

from dotenv import load_dotenv

# Load .env
load_dotenv()
api_key = os.getenv("GROQ_API_KEY")

if not api_key:
    print("❌ GROQ_API_KEY not found in .env file.")
    sys.exit(1)

print(f"🔑 Found API Key: {api_key[:10]}...******")

def generate_sine_wave(filename="test_audio.wav", duration=1.0, freq=440.0):
    """Generates a simple 1-second sine wave audio file for testing."""
    sample_rate = 16000
    n_samples = int(sample_rate * duration)
    
    print(f"🎵 Generating test audio file: {filename} ({duration}s sine wave)...")
    
    with wave.open(filename, 'w') as wav_file:
        wav_file.setnchannels(1)  # Mono
        wav_file.setsampwidth(2)  # 2 bytes (16-bit)
        wav_file.setframerate(sample_rate)
        
        for i in range(n_samples):
            value = int(32767.0 * math.sin(2.0 * math.pi * freq * i / sample_rate))
            data = struct.pack('<h', value)
            wav_file.writeframesraw(data)
            
    return filename

def test_groq_transcription(audio_file):
    """Tests Groq's Audio API."""
    url = "https://api.groq.com/openai/v1/audio/transcriptions"
    
    headers = {
        "Authorization": f"Bearer {api_key}"
    }
    
    data = {
        "model": "whisper-large-v3-turbo", # Updated model name
        "response_format": "json"
    }
    
    print(f"🚀 Sending request to Groq API ({url})...")
    start_time = time.time()
    
    try:
        with open(audio_file, "rb") as f:
            files = {
                "file": (audio_file, f, "audio/wav")
            }
            response = requests.post(url, headers=headers, data=data, files=files)
            
        elapsed = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            print(f"✅ Success! ({elapsed:.2f}s)")
            print(f"📝 Transcript: \"{result.get('text', '')}\"")
            print("--------------------------------------------------")
            print("Groq API is working correctly.")
            return True
        else:
            print(f"❌ Failed (Status {response.status_code}):")
            print(response.text)
            return False
            
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        return False

if __name__ == "__main__":
    wav_path = "test_groq_audio.wav"
    try:
        generate_sine_wave(wav_path)
        test_groq_transcription(wav_path)
    finally:
        if os.path.exists(wav_path):
            os.remove(wav_path)
            print(f"🗑️ Cleaned up {wav_path}")
