import { NextResponse } from 'next/server';
import { ingestTeamsMeeting } from '../../../../lib/backend-adapter.js';

export async function POST(request) {
    try {
        const body = await request.json();
        const { secret, subject, transcript, meetingId, webUrl } = body;

        // 1. Security Check
        const expectedSecret = process.env.POWER_AUTOMATE_SECRET || 'changeme_in_env_file';
        if (secret !== expectedSecret) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        if (!transcript || !subject) {
            return NextResponse.json({ error: 'Missing transcript or subject' }, { status: 400 });
        }

        // 2. Construct simulated meeting data
        const pseudoId = meetingId || `PA-${Date.now()}`;
        const meetingData = {
            id: pseudoId,
            subject: subject,
            webUrl: webUrl || null,
            source: 'power-automate'
        };

        console.log(`[Webhook] Received Power Automate ingestion for: ${subject}`);

        // 3. Ingest directly
        // params: accessToken (null), id, resourcePath (null), meetingData, directContent
        const result = await ingestTeamsMeeting(null, pseudoId, null, meetingData, transcript);

        return NextResponse.json({
            success: true,
            message: 'Ingestion triggered successfully',
            id: result.meetingId
        });

    } catch (error) {
        console.error('[Webhook] Power Automate Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
