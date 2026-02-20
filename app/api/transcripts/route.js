import { NextResponse } from 'next/server';
import { loadTranscripts } from '../../../lib/backend-adapter.js';
import { getUserIdFromRequest } from '../../../lib/auth.js';

export async function GET(req) {
  const userId = getUserIdFromRequest(req);
  // Optional: If no userId, return empty or unauthorized? 
  // For now, let's just return empty list or pass null (which returns global list if not careful?)
  // Wait, storage.loadTranscripts(null) returns ALL. We should probably restrict strict mode.
  // Assuming strict mode:
  if (!userId) {
    // return NextResponse.json([], { status: 401 }); // Or just empty list?
    // Let's filter strictly if `userId` is expected.
    // But `storage-prod.js` implementation: `const query = userId ? { userId } : {};`
    // So if userId is null, it returns ALL. This might be bad for security if we enforce auth.

    // Let's enforce it:
    return NextResponse.json([], { status: 401 });
  }

  const list = await loadTranscripts(userId);
  return NextResponse.json(list);
}
