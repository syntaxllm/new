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
        return NextResponse.json({ bots });
    } catch (error) {
        console.error('[Active Bots API] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
