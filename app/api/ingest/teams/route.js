import { NextResponse } from 'next/server';
import { ingestTeamsMeeting } from '../../../../lib/backend-adapter.js';
/**
 * POST /api/ingest/teams
 * Body: { accessToken: string, teamsMeetingId: string }
 */
export async function POST(request) {
    try {
        const body = await request.json();
        const { teamsMeetingId, meetingData } = body;

        console.log('[Ingest API] Request body:', JSON.stringify({ teamsMeetingId, meetingData }, null, 2));

        // Get token from body or cookie
        const accessToken = body.accessToken || request.cookies.get('ms_token')?.value;

        if (!accessToken || !teamsMeetingId) {
            console.error('[Ingest API] Missing required fields');
            return NextResponse.json({ error: 'Authorization or teamsMeetingId is required' }, { status: 400 });
        }

        // Trigger real-world ingestion from MS Graph to MongoDB
        // Pass resourcePath if we have it from the discovery phase
        console.log('[Ingest API] Calling ingestTeamsMeeting with resourcePath:', meetingData?.resourcePath);
        const meeting = await ingestTeamsMeeting(accessToken, teamsMeetingId, meetingData?.resourcePath);

        return NextResponse.json({
            success: true,
            meetingId: meeting.meetingId,
            message: 'Meeting successfully ingested from Microsoft Teams'
        });
    } catch (error) {
        console.error('Teams Ingestion Failed:', error);
        // Map known "expected" errors (like missing transcripts / meeting lookup)
        // to cleaner HTTP codes so the client doesn't just see a 500.
        if (error?.message === 'MISSING_MEETING_IDENTIFIER') {
            return NextResponse.json(
                { error: 'Missing Teams meeting identifier.' },
                { status: 400 }
            );
        }

        if (error?.message === 'NO_ONLINE_MEETING_FOR_JOIN_URL') {
            return NextResponse.json(
                { error: 'Could not find a Microsoft Teams meeting for that join link.' },
                { status: 404 }
            );
        }

        if (error?.message === 'NO_TRANSCRIPTS_FOR_MEETING') {
            return NextResponse.json(
                { error: 'No transcripts are available for this meeting in Microsoft Graph.' },
                { status: 404 }
            );
        }

        if (error?.message === 'EMPTY_TRANSCRIPT_CONTENT') {
            return NextResponse.json(
                { error: 'Transcript content was empty. The meeting may not have transcription enabled or the transcript may not be ready yet.' },
                { status: 422 }
            );
        }

        if (error?.message === 'PARSER_RETURNED_ZERO_ENTRIES') {
            return NextResponse.json(
                { error: 'Failed to parse transcript content. The transcript format may be unsupported. Check server logs for details.' },
                { status: 422 }
            );
        }

        return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
    }
}