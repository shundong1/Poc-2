// src/server/rag/retriever.js
import dotenv from "dotenv";
import OpenAI from "openai";
import { ChromaClient } from "chromadb";

dotenv.config();

const CHROMA_URL = process.env.CHROMA_URL || "http://localhost:8000";
const COLLECTION_NAME = process.env.CHROMA_COLLECTION || "toolboard_kb";
const EMBED_MODEL = "text-embedding-3-small";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function retrieveEvidence({ query, topK = 6 }) {
  if (!query || !query.trim()) return [];

  const chroma = new ChromaClient({ path: CHROMA_URL });
  const collection = await chroma.getOrCreateCollection({ name: COLLECTION_NAME });

  const embResp = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: query,
  });
  const queryEmbedding = embResp.data[0].embedding;

  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: topK,
    include: ["documents", "metadatas", "distances"],
  });

  const docs = results?.documents?.[0] || [];
  const metas = results?.metadatas?.[0] || [];
  const dists = results?.distances?.[0] || [];

  return docs.map((text, i) => ({
    text,
    meta: metas[i] || {},
    distance: dists[i],
  }));
}
