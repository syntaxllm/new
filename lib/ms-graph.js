/**
 * MS Graph Service (Production)
 * Handles Transcripts, Recordings, and Meeting Metadata
 */

/**
 * List Recent Meetings (Organizer OR Attendee)
 * Fetches recent online meetings from the user's calendar where they participated
 * (as organizer or attendee). This works for both roles.
 */
/**
 * List Recent Meetings (Organizer OR Attendee)
 * Fetches recent online meetings from:
 * 1. Calendar View (Scheduled meetings)
 * 2. OnlineMeetings API (Ad-hoc / Meet Now where I am organizer)
 */
export async function listRecentMeetings(accessToken) {
    const now = new Date();
    const lastMonth = new Date(now);
    lastMonth.setDate(lastMonth.getDate() - 60); // Look back 60 days

    // Helper: Fetch from Calendar
    async function fetchCalendarMeetings() {
        const start = lastMonth.toISOString();
        const end = now.toISOString();
        const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${start}&endDateTime=${end}&$orderby=start/dateTime desc&$top=50`;

        try {
            const res = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
            if (!res.ok) return [];
            const data = await res.json();
            return data.value
                .filter(m => m.isOnlineMeeting === true)
                .map(m => ({
                    id: m.onlineMeeting?.id || m.onlineMeeting?.joinUrl || m.id,
                    subject: m.subject,
                    start: m.start.dateTime,
                    end: m.end.dateTime,
                    webUrl: m.onlineMeeting?.joinUrl,
                    onlineMeetingId: m.onlineMeeting?.id,
                    organizer: m.organizer,
                    source: 'calendar'
                }));
        } catch (e) {
            console.warn('Calendar fetch failed', e);
            return [];
        }
    }

    // Helper: Fetch direct OnlineMeetings (catches "Meet Now" where I am owner)
    async function fetchOnlineMeetings() {
        // v1.0 allow listing with top. Ordered by creationDateTime usually.
        const url = `https://graph.microsoft.com/v1.0/me/onlineMeetings?$top=20`;
        try {
            const res = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
            if (!res.ok) return [];
            const data = await res.json();
            return data.value.map(m => ({
                id: m.id,
                subject: m.subject || 'Untitled Meeting',
                start: m.startDateTime,
                end: m.endDateTime,
                webUrl: m.joinWebUrl,
                onlineMeetingId: m.id,
                // If it comes from /me/onlineMeetings, I am implicitly the organizer
                isOrganizer: true,
                source: 'onlineMeeting'
            }));
        } catch (e) {
            console.warn('OnlineMeetings fetch failed', e);
            return [];
        }
    }

    // Helper: Fetch from the SPECIAL "Recordings" folder (Locale agnostic)
    // This is the most reliable way to find Teams recordings saved to OneDrive
    async function fetchOneDriveRecordings() {
        // Use the 'special' segment to find the folder named 'recordings' regardless of language
        const url = `https://graph.microsoft.com/v1.0/me/drive/special/recordings/children?$top=50&$orderby=createdDateTime desc`;

        try {
            const res = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });

            // If the special folder doesn't exist (no recordings ever made), it returns 404.
            if (!res.ok) {
                if (res.status === 404) return [];
                console.warn(`Recordings folder fetch error: ${res.status}`);
                return [];
            }

            const data = await res.json();
            console.log(`[OneDrive] Found ${data.value?.length || 0} items in Recordings folder`);

            // Map both VIDEO files and VTT files (if they exist separately)
            return data.value
                .filter(f => f.file) // Only files
                .map(f => {
                    const isVideo = f.name.toLowerCase().endsWith('.mp4') || f.name.toLowerCase().endsWith('.mov');
                    const isVtt = f.name.toLowerCase().endsWith('.vtt');

                    console.log(`[OneDrive] Processing file: ${f.name} (isVideo: ${isVideo}, isVtt: ${isVtt})`);

                    if (!isVideo && !isVtt) return null; // Skip unknown files

                    return {
                        id: f.id,
                        driveId: f.parentReference?.driveId,
                        subject: f.name,
                        start: f.createdDateTime,
                        end: f.lastModifiedDateTime,
                        webUrl: f.webUrl,
                        downloadUrl: f['@microsoft.graph.downloadUrl'],
                        driveItemId: f.id,
                        onlineMeetingId: null,
                        isOrganizer: true, // It's in my drive
                        source: 'onedrive',
                        isVttFile: isVtt,
                        resourcePath: f.parentReference?.driveId ? `/drives/${f.parentReference.driveId}/items/${f.id}` : `/me/drive/items/${f.id}`
                    };
                })
                .filter(Boolean); // Remove nulls

        } catch (e) {
            console.warn('OneDrive Special/Recordings fetch failed', e);
            return [];
        }
    }

    // Helper: Broad Search for VTT and Video files (Catches SharePoint, Channels, and Shared files)
    async function fetchGlobalMeetingSearch() {
        const url = `https://graph.microsoft.com/v1.0/search/query`;
        const body = {
            requests: [
                {
                    entityTypes: ['driveItem'],
                    query: {
                        // Search for VTT files OR MP4 files that look like recordings
                        queryString: "filetype:vtt OR (filetype:mp4 AND \"Meeting Recording\")"
                    },
                    from: 0,
                    size: 50
                }
            ]
        };

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (!res.ok) return [];
            const data = await res.json();

            const hits = data.value[0]?.hitsContainers[0]?.hits || [];
            console.log(`[Global Search] Found ${hits.length} recordings/transcripts across all accessible sites/drives`);

            return hits.map(h => {
                const resource = h.resource;
                const isVtt = resource.name.toLowerCase().endsWith('.vtt');
                const driveId = resource.parentReference?.driveId;

                return {
                    id: resource.id,
                    driveId: driveId,
                    subject: resource.name,
                    start: resource.createdDateTime,
                    end: resource.lastModifiedDateTime,
                    webUrl: resource.webUrl,
                    downloadUrl: resource['@microsoft.graph.downloadUrl'],
                    driveItemId: resource.id,
                    onlineMeetingId: null,
                    isOrganizer: true,
                    source: 'onedrive',
                    isVttFile: isVtt,
                    // Store the full resource path for easier retrieval
                    resourcePath: driveId ? `/drives/${driveId}/items/${resource.id}` : `/me/drive/items/${resource.id}`
                };
            });
        } catch (e) {
            console.warn('Global meeting search failed', e);
            return [];
        }
    }

    // Helper: Fallback for explicit path listing
    async function fetchOneDrivePathRecordings() {
        // Try multiple common paths for recordings
        const paths = ['/me/drive/root:/Recordings:', '/me/drive/special/recordings'];
        let allFiles = [];

        for (const pathPrefix of paths) {
            try {
                const url = `https://graph.microsoft.com/v1.0${pathPrefix}/children?$top=50&$orderby=createdDateTime desc`;
                const res = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
                if (res.ok) {
                    const data = await res.json();
                    const files = (data.value || [])
                        .filter(f => f.file && (f.name.toLowerCase().endsWith('.mp4') || f.name.toLowerCase().endsWith('.vtt')))
                        .map(f => ({
                            id: f.id,
                            driveId: f.parentReference?.driveId,
                            subject: f.name,
                            start: f.createdDateTime,
                            end: f.lastModifiedDateTime,
                            webUrl: f.webUrl,
                            downloadUrl: f['@microsoft.graph.downloadUrl'],
                            driveItemId: f.id,
                            onlineMeetingId: null,
                            isOrganizer: true,
                            source: 'onedrive',
                            isVttFile: f.name.toLowerCase().endsWith('.vtt'),
                            resourcePath: f.parentReference?.driveId ? `/drives/${f.parentReference.driveId}/items/${f.id}` : `/me/drive/items/${f.id}`
                        }));
                    allFiles = [...allFiles, ...files];
                }
            } catch (e) { /* ignore */ }
        }
        return allFiles;
    }

    const [calendarMeetings, onlineMeetings, driveRecordings, pathRecordings, searchRecordings] = await Promise.all([
        fetchCalendarMeetings(),
        fetchOnlineMeetings(),
        fetchOneDriveRecordings(),
        fetchOneDrivePathRecordings(),
        fetchGlobalMeetingSearch()
    ]);

    // Merge and Deduplicate
    const all = [...searchRecordings, ...pathRecordings, ...driveRecordings, ...onlineMeetings, ...calendarMeetings];
    const unique = new Map();

    for (const m of all) {
        // Filter out FUTURE meetings (Calendar items)
        if (m.source === 'calendar' && new Date(m.start) > now) continue;

        const key = m.webUrl || m.id; // Use WebURL as best specific key
        if (!unique.has(key)) {
            unique.set(key, m);
        } else {
            // If we already have this meeting from Calendar/API, but now we found a File for it?
            // It's hard to match File WebURL with Meeting Join URL. They are different.
            // We will likely have duplicates if the meeting appears in both.
            // But usually P2P calls ONLY appear in Drive.
            // So safe to just add.
        }
    }

    // Sort by recent start time
    return Array.from(unique.values()).sort((a, b) => new Date(b.start) - new Date(a.start));
}

