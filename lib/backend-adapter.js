import * as storage from './storage-prod.js';
import { parseVTT } from './parser.js';
import { chunkEntries } from './indexer.js';
import { fetchTeamsTranscript, fetchTeamsRecording, fetchVideoTranscript } from './ms-graph.js';

/**
 * Handle real Microsoft Teams Ingestion
 */
export async function ingestTeamsMeeting(accessToken, teamsMeetingId, resourcePath = null, meetingData = null) {
  let vttContent;
  let source = 'Microsoft Teams API';

  // 1. Fetch real VTT content
  console.log(`[Ingest] teamsMeetingId: ${teamsMeetingId}, resourcePath: ${resourcePath}`);
  console.log(`[Ingest] meetingData:`, meetingData);

  try {
    // PRIORITY 1: If we have a direct VTT file, fetch it immediately
    if (meetingData?.vttResourcePath) {
      console.log(`[Ingest] Found VTT companion file! Fetching: ${meetingData.vttResourcePath}`);
      const vttUrl = `https://graph.microsoft.com/v1.0${meetingData.vttResourcePath}/content`;
      const vttRes = await fetch(vttUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      if (vttRes.ok) {
        vttContent = await vttRes.text();
        source = 'OneDrive VTT File';
        console.log(`[Ingest] Successfully fetched VTT content (${vttContent.length} chars)`);
      } else {
        console.warn(`[Ingest] VTT fetch failed (${vttRes.status}), trying fallback...`);
      }
    }

    // PRIORITY 2: Try OneDrive video with textTracks
    if (!vttContent && resourcePath && (resourcePath.includes('/drives/') || resourcePath.includes('/items/'))) {
      console.log(`[Ingest] Detected OneDrive item. Using Video Deep Scan for: ${resourcePath}`);
      vttContent = await fetchVideoTranscript(accessToken, teamsMeetingId, resourcePath);
      source = 'Microsoft Stream (Video)';
    }

    // PRIORITY 3: Standard Teams Meeting API
    if (!vttContent) {
      console.log(`[Ingest] Using Teams API for meeting ID: ${teamsMeetingId}`);
      vttContent = await fetchTeamsTranscript(accessToken, teamsMeetingId);
    }
  } catch (err) {
    console.warn(`[Ingest] Primary fetch failed:`, err.message);

    // Fallback logic
    if (!vttContent) {
      try {
        vttContent = await fetchTeamsTranscript(accessToken, teamsMeetingId);
      } catch (e) {
        if (e.message === 'NO_TRANSCRIPTS_FOR_MEETING' || e.message.includes('404') || e.message.includes('400')) {
          console.log(`[Ingest] No standard transcript found. Attempting Video Deep Scan...`);
          vttContent = await fetchVideoTranscript(accessToken, teamsMeetingId, resourcePath);
          source = 'Microsoft Stream (Video)';
        } else {
          throw e;
        }
      }
    }
  }

  // Validate content before parsing
  if (!vttContent || vttContent.trim().length === 0) {
    throw new Error('EMPTY_TRANSCRIPT_CONTENT');
  }

  // 2. Parse the VTT content
  const entries = parseVTT(vttContent, `teams_${teamsMeetingId.substring(0, 12)}.vtt`);

  // Validate parsing results
  if (!entries || entries.length === 0) {
    console.error(`Parser returned 0 entries for meeting ${teamsMeetingId}`);
    throw new Error('PARSER_RETURNED_ZERO_ENTRIES');
  }

  console.log(`Parsed ${entries.length} transcript entries for meeting ${teamsMeetingId}`);

  // 3.5 Fetch Recording metadata if available (for Teams Meetings)
  let recordingUrl = null;
  if (source === 'Microsoft Teams API') {
    try {
      const recording = await fetchTeamsRecording(accessToken, teamsMeetingId);
      if (recording) recordingUrl = recording.contentUrl;
    } catch (e) { /* ignore */ }
  }

  // 3. Normalize into meeting object
  const meetingId = `teams-${teamsMeetingId.substring(0, 8)}`;
  const meetingObj = {
    meetingId,
    source,
    externalId: teamsMeetingId,
    recordingUrl: recordingUrl,
    importedAt: new Date().toISOString(),
    durationSeconds: calculateDuration(entries),
    entries: entries.map((e, idx) => ({
      id: `${meetingId}:${String(idx + 1).padStart(4, '0')}`,
      sequence: idx + 1,
      ...e
    }))
  };

  // 4. Save to MongoDB
  await storage.saveTranscripts(meetingObj);
  return processChunksAndSave(meetingObj, entries);
}

/**
 * Handle direct ingestion of provided VTT content (e.g. from OneDrive file)
 */
export async function ingestProvidedTranscript(vttContent, externalId, source = 'Manual Upload') {
  if (!vttContent || vttContent.trim().length === 0) {
    throw new Error('EMPTY_TRANSCRIPT_CONTENT');
  }

  const entries = parseVTT(vttContent, `manual_${externalId}.vtt`);
  if (!entries || entries.length === 0) throw new Error('PARSER_FAILED');

  const meetingId = `file-${externalId.substring(0, 8)}`;

  const meetingObj = {
    meetingId,
    source,
    externalId,
    importedAt: new Date().toISOString(),
    durationSeconds: calculateDuration(entries),
    entries: entries.map((e, idx) => ({
      id: `${meetingId}:${String(idx + 1).padStart(4, '0')}`,
      sequence: idx + 1,
      ...e
    }))
  };

  await storage.saveTranscripts(meetingObj);
  return processChunksAndSave(meetingObj, entries);
}

// Helper to chunk and save
async function processChunksAndSave(meetingObj, entries) {
  // 5. Generate RAG Chunks
  const chunks = chunkEntries(entries);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    c.meetingId = meetingObj.meetingId;
    c.chunkId = `${meetingObj.meetingId}#${String(i + 1).padStart(4, '0')}`;
  }

  // 6. Save Chunks to MongoDB Atlas
  await storage.saveChunks(chunks);

  return meetingObj;
}

export async function loadTranscripts() {
  return await storage.loadTranscripts();
}

export async function getMeeting(meetingId) {
  return await storage.getMeeting(meetingId);
}

export async function loadChunksForMeeting(meetingId) {
  return await storage.loadChunks(meetingId);
}

export async function updateMeeting(meetingId, updateData) {
  return await storage.updateMeeting(meetingId, updateData);
}

export async function deleteMeeting(meetingId) {
  return await storage.deleteMeeting(meetingId);
}

function calculateDuration(entries) {
  if (!entries || entries.length === 0) return 0;
  const end = entries[entries.length - 1].end || entries[entries.length - 1].start;
  const parts = (end || '00:00:00').split(':');
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
}

