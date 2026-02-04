import { NextResponse } from 'next/server';
import { listRecentMeetings, checkTranscriptAccess, getMeetingInfo } from '../../../../lib/ms-graph.js';
import { loadTranscripts } from '../../../../lib/backend-adapter.js';

export async function GET(request) {
    const token = request.cookies.get('ms_token')?.value;

    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // 0) Get Current User Info
        const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const me = await meRes.json();
        const myId = me.id;

        // 1) Get already ingested meetings
        const ingested = await loadTranscripts();
        const ingestedExternalIds = new Set(
            (ingested || [])
                .filter(m => m.source === 'Microsoft Teams API' && m.externalId)
                .map(m => m.externalId)
        );

        // 2) Get recent online meetings from user's calendar
        const recentMeetings = await listRecentMeetings(token);
        console.log(`Found ${recentMeetings.length} recent online meetings from calendar`);

        // 3) Process ALL meetings to determine status
        const validMeetings = [];

        console.log(`[API debug] Processing ${recentMeetings.length} discovery results...`);

        for (const m of recentMeetings) {
            // Check if Ingested (Log it, but don't skip for debug)
            const isIngested = ingestedExternalIds.has(m.id) ||
                (m.onlineMeetingId && ingestedExternalIds.has(m.onlineMeetingId));

            if (isIngested) {
                console.log(`[API debug] File already ingested: ${m.subject || m.id}`);
            }

            // For now, let's just include EVERYTHING that was discovered
            validMeetings.push({
                ...m,
                status: isIngested ? 'INGESTED' : 'READY',
                isOrganizer: true,
                hasTranscript: true
            });
        }

        console.log(`Returning ${validMeetings.length} results to UI.`);
        return NextResponse.json(validMeetings);

    } catch (error) {
        console.error('Error in /api/teams/recent:', error);
        return NextResponse.json({ error: error.message || 'Failed to load recent Teams meetings.' }, { status: 500 });
    }
}