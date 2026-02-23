
import { NextResponse } from 'next/server';
import { deleteMeeting } from '../../../../lib/backend-adapter.js';
import { getUserIdFromRequest } from '../../../../lib/auth.js';

export async function DELETE(request, { params }) {
    try {
        const { id } = params;
        const userId = getUserIdFromRequest(request);

        if (!id) return NextResponse.json({ error: 'ID required' }, { status: 400 });
        if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const result = await deleteMeeting(id, userId);
        if (result.deletedCount === 0) {
            return NextResponse.json({ error: 'Meeting not found or unauthorized' }, { status: 404 });
        }
        return NextResponse.json({ success: true, message: `Meeting ${id} deleted` });
    } catch (error) {
        console.error('Delete error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}