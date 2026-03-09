import { ChromaClient } from "chromadb";
import fs from "fs";

const chroma = new ChromaClient({ path: "http://127.0.0.1:8000" });

const collection = await chroma.getCollection({ name: "toolboard_kb" });

const result = await collection.get({
  include: ["metadatas", "documents"],
});

const total = await collection.count();
console.log("总数量:", total);

const output = result.ids.map((id, i) => ({
  id,
  source: result.metadatas[i].source,
  chunk_index: result.metadatas[i].chunk_index,
  content: result.documents[i],
}));

fs.writeFileSync("./rag/all_chunks.json", JSON.stringify(output, null, 2), "utf8");
console.log("✅ 已导出到 ./rag/all_chunks.json");