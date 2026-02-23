/**
 * LLM Service using Groq API
 * Handles: Chat, Summaries, Action Item Extraction
 */

import { getActiveKey, rotateKey } from './key-manager.js';

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Call Groq API with prompt
 */
async function callGroq(messages, jsonMode = false) {
    return callGroqWithRetry(messages, jsonMode);
}

/**
 * Internal function with Retry Logic for Rate Limits
 */
async function callGroqWithRetry(messages, jsonMode = false, retries = 3) {
    try {
        const apiKey = await getActiveKey();

        const requestBody = {
            model: GROQ_MODEL,
            messages: messages,
            temperature: 0.7,
            max_tokens: 2048,
            top_p: 1,
            stream: false,
            stop: null,
        };

        if (jsonMode) {
            requestBody.response_format = { type: 'json_object' };
        }

        const response = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody)
        });


        if (!response.ok) {
            // Handle Rate Limit (429) specifically
            if (response.status === 429 && retries > 0) {
                console.warn(`⚠️ Groq Rate Limit (429) on key ending in ...${apiKey.slice(-4)}. Rotating...`);
                await rotateKey();
                return await callGroqWithRetry(messages, jsonMode, retries - 1);
            }

            const error = await response.text();
            throw new Error(`Groq API error: ${response.status} - ${error}`);
        }
        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content;

        if (!text) {
            throw new Error('No response from Groq API');
        }

        return text;
    } catch (error) {
        throw error;
    }
}

/**
 * Generate meeting summary
 */
export async function generateSummary(meetingData) {
    const { meetingId, entries } = meetingData;

    // Build transcript text
    const transcriptText = entries
        .map(e => `[${e.start}] ${e.speaker}: ${e.text}`)
        .join('\n');

    const messages = [
        { role: 'system', content: 'You are an expert meeting analyst. Provide clear, concise, and actionable summaries.' },
        {
            role: 'user', content: `Analyze the following meeting transcript and generate a comprehensive summary.

TRANSCRIPT:
${transcriptText}

Please provide:
1. **Executive Summary** (3-4 sentences capturing the essence)
2. **Key Topics Discussed** (bullet points)
3. **Decisions Made** (bullet points with who decided what)
4. **Next Steps** (bullet points)
5. **Participants** (list with their main contributions)

Format your response in clean markdown.` }
    ];

    try {
        const response = await callGroq(messages);
        return {
            meetingId,
            summary: response,
            generatedAt: new Date().toISOString()
        };
    } catch (error) {
        console.error('Summary generation failed:', error);
        throw error;
    }
}

/**
 * Extract action items from meeting
 */
export async function extractActionItems(meetingData) {
    const { meetingId, entries } = meetingData;

    const transcriptText = entries
        .map(e => `[${e.start}] ${e.speaker}: ${e.text}`)
        .join('\n');

    const messages = [
        { role: 'system', content: 'You are an expert meeting analyst that extracts action items in JSON format.' },
        {
            role: 'user', content: `Analyze this meeting transcript and extract ALL action items.
            
TRANSCRIPT:
${transcriptText}

Return a JSON object with an "actionItems" key containing an array of objects.
For each action item, extract:
- "task": A clear, detailed description of WHAT needs to be done.
- "context": WHY this is important or what discussion triggered it (1 sentence).
- "owner": Who is primarily responsible (Name or Role).
- "deadline": Specific date if mentioned, or "ASAP"/timeline phrase.
- "priority": Calculate based on urgency (Critical/High/Medium/Low).

IMPORTANT: Even if "context" is not explicitly stated, infer it from the speaker's request. 
Only return valid JSON.` }
    ];

    try {
        const response = await callGroq(messages, true);
        const data = JSON.parse(response);

        return {
            meetingId,
            actionItems: data.actionItems || [],
            extractedAt: new Date().toISOString()
        };
    } catch (error) {
        console.error('Action item extraction failed:', error);
        throw error;
    }
}

/**
 * Chat with meeting context (RAG)
 */
export async function chatWithMeeting(question, chunks, chatHistory = []) {
    // Build context from relevant chunks
    const context = chunks
        .slice(0, 10)
        .map((chunk, idx) => `[Chunk ${idx + 1}]\n${chunk.text}`)
        .join('\n\n');

    const messages = [
        { role: 'system', content: 'You are an intelligent meeting analyst. The transcript is "Hinglish", noisy, and may contain phonetic errors (e.g., "Logesh" instead of "Yogesh", "Today" instead of "Uday").\n\nYOUR GOAL: Extract meaning and intent despite flaws.\n- IF A NAME IS MISSING: Look for phonetically similar words or context cues.\n- IF A PERSON DIDN\'T SPEAK: Briefly check if others mentioned them or their work. If truly nothing is found, say "No clear mentions found" without being robotic.\n- HINGLISH: Treat hindi phrases as valid technical context.\n- FORMATTING: Be direct. Do not start with "Based on the transcript". Just give the answer.' },
        ...chatHistory.map(msg => ({ role: msg.role === 'user' ? 'user' : 'assistant', content: msg.content })),
        {
            role: 'user', content: `MEETING CONTEXT:
${context}

USER QUESTION: ${question}

Answer:` }
    ];

    try {
        const response = await callGroq(messages);
        return {
            question,
            answer: response,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error('Chat failed:', error);
        throw error;
    }
}

/**
 * Semantic/Keyword Hybrid Retrieval (RAG)
 * Attempts Vector Search (Gemini) with Keyword fallback.
 */
export async function searchChunksSemantic(query, meetingId, limit = 10, userId = null) {
    try {
        const { searchChunksKeyword, searchChunksSemantic: vectorSearch } = await import('./storage-prod.js');
        const { generateEmbedding } = await import('./vector.js');

        // 1. Try Semantic Search first
        try {
            const queryVector = await generateEmbedding(query);
            if (queryVector) {
                const semanticDocs = await vectorSearch(queryVector, meetingId, limit, userId);
                if (semanticDocs && semanticDocs.length > 0) {
                    console.log(`[RAG] Found ${semanticDocs.length} semantic matches`);
                    return semanticDocs;
                }
            }
        } catch (vectorErr) {
            console.warn("[RAG] Semantic search path failed, falling back to keyword:", vectorErr.message);
        }

        // 2. Fallback to Keyword Search (Regex)
        console.log(`[RAG] Using keyword fallback for: "${query}"`);
        return await searchChunksKeyword(query, meetingId, limit, userId);
    } catch (err) {
        console.error("[RAG] Search failed:", err);
        return [];
    }
}

/**
 * Fallback: Keyword-based Search
 */
export function searchChunksKeywords(query, allChunks, limit = 10) {
    const queryLower = query.toLowerCase();
    const keywords = queryLower.split(/\s+/).filter(w => w.length > 2);

    const scored = allChunks.map(chunk => {
        const textLower = chunk.text.toLowerCase();
        let score = 0;
        keywords.forEach(keyword => {
            if (textLower.includes(keyword)) score += 1;
        });
        if (textLower.includes(queryLower)) score += 5;
        return { ...chunk, relevanceScore: score };
    });

    return scored
        .filter(c => c.relevanceScore > 0)
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, limit);
}