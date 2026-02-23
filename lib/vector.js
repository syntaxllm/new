import { GoogleGenerativeAI } from "@google/generative-ai";
import * as storage from './storage-prod.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "text-embedding-004" });

/**
 * Generate embedding for a single text block
 */
export async function generateEmbedding(text) {
    if (!text || text.trim().length === 0) return null;
    try {
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (e) {
        console.error("[Vector] Embedding failed:", e.message);
        return null;
    }
}

/**
 * Vectorize chunks and save them to the database
 */
export async function vectorizeAndSaveChunks(meetingId, chunks) {
    if (!chunks || chunks.length === 0) return;

    console.log(`[Vector] Vectorizing ${chunks.length} chunks for meeting ${meetingId}...`);

    const vectorizedChunks = [];

    // Process in batches of 10 for efficiency
    const batchSize = 10;
    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);

        try {
            const batchResult = await model.batchEmbedContents({
                requests: batch.map(chunk => ({
                    content: { role: "user", parts: [{ text: chunk.text }] },
                    taskType: "RETRIEVAL_DOCUMENT",
                    title: `Meeting chunk ${chunk.chunkId}`
                }))
            });

            if (batchResult.embeddings) {
                batchResult.embeddings.forEach((emb, index) => {
                    vectorizedChunks.push({
                        ...batch[index],
                        meetingId,
                        embedding: emb.values
                    });
                });
            }
        } catch (e) {
            console.error(`[Vector] Batch embedding failed at index ${i}:`, e.message);
            // Fallback for this batch: just push without embeddings so storage still works
            batch.forEach(chunk => {
                vectorizedChunks.push({ ...chunk, meetingId });
            });
        }
    }

    await storage.saveChunks(vectorizedChunks);
    console.log(`[Vector] ✅ Saved ${vectorizedChunks.length} chunks for ${meetingId} (${vectorizedChunks.filter(c => c.embedding).length} vectorized)`);
}
