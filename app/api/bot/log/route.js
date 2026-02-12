import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(request) {
    try {
        // Temporarily skip authentication for testing
        // const token = request.cookies.get('ms_token')?.value;
        // if (!token) {
        //     return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        // }

        const { searchParams } = new URL(request.url);
        const logId = searchParams.get('logId');

        if (!logId || !/^[0-9a-fA-F-]{16,}$/.test(logId)) {
            return NextResponse.json({ error: 'Missing or invalid logId' }, { status: 400 });
        }

        const logsDir = path.resolve(process.cwd(), '.bot-logs');
        const logPath = path.resolve(logsDir, `${logId}.log`);

        if (!logPath.startsWith(logsDir)) {
            return NextResponse.json({ error: 'Invalid log path' }, { status: 400 });
        }

        if (!fs.existsSync(logPath)) {
            return new NextResponse('Log file not found or bot not started yet', {
                status: 404,
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-store'
                }
            });
        }

        const content = fs.readFileSync(logPath, 'utf8');

        const allowedPrefixes = ['🤖', '🔗', '✅', '🔍', '✍️', '👆', '⏳', '🔒', '🔴', '📸', '❌', '⚠️', '🟢', '🟡'];
        // Update filter to handle timestamps [2026-...] or direct emoji start
        const sanitized = content
            .split('\n')
            .filter(line => {
                const trimmed = (line || '').trim();
                // Allow if it starts with [ (timestamp) OR starts with emoji OR contains emoji
                return trimmed.startsWith('[') || allowedPrefixes.some(p => trimmed.startsWith(p) || trimmed.includes(p));
            })
            .join('\n');

        return new NextResponse(sanitized, {
            status: 200,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store'
            }
        });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
