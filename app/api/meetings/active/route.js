import { NextResponse } from 'next/server';
import { fetchUpcomingMeetings } from '../../../../lib/ms-graph';

export async function GET(req) {
    try {
        const tokenDisplay = req.cookies.get('ms_token');
        if (!tokenDisplay?.value) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        const meetings = await fetchUpcomingMeetings(tokenDisplay.value);
        return NextResponse.json({ meetings });
    } catch (error) {
        console.error('API Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
