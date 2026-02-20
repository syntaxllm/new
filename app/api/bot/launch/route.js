import { NextResponse } from 'next/server';
import { botManager } from '../../../../services/bot/manager'; // Adjusted path: 4 levels up to root
import { getUserIdFromRequest } from '../../../../lib/auth';

// IMPORTANT: Next.js API routes are serverless/lambdas by default in Vercel, 
// but in a custom server or dev mode, singletons might persist. 
// For a production "Bot Fleet", this API should talk to a separate service via HTTP/Redis.
// For this stage (local dev/VPS), importing the singleton works if Next.js doesn't hot-reload it away.
// To ensure persistence, we ideally attach it to `global` in dev.
let manager = global.botManagerInstance;
if (!manager) {
    manager = botManager;
    global.botManagerInstance = manager;
}

export async function POST(req) {
    try {
        const { joinUrl, meetingId, subject } = await req.json();
        const userId = getUserIdFromRequest(req);

        if (!userId) {
            return NextResponse.json({ error: 'Unauthorized. Please login.' }, { status: 401 });
        }

        if (!joinUrl) {
            return NextResponse.json({ error: 'Missing joinUrl' }, { status: 400 });
        }

        // Only allow real Teams meeting join links
        const joinUrlStr = String(joinUrl);
        const isTeamsJoinUrl = /^https:\/\/(teams\.microsoft\.com|[^\/]+\.teams\.microsoft\.com)\//i.test(joinUrlStr);
        if (!isTeamsJoinUrl) {
            return NextResponse.json({
                error: 'Invalid joinUrl. Teams links only.'
            }, { status: 400 });
        }

        console.log(`[API] Requesting Bot Launch for Meeting: ${meetingId || 'Manual Link'} (User: ${userId || 'Anonymous'})`);

        // Use the Manager to launch with metadata
        const session = manager.launchBot(joinUrl, { meetingId, subject, userId });

        return NextResponse.json({
            success: true,
            message: 'Bot launch initiated',
            logId: session.id,
            status: session.status
        });

    } catch (error) {
        console.error('[Bot Launcher API] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
