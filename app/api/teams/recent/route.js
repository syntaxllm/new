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
                let hasTranscript = m.isVttFile;

                // If it's a video file, it's a high-value target
                if (m.subject.toLowerCase().endsWith('.mp4')) {
                    // We assume it MIGHT have a transcript since it's in the Recordings folder
                    hasTranscript = true;
                }

                validMeetings.push({
                    ...m,
                    status: hasTranscript ? 'READY' : 'ONEDRIVE_FILE',
                    isOrganizer: true,
                    hasTranscript: hasTranscript
                });
                continue;
            }

            // C. Handle Online Meetings
            let isOrganizer = m.isOrganizer === true;
            if (!isOrganizer) {
                const orgEmail = m.organizer?.emailAddress?.address || m.organizer?.emailAddress?.name;
                if (orgEmail && (orgEmail.toLowerCase() === me.mail?.toLowerCase() || orgEmail.toLowerCase() === me.userPrincipalName?.toLowerCase())) {
                    isOrganizer = true;
                }
            }

            // Check transcript access
            let transcriptStatus = { hasAccess: false, transcriptsExist: false };
            try {
                transcriptStatus = await checkTranscriptAccess(token, m.id);
            } catch (e) {
                console.warn(`Transcript check failed for ${m.id}`, e.message);
            }

            // ONLY show if it's actionable: Organizer with Transcripts OR already has standalone VTT
            if (isOrganizer && transcriptStatus.transcriptsExist) {
                validMeetings.push({
                    ...m,
                    status: 'READY',
                    isOrganizer: true,
                    hasTranscript: true
                });
            }
            // HIDE "bluffs" (meetings with no transcript or where I am just an attendee)
        }

        console.log(`Returning ${validMeetings.length} strictly filtered meetings.`);
        return NextResponse.json(validMeetings);

    } catch (error) {
        console.error('Error in /api/teams/recent:', error);
        return NextResponse.json({ error: error.message || 'Failed to load recent Teams meetings.' }, { status: 500 });
    }
}