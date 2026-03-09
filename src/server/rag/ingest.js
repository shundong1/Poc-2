
// src/server/rag/ingest.js
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import dotenv from "dotenv";
import OpenAI from "openai";
import mammoth from "mammoth";
import { ChromaClient } from "chromadb";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

dotenv.config();

const require = createRequire(import.meta.url);
const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(`file:///${workerPath.replace(/\\/g, "/")}`).href;

const KNOWLEDGE_DIR = path.resolve(process.cwd(), "knowledge");
const CHROMA_URL = process.env.CHROMA_URL || "http://127.0.0.1:8000";
const COLLECTION_NAME = process.env.CHROMA_COLLECTION || "toolboard_kb";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function extractTextFromPdf(filePath) {
  const buf = fs.readFileSync(filePath);
  const uint8 = new Uint8Array(buf);
  const loadingTask = pdfjsLib.getDocument({
    data: uint8,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdfDoc = await loadingTask.promise;

  let fullText = "";
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(" ");
    fullText += pageText + "\n";
  }
  return fullText;
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  try {
    if (ext === ".txt" || ext === ".md") {
      return fs.readFileSync(filePath, "utf8");
    }

    if (ext === ".pdf") {
      return await extractTextFromPdf(filePath);
    }

    if (ext === ".docx") {
      const buf = fs.readFileSync(filePath);
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return value || "";
    }
  } catch (err) {
    console.error(`  - [提取失败] ${path.basename(filePath)}:`, err?.message || err);
  }

  return "";
}

async function main() {
  console.log("🚀 启动数据导入...");

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY in .env");
  }
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    throw new Error(`knowledge 目录不存在: ${KNOWLEDGE_DIR}`);
  }

  const chroma = new ChromaClient({ path: CHROMA_URL });

  const collection = await chroma.getOrCreateCollection({
    name: COLLECTION_NAME,
    metadata: { "hnsw:space": "cosine" },
  });

  console.log("✅ 成功连接至向量数据库集合");

  const files = fs
    .readdirSync(KNOWLEDGE_DIR)
    .filter((f) =>
      [".pdf", ".docx", ".txt", ".md"].includes(path.extname(f).toLowerCase())
    );

  console.log(`在 knowledge/ 目录发现 ${files.length} 个文件`);

  let totalChunks = 0;

  for (const fileName of files) {
    const filePath = path.join(KNOWLEDGE_DIR, fileName);
    console.log(`\n[处理中] ${fileName}`);

    const text = await extractText(filePath);
    if (!text || text.length < 50) {
      console.log("  - 跳过 (内容过短或为空)");
      continue;
    }

    const chunks = text.match(/[\s\S]{1,900}/g) || [];
    if (chunks.length === 0) {
      console.log("  - 跳过 (分片为 0)");
      continue;
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const embeddingResp = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: chunk,
      });

      await collection.upsert({
        ids: [`${fileName}-${i}`],
        embeddings: [embeddingResp.data[0].embedding],
        documents: [chunk],
        metadatas: [{ source: fileName, chunk_index: i }],
      });

      process.stdout.write(`  进度: ${i + 1}/${chunks.length}\r`);
      totalChunks += 1;
    }

    process.stdout.write("\n");
    console.log(`✅ ${fileName} 导入完成`);
  }

  console.log("\n🎉 所有知识库文档已同步至 ChromaDB！");
  console.log(`总分片数: ${totalChunks}`);
}

main().catch((e) => {
  console.error("❌ 入库失败:", e);
  process.exit(1);
});
