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
            // Check if Ingested
            const isIngested = ingestedExternalIds.has(m.id) ||
                (m.onlineMeetingId && ingestedExternalIds.has(m.onlineMeetingId));

            if (isIngested) continue;

            // 1. Handle OneDrive/SharePoint Files (Actual Recordings found by our engine)
            if (m.source === 'onedrive') {
                validMeetings.push({
                    ...m,
                    status: 'READY',
                    isOrganizer: true,
                    hasTranscript: true
                });
                continue;
            }

            // 2. Handle Online Meetings from Calendar/API
            // STRICT SHIELD: Only show if user is definitely the organizer
            let isOrganizer = m.isOrganizer === true;
            if (!isOrganizer) {
                const orgEmail = m.organizer?.emailAddress?.address || m.organizer?.emailAddress?.name;
                if (orgEmail && (orgEmail.toLowerCase() === me.mail?.toLowerCase() || orgEmail.toLowerCase() === me.userPrincipalName?.toLowerCase())) {
                    isOrganizer = true;
                }
            }

            // If not the organizer of this calendar event, SHIELD it (Silence the bluffs)
            if (!isOrganizer) continue;

            // For owned meetings, check if they have a transcript
            let transcriptStatus = { hasAccess: false, transcriptsExist: false };
            try {
                transcriptStatus = await checkTranscriptAccess(token, m.id);
            } catch (e) { /* ignore */ }

            if (transcriptStatus.transcriptsExist) {
                validMeetings.push({
                    ...m,
                    status: 'READY',
                    isOrganizer: true,
                    hasTranscript: true
                });
            }
        }

        const finalResults = validMeetings
            .sort((a, b) => new Date(b.start) - new Date(a.start))
            .slice(0, 30);

        console.log(`Returning ${finalResults.length} clean results to UI.`);
        return NextResponse.json(finalResults);

    } catch (error) {
        console.error('Error in /api/teams/recent:', error);
        return NextResponse.json({ error: error.message || 'Failed to load recent Teams meetings.' }, { status: 500 });
    }
}