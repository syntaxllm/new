import * as storage from './storage-prod.js';
import { parseVTT } from './parser.js';
import { chunkEntries } from './indexer.js';
import { vectorizeAndSaveChunks } from './vector.js';
import { fetchTeamsTranscript, fetchTeamsRecording, fetchVideoTranscript, extractMeetingIdFromRecording } from './ms-graph.js';

/**
 * Handle real Microsoft Teams Ingestion
 */
export async function ingestTeamsMeeting(accessToken, teamsMeetingId, resourcePath = null, meetingData = null, directContent = null) {
  let vttContent = directContent;
  let source = directContent ? 'Power Automate / Manual Upload' : 'Microsoft Teams API';

  // 1. Fetch real VTT content (if not provided directly)
  console.log(`[Ingest] teamsMeetingId: ${teamsMeetingId}, hasDirectContent: ${!!directContent}`);
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

    // PRIORITY 1.5: Check if VTT content is already available from SharePoint Lists API
    if (!vttContent && meetingData?.vttContent) {
      console.log(`[Ingest] Using pre-fetched VTT content from SharePoint Lists API`);
      vttContent = meetingData.vttContent;
      source = 'SharePoint Lists API';
      console.log(`[Ingest] Using VTT content (${vttContent.length} chars)`);
    }

    // PRIORITY 2: Try OneDrive video with textTracks
    if (!vttContent && resourcePath && (resourcePath.includes('/drives/') || resourcePath.includes('/items/'))) {
      console.log(`[Ingest] Detected OneDrive item. Using Video Deep Scan for: ${resourcePath}`);
      // Use REAL IDs if it was a shortcut (capture from Discovery phase)
      const targetId = meetingData?.targetId || teamsMeetingId; // teamsMeetingId holds the driveItemId here
      const targetDriveId = meetingData?.targetDriveId;

      // If we have a targetDriveId, we must construct the path manually because resourcePath points to the shortcut
      let scanPath = resourcePath;
      let scanId = teamsMeetingId;

      if (targetDriveId && meetingData?.isShortcut) {
        console.log(`[Ingest] 🚀 Redirecting Ingestion to SHORTCUT TARGET: Drive ${targetDriveId}, Item ${targetId}`);
        scanPath = `/drives/${targetDriveId}/items/${targetId}`;
        scanId = targetId;
      }

      vttContent = await fetchVideoTranscript(accessToken, scanId, scanPath);
      source = 'Microsoft Stream (Video)';
    }

    // PRIORITY 3: Standard Teams Meeting API (with meeting ID extraction)
    if (!vttContent) {
      console.log(`[Ingest] Using Teams API for meeting ID: ${teamsMeetingId}`);

      // Try to extract real meeting ID from recording name first
      if (meetingData?.subject && meetingData?.siteId) {
        console.log(`[Ingest] Attempting to extract meeting ID from recording: ${meetingData.subject}`);
        const extractedMeetingId = await extractMeetingIdFromRecording(
          accessToken,
          meetingData.subject,
          meetingData.siteId,
          meetingData.targetDriveId,
          meetingData.targetId || meetingData.driveItemId
        );

        if (extractedMeetingId) {
          console.log(`[Ingest] 🎯 Using extracted meeting ID: ${extractedMeetingId}`);
          vttContent = await fetchTeamsTranscript(accessToken, extractedMeetingId);
          source = 'Microsoft Teams API (Extracted Meeting ID)';
        }
      }

      // Fallback: Try with driveItemId as meetingId (might work sometimes)
      if (!vttContent) {
        console.log(`[Ingest] Fallback: trying driveItemId as meetingId`);
        try {
          vttContent = await fetchTeamsTranscript(accessToken, teamsMeetingId);
          source = 'Microsoft Teams API (Fallback)';
        } catch (fallbackErr) {
          console.log(`[Ingest] DriveItemId as meetingId failed:`, fallbackErr.message);
        }
      }
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

          // Re-calculate shortcut path for fallback
          let fbPath = resourcePath;
          let fbId = teamsMeetingId;
          const fbTargetId = meetingData?.targetId || teamsMeetingId;
          const fbTargetDrive = meetingData?.targetDriveId;

          if (fbTargetDrive && meetingData?.isShortcut) {
            fbPath = `/drives/${fbTargetDrive}/items/${fbTargetId}`;
            fbId = fbTargetId;
          }

          vttContent = await fetchVideoTranscript(accessToken, fbId, fbPath);
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
    userId: meetingData?.userId || null,
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
export async function ingestProvidedTranscript(vttContent, externalId, source = 'Manual Upload', userId = null) {
  if (!vttContent || vttContent.trim().length === 0) {
    throw new Error('EMPTY_TRANSCRIPT_CONTENT');
  }

  const entries = parseVTT(vttContent, `manual_${externalId}.vtt`);
  if (!entries || entries.length === 0) throw new Error('PARSER_FAILED');

  const meetingId = `file-${externalId.substring(0, 8)}`;

  const meetingObj = {
    meetingId,
    userId,
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

/**
 * Handle real-time transcript updates from the Bot
 */
export async function ingestBotTranscript(externalMeetingId, vttContent, metadata = {}) {
  if (!vttContent || vttContent.trim().length === 0) return;

  // 1. Normalize into meeting structure
  // Handle case where we joined via manual link (no external ID)
  const safeId = externalMeetingId || `link-${Date.now().toString().slice(-8)}`;
  const meetingId = `bot-${safeId.substring(0, 12)}`;

  console.log(`[Ingest] Processing bot transcript for ${meetingId} (${vttContent.length} bytes)`);

  // Use the REAL PARSER to decode the VTT we just generated
  const entries = parseVTT(vttContent, `bot_${meetingId}.vtt`);

  if (!entries || entries.length === 0) {
    console.warn(`[Ingest] Bot VTT parser returned 0 entries for ${meetingId}`);
    return;
  }

  // Extract unique participants for better presentation
  const participants = [...new Set(entries.map(e => e.speaker))].filter(Boolean);

  const meetingObj = {
    meetingId,
    userId: metadata.userId || null,
    source: 'Bot Live Transcription',
    externalId: externalMeetingId,
    subject: metadata.subject || 'Live Bot Meeting',
    participants,
    importedAt: new Date().toISOString(),
    durationSeconds: calculateDuration(entries),
    status: metadata.final ? 'Finalized' : 'In-Progress',
    entries: entries.map((e, idx) => ({
      id: `${meetingId}:${String(idx + 1).padStart(4, '0')}`,
      sequence: idx + 1,
      ...e
    }))
  };

  // 2. Save/Update in MongoDB
  await storage.saveTranscripts(meetingObj);
  console.log(`[Ingest] ✅ Meeting ${meetingId} saved to database`);

  // 3. Update RAG Chunks (Vectorize only if requested or if it's the final sync)
  const shouldVectorize = metadata.final || false;
  return processChunksAndSave(meetingObj, entries, shouldVectorize);
}

// Helper to chunk and save
async function processChunksAndSave(meetingObj, entries, shouldVectorize = true) {
  const chunks = chunkEntries(entries);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    c.meetingId = meetingObj.meetingId;
    c.userId = meetingObj.userId; // Propagate userId for data isolation
    c.chunkId = `${meetingObj.meetingId}#${String(i + 1).padStart(4, '0')}`;
  }

  // Vectorization is optional for live updates to save resources
  if (shouldVectorize) {
    try {
      await vectorizeAndSaveChunks(meetingObj.meetingId, chunks);
    } catch (e) {
      console.error(`[Ingest] Vectorization failed for ${meetingObj.meetingId}, falling back to standard save:`, e.message);
      await storage.saveChunks(chunks);
    }
  } else {
    // Just save standard chunks for keyword search
    await storage.saveChunks(chunks);
  }

  return meetingObj;
}

export async function loadTranscripts(userId = null) {
  return await storage.loadTranscripts(userId);
}

export async function getMeeting(meetingId) {
  return await storage.getMeeting(meetingId);
}

export async function loadChunksForMeeting(meetingId, userId = null) {
  return await storage.loadChunks(meetingId, userId);
}

export async function updateMeeting(meetingId, updateData) {
  return await storage.updateMeeting(meetingId, updateData);
}

export async function deleteMeeting(meetingId, userId = null) {
  return await storage.deleteMeeting(meetingId, userId);
}

function calculateDuration(entries) {
  if (!entries || entries.length === 0) return 0;
  const lastEntry = entries[entries.length - 1];
  const end = lastEntry.end || lastEntry.start;
  const parts = (end || '00:00:00').split(':');
  if (parts.length < 3) return 0;
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
}

