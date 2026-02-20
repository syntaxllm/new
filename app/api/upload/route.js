import { NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { parseVTT } from '../../../lib/parser.js';
import { chunkEntries } from '../../../lib/indexer.js';
import * as storage from '../../../lib/storage-prod.js';

import { getUserIdFromRequest } from '../../../lib/auth.js';

const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads');

/**
 * Handle file uploads (VTT or recording files)
 */
export async function POST(request) {
    try {
        const userId = getUserIdFromRequest(request);
        const formData = await request.formData();
        const file = formData.get('file');
        const fileName = formData.get('fileName') || file.name;
        const fileType = formData.get('fileType') || 'vtt';

        if (!file) {
            return NextResponse.json({ error: 'No file provided' }, { status: 400 });
        }

        // Ensure upload directory exists
        await mkdir(UPLOAD_DIR, { recursive: true });

        // Handle VTT upload
        if (fileType === 'vtt' || fileName.endsWith('.vtt')) {
            const bytes = await file.arrayBuffer();
            const buffer = Buffer.from(bytes);
            const content = buffer.toString('utf8');

            // Parse VTT
            const entries = parseVTT(content, fileName);

            // Generate meeting ID from filename
            const meetingId = fileName.replace(/\.vtt$/, '').replace(/[^a-z0-9-_]/gi, '-').toLowerCase();

            // Calculate duration
            const durationSeconds = entries.length > 0
                ? Math.max(...entries.map(e => {
                    const end = e.end || e.start;
                    const parts = (end || '00:00:00').split(':');
                    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
                }))
                : 0;

            // Create meeting object
            const meetingObj = {
                meetingId,
                userId,
                source: fileName,
                uploadedAt: new Date().toISOString(),
                durationSeconds,
                entries: entries.map((e, idx) => ({
                    id: `${meetingId}:${String(idx + 1).padStart(4, '0')}`,
                    sequence: idx + 1,
                    start: e.start,
                    end: e.end,
                    speaker: e.speaker || 'Unknown',
                    text: e.text || '',
                }))
            };

            // Save meeting to MongoDB
            await storage.saveTranscripts(meetingObj);

            // Generate and save chunks to MongoDB
            const chunks = chunkEntries(entries);
            chunks.forEach((c, i) => {
                c.meetingId = meetingId;
                c.chunkId = `${meetingId}#${String(i + 1).padStart(4, '0')}`;
            });

            await storage.saveChunks(chunks);

            // Save uploaded file
            const filePath = path.join(UPLOAD_DIR, fileName);
            await writeFile(filePath, buffer);

            return NextResponse.json({
                success: true,
                meetingId,
                fileName,
                entriesCount: entries.length,
                chunksCount: chunks.length,
                durationSeconds,
                message: 'VTT file uploaded and processed successfully'
            });
        }

        // Handle other file types (MP4, WebM, audio) - placeholder for future transcription service
        if (fileType === 'recording') {
            const bytes = await file.arrayBuffer();
            const buffer = Buffer.from(bytes);

            // Generate unique filename
            const timestamp = Date.now();
            const safeFileName = `recording_${timestamp}_${fileName.replace(/[^a-z0-9._-]/gi, '_')}`;
            const filePath = path.join(UPLOAD_DIR, safeFileName);

            await writeFile(filePath, buffer);

            return NextResponse.json({
                success: true,
                fileName: safeFileName,
                fileSize: buffer.length,
                message: 'Recording uploaded. Transcription service coming soon.',
                note: 'For now, please upload VTT files directly. Recording transcription will be implemented in the FUTURE phase.'
            });
        }

        return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 });

    } catch (error) {
        console.error('Upload error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to upload file' },
            { status: 500 }
        );
    }
}

/**
 * Get list of uploaded files
 */
export async function GET() {
    try {
        const { readdir } = await import('fs/promises');
        const fs = await import('fs');

        if (!fs.existsSync(UPLOAD_DIR)) {
            return NextResponse.json({ uploads: [] });
        }

        const files = await readdir(UPLOAD_DIR);
        const fileDetails = await Promise.all(
            files.map(async (name) => {
                const filePath = path.join(UPLOAD_DIR, name);
                const stats = await fs.promises.stat(filePath);
                return {
                    name,
                    size: stats.size,
                    uploadedAt: stats.mtime.toISOString()
                };
            })
        );

        return NextResponse.json({ uploads: fileDetails });
    } catch (error) {
        console.error('Error listing uploads:', error);
        return NextResponse.json({ uploads: [] });
    }
}