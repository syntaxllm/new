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

    // Helper: Fetch from the EXACT Recordings folder (Direct Path)
    async function fetchOneDriveRecordings() {
        const path = '/me/drive/root:/Recordings:';
        const url = `https://graph.microsoft.com/v1.0${path}/children?$top=100`;

        console.log(`[Discovery] Traveling to: ${url}`);
        try {
            const res = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });

            if (!res.ok) {
                console.warn(`[Discovery] Roadblock at /Recordings: HTTP ${res.status} (${res.statusText})`);
                // If 404, we'll try a manual root scan as a backup
                if (res.status === 404) return await scanRootForRecordings();
                return [];
            }

            const data = await res.json();
            console.log(`[Discovery] Success! Found ${data.value?.length || 0} items in /Recordings`);
            if (data.value && data.value.length > 0) {
                console.log('[DEBUG_RAW] First Item:', JSON.stringify(data.value[0], null, 2));
            }

            const allFiles = (data.value || [])
                .filter(f => {
                    const name = (f.name || '').toLowerCase();
                    // Only include .mp4 files from Recordings folder (skip .vtt files for now)
                    return f.file && name.endsWith('.mp4');
                })
                .map(f => {
                    // CRITICAL: Check if this is a "Shortcut" or "Link" to the real file
                    const isShortcut = !!f.remoteItem;
                    const realId = isShortcut ? f.remoteItem.id : f.id;
                    const realDriveId = isShortcut ? f.remoteItem.parentReference?.driveId : f.parentReference?.driveId;

                    if (isShortcut) {
                        console.log(`[Discovery] Found Shortcut! ${f.name} -> points to ${realId} on drive ${realDriveId}`);
                    }

                    return {
                        id: f.id,
                        driveId: f.parentReference?.driveId,
                        targetId: realId,
                        targetDriveId: realDriveId,
                        isShortcut: isShortcut,
                        subject: f.name,
                        start: f.createdDateTime,
                        end: f.lastModifiedDateTime,
                        webUrl: f.webUrl,
                        downloadUrl: f['@microsoft.graph.downloadUrl'],
                        driveItemId: f.id,
                        onlineMeetingId: null,
                        isOrganizer: true,
                        source: 'onedrive',
                        isVttFile: false, // We're only processing .mp4 files from Recordings
                        // Point resourcePath to the REAL file if it's a shortcut
                        resourcePath: realDriveId ? `/drives/${realDriveId}/items/${realId}` : `/me/drive/items/${realId}`,
                        // Extract siteId for SharePoint Lists API access
                        siteId: isShortcut ? f.remoteItem?.parentReference?.siteId : f.parentReference?.siteId
                    };
                });

            // Since we're only processing .mp4 files from Recordings, no VTT matching needed
            const mp4Files = allFiles;
            const shortcutsToScan = [];

            for (const file of mp4Files) {
                // If it's a shortcut, track it so we can check its source folder for transcripts
                if (file.isShortcut && file.targetDriveId) {
                    const parentId = file.remoteItem?.parentReference?.id;
                    const siteId = file.remoteItem?.parentReference?.siteId;
                    if (parentId) {
                        shortcutsToScan.push({
                            mp4: file,
                            driveId: file.targetDriveId,
                            folderId: parentId,
                            siteId: siteId
                        });
                    }
                }
            }

            // 2. Scan Source Folders for Shortcuts
            // (Many shortcuts might point to the same folder, so deduplicate)
            const scannedFolders = new Set();
            for (const scan of shortcutsToScan) {
                const key = `${scan.driveId}/${scan.folderId}`;
                if (scannedFolders.has(key)) continue;
                scannedFolders.add(key);

                console.log(`[Discovery] 🕵️ Following shortcut to SharePoint folder: ${key}`);
                try {
                    // PRIORITY 1: Try SharePoint Lists API if we have siteId
                    if (scan.siteId) {
                        console.log(`[Discovery] 🎯 Trying SharePoint Lists API for shortcut target`);
                        const vttContent = await fetchSharePointListTranscript(accessToken, scan.siteId, scan.driveId, scan.folderId, scan.mp4.subject);
                        if (vttContent) {
                            console.log(`[Discovery] 🎯 FOUND VTT via SharePoint Lists API for ${scan.mp4.subject}`);
                            scan.mp4.vttContent = vttContent;
                            scan.mp4.hasTranscript = true;
                            continue; // Skip Drive API scan if we found it via Lists
                        }
                    }

                    // PRIORITY 2: Fallback to Drive API sibling scan
                    const sibUrl = `https://graph.microsoft.com/v1.0/drives/${scan.driveId}/items/${scan.folderId}/children?$select=id,name,parentReference`;
                    const sibRes = await fetch(sibUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
                    if (sibRes.ok) {
                        const sibData = await sibRes.json();
                        const siblings = sibData.value || [];
                        console.log(`[Discovery] Found ${siblings.length} items in source folder`);

                        // Check these siblings for VTTs matching our MP4s
                        for (const sibling of siblings) {
                            const siblingName = sibling.name.toLowerCase();
                            
                            // Look for transcript files that match our MP4s
                            const isTextTranscriptFile = siblingName.endsWith('.vtt') || siblingName.endsWith('.srt') || siblingName.endsWith('.txt');
                            if (isTextTranscriptFile) {
                                
                                const vttBase = siblingName.replace(/\.(vtt|txt|srt)$/i, '');
                                
                                // Does this transcript match any of our shortcut MP4s?
                                const match = shortcutsToScan.find(s =>
                                    s.driveId === scan.driveId &&
                                    s.folderId === scan.folderId &&
                                    (s.mp4.subject.toLowerCase().replace(/\.mp4$/i, '').includes(vttBase) ||
                                    vttBase.includes(s.mp4.subject.toLowerCase().replace(/\.mp4$/i, '')))
                                );

                                if (match) {
                                    console.log(`[Discovery] 🎯 FOUND REMOTE TRANSCRIPT: ${sibling.name} for ${match.mp4.subject}`);
                                    match.mp4.vttResourcePath = `/drives/${scan.driveId}/items/${sibling.id}`;
                                    match.mp4.hasTranscript = true;
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.warn(`[Discovery] Failed to scan source folder ${key}`, err);
                }
            }

            // Attach VTT paths to MP4 files (only from shortcut scanning)
            // Since we're only processing .mp4 files, we don't need local VTT matching
            console.log(`[Discovery] Processed ${mp4Files.length} MP4 files from Recordings folder`);
            return mp4Files;
        } catch (e) {
            console.error('[Discovery] Crash while traveling to OneDrive', e);
            return [];
        }
    }

    // BACKUP: Scan all root folders if the direct path fails
    async function scanRootForRecordings() {
        console.log('[Discovery] Direct path failed. Scanning OneDrive Root manually...');
        const url = `https://graph.microsoft.com/v1.0/me/drive/root/children?$select=name,id,folder`;
        try {
            const res = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
            if (!res.ok) return [];
            const data = await res.json();

            const folders = (data.value || []).filter(f => f.folder);
            console.log(`[Discovery] Folders found in root: ${folders.map(f => f.name).join(', ')}`);

            const recFolder = folders.find(f => f.name.toLowerCase() === 'recordings');
            if (recFolder) {
                console.log(`[Discovery] Found a match! Recordings folder ID is: ${recFolder.id}. Traveling inside...`);
                const contentsUrl = `https://graph.microsoft.com/v1.0/me/drive/items/${recFolder.id}/children`;
                const cRes = await fetch(contentsUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
                if (cRes.ok) {
                    const cData = await cRes.json();
                    return (cData.value || [])
                        .filter(f => f.file && f.name.toLowerCase().endsWith('.mp4')) // Only .mp4 files
                        .map(f => ({
                            id: f.id,
                            subject: f.name,
                            start: f.createdDateTime,
                            source: 'onedrive',
                            isVttFile: false, // Only processing .mp4 files
                            resourcePath: `/me/drive/items/${f.id}`,
                            siteId: f.parentReference?.siteId
                        }));
                }
            }
        } catch (e) { /* ignore */ }
        return [];
    }

    // Helper: Broad Search for VTT and Video files (Catches SharePoint, Channels, and Shared files)
    async function fetchGlobalMeetingSearch() {
        const url = `https://graph.microsoft.com/v1.0/search/query`;
        // Look back 30 days (as per user frustration with missing files)
        const dateThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        const body = {
            requests: [
                {
                    entityTypes: ['driveItem'],
                    query: {
                        // Focus on meeting recordings in Recordings folders
                        queryString: "filetype:mp4 \"Meeting Recording\" AND \"Recordings\""
                    },
                    from: 0,
                    size: 100
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
            console.log(`[Global Search] Found ${hits.length} recording files across all accessible sites/drives`);

            return hits
                .filter(h => {
                    const name = h.resource.name?.toLowerCase() || '';
                    return name.endsWith('.mp4') && name.includes('meeting recording');
                })
                .map(h => {
                    const resource = h.resource;
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
                        isVttFile: false, // Only .mp4 files
                        resourcePath: driveId ? `/drives/${driveId}/items/${resource.id}` : `/me/drive/items/${resource.id}`,
                        siteId: resource.parentReference?.siteId
                    };
                });
        } catch (e) {
            console.warn('Global meeting search failed', e);
            return [];
        }
    }


    // ONLY fetch from the Recordings folder. Nothing else.
    const driveRecordings = await fetchOneDriveRecordings();

    console.log(`[Discovery Stats] Recordings Folder ONLY: ${driveRecordings.length} files`);

    // Return ONLY the files from the Recordings folder. No merging, no deduplication, no noise.
    return driveRecordings;
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
 * Extract Teams meeting ID from recording filename
 * Teams recordings follow pattern: "Meeting Name-YYYYMMDD_HHMMSS-Meeting Recording.mp4"
 * This attempts to find the corresponding onlineMeeting for transcript access
 */
async function extractMeetingIdFromRecording(accessToken, recordingName, siteId, driveId, folderId) {
    try {
        console.log(`[Meeting ID] Extracting meeting ID from recording: ${recordingName}`);
        
        // Extract base meeting name (remove timestamp and suffix)
        const baseName = recordingName
            .replace(/-\d{8}_\d{6}-Meeting Recording\.mp4$/i, '') // Remove timestamp and suffix
            .replace(/\.mp4$/i, ''); // Remove .mp4 extension
        
        console.log(`[Meeting ID] Base meeting name for search: "${baseName}"`);
        
        // Method 1: Search onlineMeetings by subject/name
        try {
            const filter = encodeURIComponent(`contains(subject,'${baseName}')`);
            const url = `https://graph.microsoft.com/v1.0/me/onlineMeetings?$filter=${filter}&$top=20`;
            
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            
            if (response.ok) {
                const data = await response.json();
                const meetings = data.value || [];
                
                console.log(`[Meeting ID] Found ${meetings.length} meetings matching "${baseName}"`);
                
                // Try to find exact match by comparing cleaned names
                for (const meeting of meetings) {
                    const meetingSubject = (meeting.subject || '').toLowerCase();
                    const recordingBase = baseName.toLowerCase();
                    
                    // Various matching strategies
                    if (meetingSubject.includes(recordingBase) || 
                        recordingBase.includes(meetingSubject) ||
                        meetingSubject.replace(/[^a-zA-Z0-9\s]/g, '').includes(recordingBase.replace(/[^a-zA-Z0-9\s]/g, ''))) {
                        
                        console.log(`[Meeting ID] 🎯 Found matching meeting: ${meeting.id} (${meeting.subject})`);
                        return meeting.id;
                    }
                }
            }
        } catch (err) {
            console.warn(`[Meeting ID] OnlineMeetings search failed:`, err?.message);
        }
        
        // Method 2: Search calendar events by subject
        try {
            const now = new Date();
            const lastMonth = new Date(now);
            lastMonth.setDate(lastMonth.getDate() - 60);
            
            const start = lastMonth.toISOString();
            const end = now.toISOString();
            
            const filter = encodeURIComponent(`contains(subject,'${baseName}') and isOnlineMeeting eq true`);
            const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${start}&endDateTime=${end}&$filter=${filter}&$top=20`;
            
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            
            if (response.ok) {
                const data = await response.json();
                const events = data.value || [];
                
                console.log(`[Meeting ID] Found ${events.length} calendar events matching "${baseName}"`);
                
                for (const event of events) {
                    const eventSubject = (event.subject || '').toLowerCase();
                    const recordingBase = baseName.toLowerCase();
                    
                    if (eventSubject.includes(recordingBase) || 
                        recordingBase.includes(eventSubject)) {
                        
                        const onlineMeetingId = event.onlineMeeting?.id;
                        if (onlineMeetingId) {
                            console.log(`[Meeting ID] 🎯 Found matching calendar event: ${onlineMeetingId} (${event.subject})`);
                            return onlineMeetingId;
                        }
                    }
                }
            }
        } catch (err) {
            console.warn(`[Meeting ID] Calendar search failed:`, err?.message);
        }
        
        // Method 3: Try SharePoint search for meeting-related items
        if (siteId) {
            try {
                console.log(`[Meeting ID] Searching SharePoint for meeting artifacts...`);
                
                // Search for meeting-related items in SharePoint
                const searchUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/search/query`;
                const searchBody = {
                    requests: [{
                        entityTypes: ['listItem', 'driveItem'],
                        query: {
                            queryString: `"${baseName}" Meeting OR OnlineMeeting`
                        },
                        from: 0,
                        size: 20
                    }]
                };
                
                const response = await fetch(searchUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(searchBody)
                });
                
                if (response.ok) {
                    const data = await response.json();
                    const hits = data.value?.[0]?.hitsContainers?.[0]?.hits || [];
                    
                    console.log(`[Meeting ID] Found ${hits.length} SharePoint search results`);
                    
                    for (const hit of hits) {
                        const resource = hit.resource;
                        
                        // Look for meeting ID in the resource
                        if (resource.fields?.OnlineMeetingId || resource.onlineMeetingId) {
                            const meetingId = resource.fields?.OnlineMeetingId || resource.onlineMeetingId;
                            console.log(`[Meeting ID] 🎯 Found meeting ID in SharePoint: ${meetingId}`);
                            return meetingId;
                        }
                    }
                }
            } catch (err) {
                console.warn(`[Meeting ID] SharePoint search failed:`, err?.message);
            }
        }
        
        console.log(`[Meeting ID] ❌ Could not extract meeting ID from recording: ${recordingName}`);
        return null;
        
    } catch (error) {
        console.error(`[Meeting ID] Error extracting meeting ID:`, error);
        return null;
    }
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
    console.log(`[Graph API] Resource Path: ${resourcePath}`);

    // 1. List text tracks for the video
    const itemPath = resourcePath || `/me/drive/items/${driveItemId}`;
    // USE BETA ENDPOINT: v1.0 often returns 404 for Stream on SharePoint tracks
    const listUrl = `https://graph.microsoft.com/beta${itemPath}/textTracks`;

    console.log(`[Graph API] Fetching textTracks (BETA) from: ${listUrl}`);

    const res = await fetch(listUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!res.ok) {
        console.warn(`[Graph API] Failed to list textTracks: HTTP ${res.status} ${res.statusText}`);

        // SIBLING SCAN STRATEGY:
        // The resourcePath might be an ID path, or the user might have weird naming.
        // We fetch the item's metadata to find its parent, then scan the parent folder.
        try {
            console.log(`[Graph API] 🕵️ textTracks failed. Scanning siblings for VTT...`);

            // 1. Get Item Metadata to find Parent
            const metaUrl = `https://graph.microsoft.com/v1.0${resourcePath}`;
            const metaRes = await fetch(metaUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });

            if (metaRes.ok) {
                const meta = await metaRes.json();
                const parentId = meta.parentReference?.id;
                const driveId = meta.parentReference?.driveId;
                const myName = meta.name; // e.g. "Meeting.mp4"
                const siteId = meta.parentReference?.siteId;

                if (parentId && driveId && myName) {
                    // 2. Try SharePoint Lists API for hidden attachments
                    if (siteId) {
                        console.log(`[Graph API] 🎯 Trying SharePoint Lists API for site ${siteId}`);
                        const vttContent = await fetchSharePointListTranscript(accessToken, siteId, driveId, parentId, myName);
                        if (vttContent) {
                            return vttContent;
                        }
                    }

                    // 3. Fallback: Scan Parent Folder for Drive Items
                    const sibUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}/children?$select=id,name,@microsoft.graph.downloadUrl`;
                    const sibRes = await fetch(sibUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });

                    if (sibRes.ok) {
                        const sibData = await sibRes.json();
                        const siblings = sibData.value || [];
                        console.log(`[Graph API] Found ${siblings.length} siblings in folder:`, siblings.map(s => s.name));

                        // 4. Find Matching VTT or Transcript Files
                        const baseName = myName.replace(/\.mp4$/i, '');
                        // Find any VTT or transcript file that *starts with* the video name
                        const transcriptMatch = siblings.find(s => {
                            const siblingName = s.name.toLowerCase();
                            const isTextTranscriptFile = siblingName.endsWith('.vtt') || siblingName.endsWith('.srt') || siblingName.endsWith('.txt');
                            const siblingBase = siblingName.replace(/\.(vtt|txt|srt)$/i, '');
                            return (
                                siblingBase.startsWith(baseName.toLowerCase()) &&
                                isTextTranscriptFile
                            );
                        });

                        if (transcriptMatch && transcriptMatch['@microsoft.graph.downloadUrl']) {
                            console.log(`[Graph API] 🎯 JACKPOT! Found transcript file: ${transcriptMatch.name}`);
                            const contentRes = await fetch(transcriptMatch['@microsoft.graph.downloadUrl']);
                            if (contentRes.ok) {
                                let content = await contentRes.text();
                                
                                // Convert to VTT if needed
                                if (!content.startsWith('WEBVTT')) {
                                    console.log(`[Graph API] Converting transcript to VTT format`);
                                    content = convertToVTT(content, transcriptMatch.name);
                                }
                                
                                return content;
                            }
                        }
                    }
                }
            }
        } catch (scanErr) {
            console.warn('[Graph API] Sibling scan failed', scanErr);
        }

        const errorText = await res.text();
        console.warn(`[Graph API] Error response:`, errorText);
        return null;
    }

    const data = await res.json();
    const tracks = data.value || [];

    console.log(`[Graph API] Found ${tracks.length} textTracks:`, tracks.map(t => ({ id: t.id, language: t.language, kind: t.kind })));

    // 2. Find a transcript track (usually language is defined)
    // Preference: 'transcript' or 'caption' types
    const transcriptTrack = tracks.find(t => t.language) || tracks[0];

    if (!transcriptTrack) {
        console.log(`[Graph API] No textTracks found for video ${driveItemId}`);
        return null;
    }

    console.log(`[Graph API] Selected transcript track: ${transcriptTrack.id} (${transcriptTrack.language})`);

    // 3. Fetch the .vtt content
    const contentUrl = `${listUrl}/${transcriptTrack.id}/content`;
    console.log(`[Graph API] Fetching VTT content from: ${contentUrl}`);

    const contentRes = await fetch(contentUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!contentRes.ok) {
        console.error(`[Graph API] Failed to fetch textTrack content: HTTP ${contentRes.status}`);
        throw new Error(`Failed to fetch textTrack content: ${contentRes.status}`);
    }

    const vttContent = await contentRes.text();
    console.log(`[Graph API] Successfully fetched VTT content (${vttContent.length} characters)`);
    return vttContent;
}

/**
 * NEW: Fetch transcript from SharePoint Lists API (for hidden VTT attachments)
 * This addresses the issue where VTT files are visible in SharePoint UI but not via Drive API
 * 
 * The VTT files are likely stored as List Item Attachments rather than Drive Items
 */
async function fetchSharePointListTranscript(accessToken, siteId, driveId, folderId, videoName) {
    try {
        console.log(`[SharePoint Lists] Searching for VTT attachments in site ${siteId}, folder ${folderId}`);
        
        // Get the SharePoint site details
        const siteUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}`;
        const siteRes = await fetch(siteUrl, { 
            headers: { 'Authorization': `Bearer ${accessToken}` } 
        });
        
        if (!siteRes.ok) {
            console.warn(`[SharePoint Lists] Failed to get site details: ${siteRes.status}`);
            return null;
        }
        
        const siteData = await siteRes.json();
        console.log(`[SharePoint Lists] Working with site: ${siteData.displayName}`);
        
        // Get all lists in the site
        const listsUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists`;
        const listsRes = await fetch(listsUrl, { 
            headers: { 'Authorization': `Bearer ${accessToken}` } 
        });
        
        if (!listsRes.ok) {
            console.warn(`[SharePoint Lists] Failed to get lists: ${listsRes.status}`);
            return null;
        }
        
        const listsData = await listsRes.json();
        const lists = listsData.value || [];
        
        console.log(`[SharePoint Lists] Found ${lists.length} lists in the site`);
        
        // Create multiple search patterns for the video name
        const baseVideoName = videoName.replace(/\.mp4$/i, '');
        const searchPatterns = [
            baseVideoName,
            baseVideoName.replace(/[-_]\d{8}_\d{6}/, ''), // Remove timestamp pattern
            baseVideoName.split('-').slice(0, -1).join('-').trim(), // Remove last segment
            baseVideoName.split('Meeting Recording')[0].trim() // Remove "Meeting Recording" suffix
        ].filter(pattern => pattern && pattern.length > 3);
        
        console.log(`[SharePoint Lists] Search patterns:`, searchPatterns);
        
        // Look for document libraries or asset lists that might contain our files
        for (const list of lists) {
            if (list.list?.template === 'documentLibrary' || 
                list.displayName.toLowerCase().includes('document') || 
                list.displayName.toLowerCase().includes('asset') ||
                list.displayName.toLowerCase().includes('media')) {
                
                console.log(`[SharePoint Lists] Checking list: ${list.displayName} (template: ${list.list?.template})`);
                
                // Try multiple approaches to find the transcript
                
                // APPROACH 1: Search for items by file name patterns
                for (const pattern of searchPatterns) {
                    console.log(`[SharePoint Lists] Searching with pattern: "${pattern}"`);
                    
                    const itemsUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${list.id}/items?$expand=fields,driveItem&$filter=contains(fields/Name,'${pattern}') or contains(fields/Title,'${pattern}')`;
                    const itemsRes = await fetch(itemsUrl, { 
                        headers: { 'Authorization': `Bearer ${accessToken}` } 
                    });
                    
                    if (itemsRes.ok) {
                        const itemsData = await itemsRes.json();
                        const items = itemsData.value || [];
                        
                        console.log(`[SharePoint Lists] Found ${items.length} items for pattern "${pattern}"`);
                        
                        // Check each item for VTT attachments or transcript files
                        for (const item of items) {
                            console.log(`[SharePoint Lists] Checking item: ${item.fields?.Name || item.fields?.Title || item.id}`);
                            
                            // APPROACH 1a: Check for attachments
                            const attachmentsUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${list.id}/items/${item.id}/attachments`;
                            const attachRes = await fetch(attachmentsUrl, { 
                                headers: { 'Authorization': `Bearer ${accessToken}` } 
                            });
                            
                            if (attachRes.ok) {
                                const attachData = await attachRes.json();
                                const attachments = attachData.value || [];
                                
                                console.log(`[SharePoint Lists] Item ${item.id} has ${attachments.length} attachments`);
                                
                                // Look for VTT or transcript attachments
                                for (const attachment of attachments) {
                                    const attachmentName = attachment.name.toLowerCase();
                                    const isTextTranscriptFile = attachmentName.endsWith('.vtt') || attachmentName.endsWith('.srt') || attachmentName.endsWith('.txt');
                                    if (isTextTranscriptFile) {
                                        
                                        console.log(`[SharePoint Lists] 🎯 FOUND TRANSCRIPT ATTACHMENT: ${attachment.name}`);
                                        
                                        // Download the attachment content
                                        const downloadUrl = attachment['@microsoft.graph.downloadUrl'];
                                        if (downloadUrl) {
                                            const contentRes = await fetch(downloadUrl);
                                            if (contentRes.ok) {
                                                let vttContent = await contentRes.text();
                                                
                                                // If it's not VTT format, try to convert or extract
                                                if (!vttContent.startsWith('WEBVTT')) {
                                                    console.log(`[SharePoint Lists] Converting non-VTT content to VTT format`);
                                                    vttContent = convertToVTT(vttContent, attachment.name);
                                                }
                                                
                                                console.log(`[SharePoint Lists] Successfully fetched transcript from attachment (${vttContent.length} chars)`);
                                                return vttContent;
                                            }
                                        }
                                    }
                                }
                            }
                            
                            // APPROACH 1b: Check if the item itself is a transcript file
                            if (item.driveItem) {
                                const itemName = item.driveItem.name?.toLowerCase() || '';
                                const isTextTranscriptFile = itemName.endsWith('.vtt') || itemName.endsWith('.srt') || itemName.endsWith('.txt');
                                if (isTextTranscriptFile) {
                                    
                                    console.log(`[SharePoint Lists] 🎯 FOUND TRANSCRIPT DRIVEITEM: ${item.driveItem.name}`);
                                    
                                    const downloadUrl = item.driveItem['@microsoft.graph.downloadUrl'];
                                    if (downloadUrl) {
                                        const contentRes = await fetch(downloadUrl);
                                        if (contentRes.ok) {
                                            let vttContent = await contentRes.text();
                                            
                                            // If it's not VTT format, try to convert
                                            if (!vttContent.startsWith('WEBVTT')) {
                                                console.log(`[SharePoint Lists] Converting non-VTT content to VTT format`);
                                                vttContent = convertToVTT(vttContent, item.driveItem.name);
                                            }
                                            
                                            console.log(`[SharePoint Lists] Successfully fetched transcript from DriveItem (${vttContent.length} chars)`);
                                            return vttContent;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                
                // APPROACH 2: Get all items and check manually (broader search)
                console.log(`[SharePoint Lists] Trying broader search in list: ${list.displayName}`);
                const allItemsUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${list.id}/items?$expand=fields,driveItem&$top=100`;
                const allItemsRes = await fetch(allItemsUrl, { 
                    headers: { 'Authorization': `Bearer ${accessToken}` } 
                });
                
                if (allItemsRes.ok) {
                    const allItemsData = await allItemsRes.json();
                    const allItems = allItemsData.value || [];
                    
                    console.log(`[SharePoint Lists] Scanning all ${allItems.length} items in ${list.displayName}`);
                    
                    for (const item of allItems) {
                        const itemName = item.fields?.Name || item.fields?.Title || item.driveItem?.name || '';
                        
                        // Check if this item might be related to our video
                        const isRelated = searchPatterns.some(pattern => 
                            itemName.toLowerCase().includes(pattern.toLowerCase())
                        ) || itemName.toLowerCase().includes('transcript') || itemName.toLowerCase().includes('caption');
                        
                        if (isRelated) {
                            console.log(`[SharePoint Lists] Found related item: ${itemName}`);
                            
                            // Try to get content from this item
                            if (item.driveItem?.['@microsoft.graph.downloadUrl']) {
                                const contentRes = await fetch(item.driveItem['@microsoft.graph.downloadUrl']);
                                if (contentRes.ok) {
                                    let content = await contentRes.text();
                                    
                                    // Check if this looks like transcript content
                                    if (content.length > 100 && (
                                        content.includes('WEBVTT') || 
                                        content.includes('-->') || 
                                        content.toLowerCase().includes('transcript') ||
                                        content.includes('00:') && content.includes('00:'))
                                    ) {
                                        console.log(`[SharePoint Lists] 🎯 FOUND RELATED CONTENT: ${itemName}`);
                                        
                                        // Convert to VTT if needed
                                        if (!content.startsWith('WEBVTT')) {
                                            content = convertToVTT(content, itemName);
                                        }
                                        
                                        return content;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        console.log(`[SharePoint Lists] No transcript content found in any list`);
        return null;
        
    } catch (error) {
        console.error(`[SharePoint Lists] Error searching for transcript attachments:`, error);
        return null;
    }
}

/**
 * Helper function to convert various transcript formats to VTT
 */
function convertToVTT(content, filename) {
    console.log(`[SharePoint Lists] Converting content from ${filename} to VTT format`);
    
    // If it's already VTT, return as-is
    if (content.startsWith('WEBVTT')) {
        return content;
    }
    
    // Basic conversion for plain text or other formats
    let vttContent = 'WEBVTT\n\n';
    
    // Split by lines and create basic timestamps
    const lines = content.split('\n').filter(line => line.trim());
    let startTime = 0;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length > 0) {
            const start = formatTime(startTime);
            const end = formatTime(startTime + 3); // 3 seconds per line
            vttContent += `${start} --> ${end}\n${line}\n\n`;
            startTime += 3;
        }
    }
    
    return vttContent;
}

/**
 * Format time in seconds to VTT timestamp format
 */
function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

