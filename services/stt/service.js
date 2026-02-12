/**
 * Speech-to-Text (STT) Service
 * 
 * Implements a two-stage transcription pipeline:
 * 1. Local transcription via faster-whisper (STT_SERVICE_URL)
 * 2. Cloud fallback via OpenAI Whisper or Groq Whisper
 */

import fs from 'fs';
import path from 'path';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const STT_SERVICE_URL = process.env.STT_SERVICE_URL || 'http://localhost:4545';

/**
 * Transcribe audio using a multi-stage approach:
 * 1. Try local STT service (faster-whisper)
 * 2. Fallback to Cloud/API (OpenAI or Groq)
 */
export async function transcribeAudio(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    // --- STAGE 1: LOCAL TRANSCRIPTION ---
    console.log(`[STT Service] STAGE 1: Attempting local transcription at ${STT_SERVICE_URL}...`);
    try {
        const formData = new FormData();
        const fileBuffer = fs.readFileSync(filePath);
        const fileName = path.basename(filePath);
        const blob = new Blob([fileBuffer], { type: 'audio/webm' });
        formData.append('file', blob, fileName);

        const response = await fetch(`${STT_SERVICE_URL}/transcribe`, {
            method: 'POST',
            body: formData,
            // REMOVED timeout to allow for long audio processing
        });

        if (response.ok) {
            const result = await response.json();
            console.log('✅ Local transcription successful');

            // Map segments for easy VTT generation
            let segments = [];
            if (result.transcript && Array.isArray(result.transcript)) {
                segments = result.transcript.map(t => ({
                    start: t.start_time,
                    end: t.end_time,
                    speaker: t.speaker_id || 'Meeting Participant',
                    text: t.text
                }));
            }

            return {
                text: result.text || segments.map(s => s.text).join(' '),
                segments: segments, // Pass raw segments for VTT generation
                language: result.language || 'en',
                duration: result.duration || 0,
                method: 'local'
            };
        }
        console.warn(`[STT Service] Local service returned ${response.status}: ${await response.text()}`);
    } catch (localErr) {
        console.log(`[STT Service] Local transcription error: ${localErr.message}. Falling back to Cloud.`);
    }

    // --- STAGE 2: CLOUD TRANSCRIPTION (OpenAI/Groq) ---
    console.log(`[STT Service] STAGE 2: Attempting cloud transcription...`);

    // Preference: OpenAI API if key available, else Groq
    const useOpenAI = !!OPENAI_API_KEY && !OPENAI_API_KEY.includes('your_openai_api_key_');
    const apiKey = useOpenAI ? OPENAI_API_KEY : GROQ_API_KEY;
    const apiUrl = useOpenAI
        ? 'https://api.openai.com/v1/audio/transcriptions'
        : 'https://api.groq.com/openai/v1/audio/transcriptions';
    const modelName = useOpenAI ? 'whisper-1' : 'whisper-large-v3';

    if (!apiKey || apiKey.includes('your_')) {
        throw new Error('No Cloud API key configured for STT Stage 2 (check OPENAI_API_KEY or GROQ_API_KEY)');
    }

    try {
        const formData = new FormData();
        const fileBuffer = fs.readFileSync(filePath);
        const fileName = path.basename(filePath);
        const blob = new Blob([fileBuffer], { type: 'audio/webm' });

        formData.append('file', blob, fileName);
        formData.append('model', modelName);
        formData.append('response_format', 'json');

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            body: formData
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Cloud API error (${response.status}): ${errorText}`);
        }

        const result = await response.json();
        console.log(`✅ Cloud transcription successful using ${useOpenAI ? 'OpenAI' : 'Groq'}`);
        return {
            text: result.text || '',
            language: result.language || 'en',
            duration: result.duration || 0,
            method: useOpenAI ? 'openai' : 'groq'
        };
    } catch (cloudErr) {
        console.error('[STT Service] Cloud transcription failed:', cloudErr.message);
        throw cloudErr;
    }
}

/**
 * Transcribe audio in real-time chunks (for streaming)
 */
export async function transcribeChunk(audioBuffer) {
    // For real-time streaming, we'd use WebSocket-based STT
    // This is a placeholder for future implementation
    console.log('[STT Service] Real-time chunk transcription not yet implemented');
    return { text: '', isPartial: true };
}
