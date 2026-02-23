import { NextResponse } from 'next/server';
import { loadChunksForMeeting } from '../../../../lib/backend-adapter.js';
import { chatWithMeeting } from '../../../../lib/llm-service.js';
import { getUserIdFromRequest } from '../../../../lib/auth.js';

export async function POST(request, { params }) {
    try {
        const { id } = params;
        const userId = getUserIdFromRequest(request);

        if (!userId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const body = await request.json();
        const { question, chatHistory = [] } = body;

        if (!question) {
            return NextResponse.json({ error: 'Question is required' }, { status: 400 });
        }

        // Get all chunks for this meeting
        const allChunks = await loadChunksForMeeting(id, userId);

        if (!allChunks || allChunks.length === 0) {
            return NextResponse.json({ error: 'No chunks found for this meeting' }, { status: 404 });
        }

        // Index search (Semantic RAG)
        const { searchChunksSemantic } = await import('../../../../lib/llm-service.js');
        const relevantChunks = await searchChunksSemantic(question, id, 10, userId);

        if (relevantChunks.length === 0) {
            return NextResponse.json({
                question,
                answer: "I couldn't find relevant information in this meeting transcript to answer your question.",
                timestamp: new Date().toISOString()
            });
        }

        // Get answer from LLM
        const result = await chatWithMeeting(question, relevantChunks, chatHistory);

        // Attach source chunks for RAG transparency
        result.sources = relevantChunks.map(c => ({
            text: c.text,
            startSec: c.startSec,
            endSec: c.endSec
        }));

        return NextResponse.json(result);
    } catch (error) {
        console.error('Chat error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to process chat' },
            { status: 500 }
        );
    }
}
