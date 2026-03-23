// src/server/rag/retriever.js
import dotenv from "dotenv";
import OpenAI from "openai";
import { ChromaClient } from "chromadb";

dotenv.config();

const CHROMA_URL = process.env.CHROMA_URL || "http://127.0.0.1:8000";
const COLLECTION_NAME = process.env.CHROMA_COLLECTION || "toolboard_kb";
const EMBED_MODEL = "text-embedding-3-small";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 基础检索：支持按 source 文件名过滤
export async function retrieveEvidence({ query, topK = 6, sourceFiles = [] }) {
  if (!query || !query.trim()) return [];

  const chroma = new ChromaClient({ 
  host: "127.0.0.1",
  port: 8000,
  ssl: false
});
  const collection = await chroma.getOrCreateCollection({ name: COLLECTION_NAME });

  const embResp = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: query,
  });

  const queryEmbedding = embResp.data[0].embedding;

  // 如果指定了 source 文件，加入过滤条件
  const queryParams = {
    queryEmbeddings: [queryEmbedding],
    nResults: topK,
    include: ["documents", "metadatas", "distances"],
  };

  if (sourceFiles && sourceFiles.length > 0) {
    if (sourceFiles.length === 1) {
      queryParams.where = { source: { $eq: sourceFiles[0] } };
    } else {
      queryParams.where = { source: { $in: sourceFiles } };
    }
  }

  const results = await collection.query(queryParams);

  const docs = results?.documents?.[0] || [];
  const metas = results?.metadatas?.[0] || [];
  const dists = results?.distances?.[0] || [];

  return docs.map((text, i) => ({
    text,
    meta: metas[i] || {},
    distance: dists[i],
  }));
}

// 检索特定 Tool 的知识 + 背景知识
export async function retrieveRelevantContext(query, sourceFiles = []) {
  const evidence = await retrieveEvidence({
    query,
    topK: 5,
    sourceFiles,
  });

  return evidence.map((e) => e.text).join("\n\n");
}