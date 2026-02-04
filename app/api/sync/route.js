import { NextResponse } from 'next/server';
import { syncUserMeetings } from '../../../lib/ingestion-service.js';

/**
 * GET /api/sync
 * Triggers the automatic polling and ingestion of meetings for the logged-in user.
 */
export async function GET(request) {
    const token = request.cookies.get('ms_token')?.value;

    if (!token) {
        return NextResponse.json({ error: 'Unauthorized. Please log in to Teams.' }, { status: 401 });
    }

    try {
        console.log('[API] Triggering automatic sync/ingestion...');
        const results = await syncUserMeetings(token);

        return NextResponse.json({
            success: true,
            summary: {
                totalMeetingsFound: results.totalFound,
                alreadyIngested: results.alreadyIngested,
                newlyIngested: results.newIngested,
                failedCount: results.failed
            },
            errors: results.errors.length > 0 ? results.errors : undefined
        });
    } catch (error) {
        console.error('[API] Sync error:', error);
        return NextResponse.json({
            success: false,
            error: error.message || 'Internal Server Error during sync'
        }, { status: 500 });
    }
}
