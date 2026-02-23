/**
 * Speech-to-Text (STT) Service
 * 
 * Implements a configurable transcription pipeline:
 * 
 * ENV: STT_MODE controls which engine is used:
 *   - "local"      (default) → Try local faster-whisper first, fallback to cloud
 *   - "cloud"      → Skip local, go straight to OpenAI/Groq cloud API
 *   - "local_only" → Local only, no cloud fallback
 */

import fs from 'fs';
import path from 'path';

/**
 * Hallucination Filter for Whisper STT
 * Whisper frequently hallucinates repetitive/stock phrases on silence or noise.
 * This filter runs on BOTH cloud and local results.
 */
const HALLUCINATION_PHRASES = new Set([
    'thanks for watching', 'thank you for watching', 'subscribe',
    'like and subscribe', 'see you next time', 'the end',
    'music', 'applause', 'laughter', 'silence',
    'meeting transcript', 'this is a meeting transcript', 'no audio',
    "i'm going to ask you a question"
]);

const SINGLE_WORD_HALLUCINATIONS = new Set([
    'you', 'thanks', 'bye', 'goodbye', 'hello', 'you.'
]);

function isHallucination(text) {
    if (!text || typeof text !== 'string') return true;
    const clean = text.replace(/[.,!?;:'"()\[\]{}]/g, '').trim().toLowerCase();
    if (!clean || clean.length < 2) return true;

    // 1. Exact match for risky single words
    if (SINGLE_WORD_HALLUCINATIONS.has(clean)) return true;

    // 2. Phrase substrings
    for (const phrase of HALLUCINATION_PHRASES) {
        if (clean.includes(phrase)) return true;
    }

    const words = clean.split(/\s+/);
    // 3. Repetitive single-word noise (e.g., "you you you")
    if (words.length >= 2) {
        const uniqueWords = new Set(words);
        if (uniqueWords.size === 1 && SINGLE_WORD_HALLUCINATIONS.has(words[0])) return true;
    }

    // 4. High overlap/repetition (stuttering hallucinations)
    if (words.length >= 3) {
        const uniqueWords = new Set(words);
        for (const w of uniqueWords) {
            const count = words.filter(x => x === w).length;
            if (count / words.length >= 0.8) return true;
        }
    }

    return false;
}

/**
 * Filter segments to remove hallucinated content
 */
function filterSegments(segments) {
    const before = segments.length;
    const filtered = segments.filter(s => !isHallucination(s.text));
    const removed = before - filtered.length;
    if (removed > 0) {
        console.log(`[STT Service] 🧹 Hallucination filter: removed ${removed}/${before} segments`);
    }
    return filtered;
}

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const STT_SERVICE_URL = process.env.STT_SERVICE_URL || 'http://127.0.0.1:4545';
const rawGroqKeys = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '';
const GROQ_API_KEYS = rawGroqKeys.split(',').map(k => k.trim()).filter(Boolean);
let currentApiKeyIndex = 0;
const STT_MODE = (process.env.STT_MODE || 'local').toLowerCase().trim(); // 'local' | 'cloud' | 'local_only'

console.log(`[STT Service] Mode: ${STT_MODE.toUpperCase()} | Local URL: ${STT_SERVICE_URL}`);

/**
 * Cloud transcription helper (OpenAI or Groq)
 */
async function cloudTranscribe(filePath, retryCount = 0, forceOpenAI = false) {
    const hasOpenAI = !!OPENAI_API_KEY && !OPENAI_API_KEY.includes('your_openai_api_key_');
    const useOpenAI = forceOpenAI || (hasOpenAI && GROQ_API_KEYS.length === 0);

    // Key Rotation for Groq
    let apiKey;

    // RELOAD KEYS if empty (sometimes .env loads late)
    if (GROQ_API_KEYS.length === 0) {
        const freshKeys = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
        if (freshKeys.length > 0) {
            GROQ_API_KEYS.push(...freshKeys);
            console.log(`[STT Service] 🔄 Reloaded ${GROQ_API_KEYS.length} Groq keys from env.`);
        }
    }

    if (useOpenAI) {
        apiKey = OPENAI_API_KEY;
    } else {
        if (GROQ_API_KEYS.length === 0 && !hasOpenAI) throw new Error('No API keys found');
        if (GROQ_API_KEYS.length > 0) {
            apiKey = GROQ_API_KEYS[currentApiKeyIndex];
        } else {
            // Should not reach here if logic is correct, but safety net
            throw new Error('Groq keys missing and OpenAI not forced');
        }
    }

    const apiUrl = useOpenAI
        ? 'https://api.openai.com/v1/audio/transcriptions'
        : 'https://api.groq.com/openai/v1/audio/transcriptions';
    const modelName = useOpenAI ? 'whisper-1' : 'whisper-large-v3-turbo'; // Much faster/stable

    if (!apiKey || apiKey.includes('your_')) {
        throw new Error('No Cloud API key configured (set OPENAI_API_KEY or GROQ_API_KEYS in .env)');
    }

    console.log(`[STT Service] ☁️ Uploading ${path.basename(filePath)} to ${useOpenAI ? 'OpenAI' : 'Groq'} (Model: ${modelName}, Key #${currentApiKeyIndex + 1})...`);

    const formData = new FormData();
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    // Groq requires audio/* MIME type. OpenAI is flexible.
    // 'audio/webm' is the correct type for our recordings.
    const mimeType = 'audio/webm';
    const blob = new Blob([fileBuffer], { type: mimeType });

    // Use original filename
    formData.append('file', blob, fileName);
    formData.append('model', modelName);
    formData.append('response_format', 'verbose_json');
    formData.append('language', 'en');
    // OpenAI and Groq handle this slightly differently, but standard is usually without []
    if (useOpenAI) {
        formData.append('timestamp_granularities', 'segment');
    }
    // Groq: timestamp_granularities is not strictly required for verbose_json segments, 
    // and sometimes causes issues. We'll omit it for now to see if it fixes 400s.

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            body: formData
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[STT Service] ❌ Cloud API Error ${response.status}: ${errorText.substring(0, 200)}...`);

            // Handle Rate Limit (429) OR Server Error (5xx) - Rotate key or backoff
            if ((response.status === 429 || response.status >= 500) && retryCount < (GROQ_API_KEYS.length * 3)) {
                console.warn(`[STT Service] ⚠️ Cloud API Error (${response.status}). Rotating key and retrying (Attempt ${retryCount + 1})...`);

                // Rotate to next key if using Groq
                if (!useOpenAI) {
                    // Check if we have multiple keys
                    if (GROQ_API_KEYS.length > 1) {
                        currentApiKeyIndex = (currentApiKeyIndex + 1) % GROQ_API_KEYS.length;
                        console.log(`[STT Service] 🔄 Switched to Groq Key Index: ${currentApiKeyIndex}`);
                    }
                }

                // Exponential backoff
                const delay = Math.pow(2, retryCount) * 3000;
                await new Promise(r => setTimeout(r, delay));
                return await cloudTranscribe(filePath, retryCount + 1);
            }

            // AUTO-FAILOVER: If Groq fails (5xx OR 400 Bad Request) OR persistent errors
            const isGroqError = !useOpenAI;
            const canFailover = OPENAI_API_KEY && !OPENAI_API_KEY.includes('your_openai_api_key_');

            // Failover criteria: 
            // 1. Critical Errors: 400 (Bad Request), 403 (Forbidden), 413 (Payload Too Large)
            // 2. Persistent Server/Rate Errors: 500+ or 429 after retries
            const isCritical = [400, 403, 413].includes(response.status);
            const isPersistent = (response.status >= 500 || response.status === 429) && retryCount >= 1;

            if (isGroqError && canFailover && (isCritical || isPersistent)) {
                console.warn(`[STT Service] 🚨 Groq failed (${response.status} - Retry ${retryCount}). Failing over to OpenAI...`);
                return await cloudTranscribe(filePath, retryCount, true); // Force OpenAI
            }

            throw new Error(`Cloud API error (${response.status}): ${errorText}`);
        }

        const result = await response.json();
        const provider = useOpenAI ? 'openai' : 'groq';
        console.log(`✅ Cloud transcription successful via ${provider}`);

        // Map cloud segments (if verbose_json returned them)
        let segments = [];
        if (result.segments && Array.isArray(result.segments)) {
            segments = result.segments.map(s => ({
                start: s.start,
                end: s.end,
                speaker: 'Meeting Participant',
                text: (s.text || '').trim()
            }));
        }
        // FALLBACK: If we have text but no segments, create a single segment
        else if (result.text && result.text.trim().length > 0) {
            console.log(`[STT Service] ⚠️ No segments found, using text fallback`);
            segments = [{
                start: 0,
                end: result.duration || 0,
                speaker: 'Meeting Participant',
                text: result.text.trim()
            }];
        }

        // Apply hallucination filter
        const finalSegments = filterSegments(segments);

        return {
            text: finalSegments.map(s => s.text).join(' '),
            segments: finalSegments,
            language: result.language || 'en',
            duration: result.duration || 0,
            method: provider
        };
    } catch (err) {
        // Retry on network errors too
        if (retryCount < 3 && (err.message.includes('fetch') || err.message.includes('timeout'))) {
            console.warn(`[STT Service] ⚠️ Network error: ${err.message}. Retrying...`);
            await new Promise(r => setTimeout(r, 2000));
            return await cloudTranscribe(filePath, retryCount + 1);
        }
        throw err;
    }
}

/**
 * Local transcription helper (faster-whisper via STT server)
 */
async function localTranscribe(filePath) {
    console.log(`[STT Service] 🖥️ Local transcription at ${STT_SERVICE_URL}...`);

    const formData = new FormData();
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const blob = new Blob([fileBuffer], { type: 'audio/webm' });
    formData.append('file', blob, fileName);

    // 120s timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
        const response = await fetch(`${STT_SERVICE_URL}/transcribe`, {
            method: 'POST',
            body: formData,
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Local STT returned ${response.status}: ${await response.text()}`);
        }

        const result = await response.json();
        console.log('✅ Local transcription successful');

        let segments = [];
        if (result.transcript && Array.isArray(result.transcript)) {
            segments = result.transcript.map(t => ({
                start: t.start_time,
                end: t.end_time,
                speaker: t.speaker_id || 'Meeting Participant',
                text: t.text
            }));
        }

        // Apply hallucination filter
        segments = filterSegments(segments);

        return {
            text: segments.map(s => s.text).join(' ') || result.text || '',
            segments: segments,
            language: result.language || 'en',
            duration: result.duration || 0,
            method: 'local'
        };
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error('Local STT request timed out ( > 120s)');
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Transcribe audio using the configured STT_MODE:
 *   STT_MODE=local      → local first, cloud fallback
 *   STT_MODE=cloud      → cloud only
 *   STT_MODE=local_only → local only
 */
export async function transcribeAudio(filePath) {
    // Read STT_MODE dynamically to allow hot-swapping via .env
    const currentMode = (process.env.STT_MODE || 'local').toLowerCase().trim();
    console.log(`[STT Service] Transcribing with mode: ${currentMode.toUpperCase()}`);

    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    // ─── CLOUD ONLY ───
    if (currentMode === 'cloud') {
        return await cloudTranscribe(filePath);
    }

    // ─── LOCAL ONLY ───
    if (currentMode === 'local_only') {
        return await localTranscribe(filePath);
    }

    // ─── LOCAL + CLOUD FALLBACK (default) ───
    try {
        return await localTranscribe(filePath);
    } catch (localErr) {
        console.log(`[STT Service] Local failed: ${localErr.message}. Falling back to cloud...`);
        return await cloudTranscribe(filePath);
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
