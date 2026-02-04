import { listRecentMeetings, fetchOneDriveFileContent, fetchTeamsTranscript, fetchVideoTranscript } from './ms-graph.js';
import { ingestProvidedTranscript, ingestTeamsMeeting } from './backend-adapter.js';
import { getMeetingByExternalId } from './storage-prod.js';

/**
 * Automatically syncs and ingests meetings for a user.
 * This is the core of the "polling" system logic.
 */
export async function syncUserMeetings(accessToken) {
    const results = {
        totalFound: 0,
        alreadyIngested: 0,
        newIngested: 0,
        failed: 0,
        errors: []
    };

    try {
        const recentMeetings = await listRecentMeetings(accessToken);
        results.totalFound = recentMeetings.length;

        for (const m of recentMeetings) {
            try {
                // Determine the external ID to check in DB
                const externalId = m.id || m.onlineMeetingId;
                if (!externalId) continue;

                // 1. Check if already ingested
                const existing = await getMeetingByExternalId(externalId);
                if (existing) {
                    results.alreadyIngested++;
                    continue;
                }

                // 2. Handle OneDrive VTT files or Video files with embedded transcripts
                if (m.source === 'onedrive') {
                    if (m.isVttFile) {
                        console.log(`[Auto-Ingest] Fetching VTT from OneDrive: ${m.subject} (Path: ${m.resourcePath})`);
                        const content = await fetchOneDriveFileContent(accessToken, m.downloadUrl, m.resourcePath);
                        await ingestProvidedTranscript(content, m.id, 'OneDrive Automatic');
                        results.newIngested++;
                        console.log(`[Auto-Ingest] Successfully ingested VTT: ${m.subject}`);
                    } else if (m.subject.toLowerCase().endsWith('.mp4')) {
                        console.log(`[Auto-Ingest] Checking for embedded transcript in Video: ${m.subject} (Path: ${m.resourcePath})`);
                        try {
                            const content = await fetchVideoTranscript(accessToken, m.id, m.resourcePath);
                            if (content) {
                                await ingestProvidedTranscript(content, m.id, 'Stream Video Transcript');
                                results.newIngested++;
                                console.log(`[Auto-Ingest] Successfully ingested Transcript from Video: ${m.subject}`);
                            }
                        } catch (e) {
                            console.warn(`[Auto-Ingest] Failed to fetch video transcript for ${m.subject}: ${e.message}`);
                        }
                    }
                }
                // 3. Handle Online Meetings (Scheduled or Meet Now)
                else if (m.source === 'onlineMeeting' || m.source === 'calendar') {
                    // We only try to ingest if it's an online meeting that might have transcription
                    if (m.onlineMeetingId || (m.source === 'onlineMeeting' && m.id)) {
                        console.log(`[Auto-Ingest] Attempting to ingest Teams meeting: ${m.subject}`);
                        try {
                            // ingestTeamsMeeting handles the Graph Transcript API
                            await ingestTeamsMeeting(accessToken, externalId);
                            results.newIngested++;
                            console.log(`[Auto-Ingest] Successfully ingested Teams meeting: ${m.subject}`);
                        } catch (e) {
                            // If it's a NO_TRANSCRIPTS_FOR_MEETING error, it's expected (meeting didn't have transcription)
                            if (e.message === 'NO_TRANSCRIPTS_FOR_MEETING') {
                                console.log(`[Auto-Ingest] No transcript found for ${m.subject}, skipping.`);
                            } else {
                                throw e;
                            }
                        }
                    }
                }
            } catch (e) {
                console.error(`[Auto-Ingest] Failed for meeting ${m.subject || m.id}:`, e.message);
                results.failed++;
                results.errors.push({ id: m.id, subject: m.subject, error: e.message });
            }
        }
    } catch (e) {
        console.error('[Auto-Ingest] Sync process error:', e);
        throw e;
    }

    return results;
}
