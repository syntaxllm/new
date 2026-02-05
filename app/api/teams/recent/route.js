import { NextResponse } from 'next/server';
import { listRecentMeetings, fetchTeamsRecording, getMeetingInfo } from '../../../../lib/ms-graph.js';
import { loadTranscripts } from '../../../../lib/backend-adapter.js';

export async function GET(request) {
    try {
        const token = request.cookies.get('ms_token')?.value;
        if (!token) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        // 1) Get user info to check organizer status
        const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const me = await meRes.json();

        // 2) Fetch recent meetings from ONLY the Recordings folder
        const recentMeetings = await listRecentMeetings(token);
        console.log(`Found ${recentMeetings.length} files from Recordings folder`);

        // 3) Get list of already ingested meetings
        const ingested = await loadTranscripts();
        const ingestedExternalIds = new Set(ingested.map(t => t.externalId));

        // 4) Filter out ingested meetings
        console.log('[API] Files found:', recentMeetings.map(m => ({ id: m.id, subject: m.subject })));
        console.log('[API] Already ingested IDs:', Array.from(ingestedExternalIds));

        const validMeetings = recentMeetings
            .filter(m => {
                const isIngested = ingestedExternalIds.has(m.id) ||
                    (m.onlineMeetingId && ingestedExternalIds.has(m.onlineMeetingId));
                if (isIngested) {
                    console.log(`[API] Filtering out (already ingested): ${m.subject || m.id}`);
                }
                return !isIngested;
            })
            .map(m => ({
                ...m,
                status: 'READY',
                isOrganizer: true,
                hasTranscript: m.isVttFile || false
            }));

        console.log(`[API] Returning ${validMeetings.length} clean results to UI.`);
        console.log('[API] Full response:', JSON.stringify(validMeetings, null, 2));
        return NextResponse.json(validMeetings);

    } catch (error) {
        console.error('Error in /api/teams/recent:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}