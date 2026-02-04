import { NextResponse } from 'next/server';
import { listRecentMeetings, fetchTeamsRecording, getMeetingInfo } from '../../../../lib/ms-graph.js';
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

        console.log(`[API debug] Processing ${recentMeetings.length} discovery results...`);

        const checkPromises = recentMeetings.map(async (m) => {
            // Ignore upcoming meetings
            if (new Date(m.start) > new Date()) return null;

            // Ignore already ingested meetings
            const isIngested = ingestedExternalIds.has(m.id) ||
                (m.onlineMeetingId && ingestedExternalIds.has(m.onlineMeetingId));
            if (isIngested) return null;

            // Case 1: It's a direct file from OneDrive/SharePoint search. It's a "recorded thing".
            if (m.source === 'onedrive') {
                return { ...m, status: 'READY', isOrganizer: true, hasTranscript: m.isVttFile };
            }

            // Case 2: It's a calendar event. We must verify it has a recording.
            if (m.source === 'calendar' || m.source === 'onlineMeeting') {
                // First, check if the user is the organizer
                let isOrganizer = m.isOrganizer === true;
                if (!isOrganizer) {
                    const orgEmail = m.organizer?.emailAddress?.address || m.organizer?.emailAddress?.name;
                    if (orgEmail && (orgEmail.toLowerCase() === me.mail?.toLowerCase() || orgEmail.toLowerCase() === me.userPrincipalName?.toLowerCase())) {
                        isOrganizer = true;
                    }
                }
                if (!isOrganizer) return null;

                // Now, robustly check for a recording
                try {
                    if (!m.onlineMeetingId || typeof m.onlineMeetingId !== 'string') return null;
                    const recording = await fetchTeamsRecording(token, m.onlineMeetingId);
                    if (recording) {
                        return { ...m, status: 'READY', isOrganizer: true, hasTranscript: false };
                    }
                } catch (err) {
                    // This error is expected for non-Teams meetings, so we just log and discard
                    console.warn(`Could not confirm recording for '${m.subject}'. Discarding.`);
                    return null;
                }
            }

            return null; // Discard anything that doesn't match the criteria
        });

        const settledResults = await Promise.allSettled(checkPromises);

        const validMeetings = settledResults
            .filter(res => res.status === 'fulfilled' && res.value)
            .map(res => res.value);

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