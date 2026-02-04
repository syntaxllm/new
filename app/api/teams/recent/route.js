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

        for (const m of recentMeetings) {
            // A. Check if Ingested
            const isIngested = ingestedExternalIds.has(m.id) ||
                (m.onlineMeetingId && ingestedExternalIds.has(m.onlineMeetingId));

            if (isIngested) continue;

            // B. Handle OneDrive/SharePoint Files (Actual Recordings)
            if (m.source === 'onedrive') {
                // If the Graph layer found it, we show it!
                // We trust the discovery engine in ms-graph.js more now.
                validMeetings.push({
                    ...m,
                    status: 'READY',
                    isOrganizer: true,
                    hasTranscript: true
                });
                continue;
            }

            // C. Handle Online Meetings (Only if fresh and has transcript)
            let isOrganizer = m.isOrganizer === true;
            if (!isOrganizer) {
                const orgEmail = m.organizer?.emailAddress?.address || m.organizer?.emailAddress?.name;
                if (orgEmail && (orgEmail.toLowerCase() === me.mail?.toLowerCase() || orgEmail.toLowerCase() === me.userPrincipalName?.toLowerCase())) {
                    isOrganizer = true;
                }
            }

            // For calendar/online meetings, only show if they are definitely organizer and fresh
            if (!isOrganizer) continue;

            // Check transcript access
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

        // Limit to top 30 filtered results for clarity but coverage
        const finalResults = validMeetings
            .sort((a, b) => new Date(b.start) - new Date(a.start))
            .slice(0, 30);

        console.log(`Returning ${finalResults.length} strictly filtered meetings.`);
        return NextResponse.json(finalResults);

    } catch (error) {
        console.error('Error in /api/teams/recent:', error);
        return NextResponse.json({ error: error.message || 'Failed to load recent Teams meetings.' }, { status: 500 });
    }
}