/**
 * Check transcript access status for a Teams meeting.
 * Returns detailed status: whether transcripts exist AND whether user has access.
 *
 * Returns:
 *   - { hasAccess: true, transcriptsExist: true } => User can access transcripts
 *   - { hasAccess: false, transcriptsExist: true, needsPermission: true } => Transcripts exist but user needs permission
 *   - { hasAccess: false, transcriptsExist: false } => No transcripts available
 */
export async function checkTranscriptAccess(accessToken, meetingIdOrUrl) {
    try {
        let resolvedId;
        try {
            resolvedId = await resolveOnlineMeetingId(accessToken, meetingIdOrUrl);
        } catch (resolveErr) {
            // If we can't resolve the meeting ID (common for attendees),
            // assume the meeting exists (it's in their calendar) and they need permission
            console.log(`Could not resolve meeting ID (likely attendee): ${resolveErr.message}`);
            return { hasAccess: false, transcriptsExist: true, needsPermission: true };
        }

        const transcriptsUrl = `https://graph.microsoft.com/v1.0/me/onlineMeetings/${resolvedId}/transcripts`;

        const response = await fetch(transcriptsUrl, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        // 404 = No transcript available OR no access (can't distinguish for attendees)
        if (response.status === 404) {
            // For attendees, 404 often means they don't have access, not that transcripts don't exist
            // Try to verify meeting exists - if it does, assume transcripts might exist
            try {
                const meetingInfo = await getMeetingInfo(accessToken, resolvedId);
                // Meeting exists - for attendees, assume transcripts might exist but need permission
                return { hasAccess: false, transcriptsExist: true, needsPermission: true };
            } catch (infoErr) {
                // Can't access meeting info - might be attendee without access
                // Still assume transcripts might exist (meeting is in their calendar)
                console.log(`Could not get meeting info (likely attendee): ${infoErr.message}`);
                return { hasAccess: false, transcriptsExist: true, needsPermission: true };
            }
        }

        // 403 = Forbidden - transcripts exist but user doesn't have permission
        if (response.status === 403) {
            return { hasAccess: false, transcriptsExist: true, needsPermission: true };
        }

        // Any other non-OK status = Likely permission issue for attendees
        if (!response.ok) {
            console.warn(`checkTranscriptAccess: non-ok status ${response.status} for meeting ${resolvedId}`);
            // For non-OK status, assume user might need permission (especially for attendees)
            return { hasAccess: false, transcriptsExist: true, needsPermission: true };
        }

        const data = await response.json();

        // STRICT CHECK: Must have at least one transcript in the array
        const hasTranscripts = Array.isArray(data.value) && data.value.length > 0;

        if (hasTranscripts) {
            return { hasAccess: true, transcriptsExist: true, needsPermission: false };
        } else {
            // Empty array - transcripts endpoint exists but no transcripts yet
            return { hasAccess: false, transcriptsExist: false, needsPermission: false };
        }
    } catch (err) {
        console.warn(`checkTranscriptAccess failed for meeting:`, err?.message || err);
        // On error, assume transcripts might exist but user needs permission (especially for attendees)
        return { hasAccess: false, transcriptsExist: true, needsPermission: true };
    }
}

/**
 * Legacy function for backward compatibility
 * Returns true only if user has access to transcripts
 */
export async function hasTeamsTranscript(accessToken, meetingIdOrUrl) {
    const status = await checkTranscriptAccess(accessToken, meetingIdOrUrl);
    return status.hasAccess === true;
}
/**
 * Resolve a Teams meeting identifier to the actual `onlineMeeting` ID needed
 * for transcripts/recordings APIs. Works for both organizers and attendees.
 *
 * - If the input already looks like an ID (non-URL), it's returned as-is.
 * - If it's a join URL, we try multiple methods:
 *   1. Query /me/onlineMeetings?$filter=joinWebUrl eq '...' (works for organizer)
 *   2. Query /me/onlineMeetings (list all) and find by joinWebUrl (works for attendee)
 */
async function resolveOnlineMeetingId(accessToken, meetingKey) {
    if (!meetingKey) throw new Error('MISSING_MEETING_IDENTIFIER');

    // Heuristic: if it looks like a URL, treat it as joinWebUrl
    const isUrl = typeof meetingKey === 'string' && /^https?:\/\//i.test(meetingKey);
    if (!isUrl) {
        // Already looks like an ID, return as-is
        return meetingKey;
    }

    // Method 1: Try filter query (works for organizers)
    try {
        const filter = encodeURIComponent(`joinWebUrl eq '${meetingKey}'`);
        const url = `https://graph.microsoft.com/v1.0/me/onlineMeetings?$filter=${filter}`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (response.ok) {
            const data = await response.json();
            if (data.value && data.value.length > 0) {
                return data.value[0].id;
            }
        }
    } catch (err) {
        console.warn('Filter query failed, trying alternative method:', err?.message);
    }

    // Method 2: List all onlineMeetings and find by joinWebUrl (works for attendees)
    // Note: This might be slower but works for both organizer and attendee roles
    try {
        const url = `https://graph.microsoft.com/v1.0/me/onlineMeetings?$top=100`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (response.ok) {
            const data = await response.json();
            if (data.value && Array.isArray(data.value)) {
                const match = data.value.find(m => m.joinWebUrl === meetingKey);
                if (match) {
                    return match.id;
                }
            }
        }
    } catch (err) {
        console.warn('List query failed:', err?.message);
    }

    // If both methods fail, throw error
    throw new Error('NO_ONLINE_MEETING_FOR_JOIN_URL');
}

export async function fetchTeamsTranscript(accessToken, meetingIdOrUrl) {
    const resolvedId = await resolveOnlineMeetingId(accessToken, meetingIdOrUrl);
    const baseUrl = `https://graph.microsoft.com/v1.0/me/onlineMeetings/${resolvedId}`;
    const transcriptsUrl = `${baseUrl}/transcripts`;

    const response = await fetch(transcriptsUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    console.log(`[Graph API] Transcript List response for meeting ${resolvedId}: status ${response.status}`);

    // IMPORTANT:
    // A 404 here is usually *not* a server bug – it means Graph has
    // no transcripts for this meeting ID (wrong ID, no transcription, or
    // feature not enabled). We surface this as a clean, semantic error
    // instead of an opaque 500 in the API route.
    if (response.status === 404) {
        console.warn(`Transcript not found for meeting ${resolvedId}: 404`);
        throw new Error('NO_TRANSCRIPTS_FOR_MEETING');
    }

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`Transcript List Error ${response.status}:`, errorText);
        throw new Error(`Transcript List Error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.value || data.value.length === 0) {
        console.warn(`No transcripts in response for meeting ${resolvedId}`);
        throw new Error('NO_TRANSCRIPTS_FOR_MEETING');
    }

    const transcript = data.value[0];
    console.log(`Found transcript ${transcript.id} for meeting ${resolvedId}`);

    // Microsoft Graph API provides transcript content via transcriptContentUrl property
    // OR via the /content endpoint. Try both approaches.
    let contentUrl = null;

    // Method 1: Check if transcriptContentUrl is provided directly
    if (transcript.transcriptContentUrl) {
        contentUrl = transcript.transcriptContentUrl;
        console.log(`Using transcriptContentUrl: ${contentUrl}`);
    } else {
        // Method 2: Use the /content endpoint
        contentUrl = `${transcriptsUrl}/${transcript.id}/content`;
        console.log(`Using content endpoint: ${contentUrl}`);
    }

    const contentRes = await fetch(contentUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!contentRes.ok) {
        const errorText = await contentRes.text();
        console.error(`Transcript Content Error ${contentRes.status}:`, errorText);
        throw new Error(`Transcript Content Error: ${contentRes.status}`);
    }

    const vttContent = await contentRes.text();

    // Validate that we actually got content
    if (!vttContent || vttContent.trim().length === 0) {
        console.error(`Empty transcript content for meeting ${resolvedId}`);
        throw new Error('EMPTY_TRANSCRIPT_CONTENT');
    }

    console.log(`Successfully fetched transcript content (${vttContent.length} chars) for meeting ${resolvedId}`);
    return vttContent;
}

/**
 * NEW: Fetch Recording Metadata and Download URL
 * Requires: OnlineMeetingRecording.Read.All
 */
export async function fetchTeamsRecording(accessToken, meetingIdOrUrl) {
    const resolvedId = await resolveOnlineMeetingId(accessToken, meetingIdOrUrl);
    const url = `https://graph.microsoft.com/v1.0/me/onlineMeetings/${resolvedId}/recordings`;

    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!response.ok) throw new Error(`Recording List Error: ${response.status}`);
    const data = await response.json();

    if (!data.value || data.value.length === 0) return null;

    // This returns metadata including 'contentUrl' which is the download link
    return data.value[0];
}

/**
 * Get Meeting Info (Subject, Attendees, etc)
 */
export async function getMeetingInfo(accessToken, meetingIdOrUrl) {
    const resolvedId = await resolveOnlineMeetingId(accessToken, meetingIdOrUrl);
    const url = `https://graph.microsoft.com/v1.0/me/onlineMeetings/${resolvedId}`;
    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    // If not found (404), throw strict error
    if (response.status === 404) {
        throw new Error('MEETING_NOT_FOUND');
    }

    // Handle other errors
    if (!response.ok) {
        throw new Error(`GET_MEETING_INFO_FAILED: ${response.status}`);
    }

    return await response.json();
}

/**
 * Fetch content of a file from OneDrive
 */
export async function fetchOneDriveFileContent(accessToken, downloadUrlOrId, resourcePath = null) {
    let url = downloadUrlOrId;

    // If it's an ID or path, we need to get the download URL first
    if (!downloadUrlOrId || !downloadUrlOrId.startsWith('http')) {
        const fetchPath = resourcePath || (downloadUrlOrId ? `/me/drive/items/${downloadUrlOrId}` : null);
        if (!fetchPath) throw new Error('MISSING_FILE_IDENTIFIER');

        const fullPath = fetchPath.startsWith('http') ? fetchPath : `https://graph.microsoft.com/v1.0${fetchPath}`;

        const res = await fetch(fullPath, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!res.ok) throw new Error(`OneDrive File Metadata Error: ${res.status}`);
        const data = await res.json();
        url = data['@microsoft.graph.downloadUrl'];
    }

    if (!url) throw new Error('NO_DOWNLOAD_URL');

    const response = await fetch(url);
    if (!response.ok) throw new Error(`OneDrive File Content Error: ${response.status}`);

    return await response.text();
}

/**
 * NEW: Fetch transcript associated with a Video file (Stream on SharePoint)
 * Uses the textTracks API on the DriveItem
 */
export async function fetchVideoTranscript(accessToken, driveItemId, resourcePath = null) {
    console.log(`[Graph API] Checking textTracks for Video Item: ${driveItemId}`);

    // 1. List text tracks for the video
    const itemPath = resourcePath || `/me/drive/items/${driveItemId}`;
    const listUrl = `https://graph.microsoft.com/v1.0${itemPath}/textTracks`;

    const res = await fetch(listUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!res.ok) {
        console.warn(`[Graph API] Failed to list textTracks for ${driveItemId}: ${res.status}`);
        return null;
    }

    const data = await res.json();
    const tracks = data.value || [];

    // 2. Find a transcript track (usually language is defined)
    // Preference: 'transcript' or 'caption' types
    const transcriptTrack = tracks.find(t => t.language) || tracks[0];

    if (!transcriptTrack) {
        console.log(`[Graph API] No textTracks found for video ${driveItemId}`);
        return null;
    }

    console.log(`[Graph API] Found transcript track: ${transcriptTrack.id} (${transcriptTrack.language})`);

    // 3. Fetch the .vtt content
    const contentUrl = `${listUrl}/${transcriptTrack.id}/content`;
    const contentRes = await fetch(contentUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!contentRes.ok) {
        throw new Error(`Failed to fetch textTrack content: ${contentRes.status}`);
    }

    return await contentRes.text();
}
