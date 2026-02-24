import { MongoClient } from 'mongodb';

let client = null;
let db = null;

async function connect() {
    if (db) return db;

    const MONGO_URL = process.env.MONGO_URL;
    if (!MONGO_URL) {
        throw new Error('MONGO_URL environment variable is not defined.');
    }
    const MONGO_DB = process.env.MONGO_DB || 'meeting_ai_prod';

    client = new MongoClient(MONGO_URL);
    await client.connect();
    db = client.db(MONGO_DB);
    return db;
}

/**
 * SIMPLIFIED RAG RETRIEVAL
 * Standard Keyword Search for Production (Reliable & Cost-Free)
 */
export async function searchChunksKeyword(query, meetingId, limit = 10, userId = null) {
    const database = await connect();
    const collection = database.collection('chunks');

    if (!meetingId) {
        console.error(" searchChunksKeyword called without meetingId!");
        return [];
    }

    const baseQuery = { meetingId };
    if (userId) baseQuery.userId = userId;

    // 1. Clean terms (remove stop words like "what", "did", "discuss")
    const stopWords = ['what', 'did', 'the', 'is', 'a', 'an', 'to', 'for', 'of', 'in', 'discussed', 'discuss', 'stuff', 'about'];
    const terms = query.toLowerCase()
        .replace(/[^a-z0-9 ]/g, '')
        .split(' ')
        .filter(t => t.length > 2 && !stopWords.includes(t));

    if (terms.length === 0) {
        // Fallback: Just try the raw query if filtering removed everything
        return await collection.find({
            ...baseQuery,
            text: { $regex: query, $options: 'i' }
        }).limit(limit).toArray();
    }

    // 2. Perform OR search: Find chunks containing ANY of the key terms
    // "Akash Kundu" -> matches chunks with "Akash" OR "Kundu"
    const results = await collection.find({
        ...baseQuery,
        $or: terms.map(t => ({ text: { $regex: t, $options: 'i' } }))
    }).limit(limit * 2).toArray();

    // 3. Simple Scoring (Client-side)
    // Prioritize chunks that contain MORE of the terms
    const scored = results.map(doc => {
        let score = 0;
        terms.forEach(t => {
            if (doc.text.toLowerCase().includes(t)) score++;
        });
        return { ...doc, score };
    });

    // Return top matches sorted by score
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * SEMANTIC SEARCH (RAG)
 * Uses MongoDB Atlas Vector Search on 'embedding' field.
 * NOTE: Requires an Atlas Vector Search Index named 'vector_index' on the 'chunks' collection.
 */
export async function searchChunksSemantic(queryVector, meetingId, limit = 10, userId = null) {
    const database = await connect();
    const collection = database.collection('chunks');

    if (!queryVector || !meetingId) {
        return [];
    }

    const filter = { meetingId };
    if (userId) filter.userId = userId;

    try {
        const pipeline = [
            {
                $vectorSearch: {
                    index: "vector_index",
                    path: "embedding",
                    queryVector: queryVector,
                    numCandidates: limit * 20,
                    limit: limit,
                    filter: filter
                }
            },
            {
                $project: {
                    _id: 1,
                    meetingId: 1,
                    chunkId: 1,
                    text: 1,
                    startTime: 1,
                    endTime: 1,
                    score: { $meta: "vectorSearchScore" }
                }
            }
        ];

        return await collection.aggregate(pipeline).toArray();
    } catch (e) {
        console.warn(`[Storage] Semantic Search failed (is vector_index created?):`, e.message);
        return [];
    }
}

export async function saveTranscripts(meeting) {
    const database = await connect();
    const query = { meetingId: meeting.meetingId };
    if (meeting.userId) query.userId = meeting.userId;

    await database.collection('transcripts').updateOne(
        query,
        { $set: meeting },
        { upsert: true }
    );
}

export async function updateMeeting(meetingId, updateData) {
    const database = await connect();
    await database.collection('transcripts').updateOne(
        { meetingId: meetingId },
        { $set: updateData }
    );
}

export async function saveChunks(chunks) {
    const database = await connect();
    if (!chunks.length) return;

    const query = { meetingId: chunks[0].meetingId };
    if (chunks[0].userId) query.userId = chunks[0].userId;

    await database.collection('chunks').deleteMany(query);
    await database.collection('chunks').insertMany(chunks);
}

export async function loadTranscripts(userId = null) {
    const database = await connect();
    const query = userId ? { userId } : {};
    return await database.collection('transcripts').find(query).sort({ importedAt: -1 }).toArray();
}

export async function getMeeting(meetingId) {
    const database = await connect();
    return await database.collection('transcripts').findOne({ meetingId });
}

export async function getMeetingByExternalId(externalId) {
    const database = await connect();
    return await database.collection('transcripts').findOne({ externalId });
}

export async function deleteMeeting(meetingId, userId = null) {
    const database = await connect();
    const query = { meetingId };
    if (userId) query.userId = userId;

    const tRes = await database.collection('transcripts').deleteOne(query);

    // Only delete chunks if the transcript was deleted
    let cRes = { deletedCount: 0 };
    if (tRes.deletedCount > 0) {
        await database.collection('chunks').deleteMany(query);
        cRes = { deletedCount: tRes.deletedCount };
    }
    return { deletedCount: tRes.deletedCount };
}

export async function loadChunks(meetingId, userId = null) {
    const database = await connect();
    const query = { meetingId };
    if (userId) query.userId = userId;
    return await database.collection('chunks').find(query).toArray();
}