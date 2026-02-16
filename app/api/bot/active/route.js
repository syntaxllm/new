import { NextResponse } from 'next/server';
import { botManager } from '../../../../services/bot/manager';

// Ensure we use the global instance for cross-route persistence in dev
let manager = global.botManagerInstance;
if (!manager) {
    manager = botManager;
    global.botManagerInstance = manager;
}

export async function GET() {
    try {
        const bots = manager.getAllBots();
        // console.log('[Active Route] Serving bots:', bots.length);
        // Note: bots array includes { vttContent, logs, ... } which can constitute large payloads.
        return NextResponse.json({ bots });
    } catch (error) {
        console.error('[Active Bots API] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
