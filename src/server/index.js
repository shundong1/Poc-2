// src/server/index.js
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { retrieveRelevantContext } from "./rag/retriever.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8787;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());

// ---------- Tool → Knowledge file mapping ----------
const TOOL_KNOWLEDGE_FILES = {
  0: ["Tool0_Instrucciones.docx"],
  1: ["Tool1_Instrucciones.docx"],
  2: ["Tool2_Instrucciones.docx"],
  3: ["Tool3_Instrucciones.docx"],
  4: ["Tool4_Instrucciones.docx"],
  5: ["Tool5_Instrucciones.docx"],
  6: ["Tool6_Instrucciones.docx"],
  7: ["Tool7_Instrucciones.docx"],
  8: ["Instrucciones_Excel.docx"],
  9: ["Tool9_Instrucciones_.docx"],
};

const BACKGROUND_FILES = [
  "Esquemas_Toolboard.pdf",
  "Prompt_ToolboardGPT_actualizado.docx",
  "libro_pdf_viajeemprendedor (1).pdf",
];

// ---------- Health check ----------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Toolboard GPT Server running" });
});

// ---------- Build full prompt with paired knowledge + stickies ----------
async function buildFullPrompt(boardContext, focusToolId, focusQuestion) {
  let promptSections = [];

  // For each tool that has content, pair its knowledge + stickies
  for (const tool of boardContext) {
    const hasContent = tool.questions.some((q) => q.notes && q.notes.length > 0);

    // Format tool's sticky notes
    const stickiesText = tool.questions
      .map((q) => {
        const notesText =
          q.notes && q.notes.length > 0
            ? q.notes.map((n) => `    • ${n}`).join("\n")
            : "    (empty)";
        return `  [${q.anchorFrameTitle}] ${q.label}\n${notesText}`;
      })
      .join("\n\n");

    // Retrieve knowledge for this tool
    const sourceFiles = TOOL_KNOWLEDGE_FILES[tool.toolId] ?? [];
    let knowledgeText = "";
    if (sourceFiles.length > 0) {
      try {
        const query = `${tool.toolName} ${focusQuestion?.label ?? ""}`;
        knowledgeText = await retrieveRelevantContext(query, sourceFiles);
      } catch (err) {
        console.warn(`RAG failed for Tool ${tool.toolId}:`, err.message);
      }
    }

    // Build section for this tool
    let section = `=== ${tool.toolName} ===\n`;

    if (knowledgeText) {
      section += `\n[Knowledge Base for ${tool.toolName}]\n${knowledgeText}\n`;
    }

    section += `\n[User's Board Content for ${tool.toolName}]\n${stickiesText}`;

    // Mark the focus tool
    if (tool.toolId === focusToolId) {
      section += `\n\n⭐ This is the CURRENT TOOL the user needs help with.`;
    }

    promptSections.push(section);
  }

  // Add background knowledge
  let backgroundText = "";
  try {
    const bgQuery = focusQuestion?.label ?? "Toolboard methodology entrepreneurship";
    backgroundText = await retrieveRelevantContext(bgQuery, BACKGROUND_FILES);
  } catch (err) {
    console.warn("Background RAG failed:", err.message);
  }

  if (backgroundText) {
    promptSections.push(
      `=== Background Knowledge (Toolboard Methodology) ===\n${backgroundText}`
    );
  }

  return promptSections.join("\n\n---\n\n");
}

// ---------- /api/suggest ----------
app.post("/api/suggest", async (req, res) => {
  try {
    const {
      mode,
      toolId,
      toolName,
      toolDescription,
      focusQuestion,
      boardContext,
    } = req.body;

    // boardContext must be array of all tools
    const allTools = Array.isArray(boardContext)
      ? boardContext
      : boardContext?.questions
      ? [{ toolId, toolName, questions: boardContext.questions }]
      : [];

    // Detect language from sticky notes
    const allNotes = allTools
      .flatMap((t) => t.questions.flatMap((q) => q.notes ?? []))
      .filter(Boolean)
      .join(" ");

    const hasChinese = /[一-鿿]/.test(allNotes);
    const hasJapanese = /[぀-ヿ]/.test(allNotes);
    const hasKorean = /[가-힯]/.test(allNotes);
    const hasArabic = /[؀-ۿ]/.test(allNotes);
    const hasSpanish = /[áéíóúüñ¿¡]/i.test(allNotes);

    let detectedLanguage = "English";
    if (hasChinese) detectedLanguage = "Chinese (中文)";
    else if (hasJapanese) detectedLanguage = "Japanese (日本語)";
    else if (hasKorean) detectedLanguage = "Korean (한국어)";
    else if (hasArabic) detectedLanguage = "Arabic (العربية)";
    else if (hasSpanish) detectedLanguage = "Spanish (Español)";

    console.log(`Detected language: ${detectedLanguage}`);

    // Build full prompt with paired knowledge + stickies per tool
    const fullContext = await buildFullPrompt(allTools, toolId, focusQuestion);

    // Build system prompt
    const systemPrompt = `You are an expert Toolboard GPT assistant specialising in entrepreneurship, innovation, and design thinking.

You will receive:
1. For each Toolboard tool: the methodology knowledge AND the user's sticky note answers — paired together
2. A focus question that the user needs help with

Your job is to:
- Understand the user's full journey across all tools
- Use both the knowledge base AND the user's actual answers to generate suggestions
- Generate 3 specific, actionable suggestions for the focus question

IMPORTANT - Language detection:
- Detect the language used in the user's sticky notes
- Respond in the SAME language as the user's sticky notes
- If sticky notes are in Chinese, respond entirely in Chinese
- If sticky notes are in English, respond entirely in English
- If sticky notes are in another language, respond in that language
- If mixed languages, use the dominant language

Always respond in JSON format with this exact structure:
{
  "suggestions": [
    { "id": "s1", "title": "...", "content": "..." },
    { "id": "s2", "title": "...", "content": "..." },
    { "id": "s3", "title": "...", "content": "..." }
  ]
}
Return only valid JSON. No markdown, no preamble.`;

    // Build user prompt
    const userPrompt = `Here is the complete Toolboard context — each tool's knowledge paired with the user's answers:

${fullContext}

---

FOCUS: The user needs help with the following question in ${toolName ?? ""}:
"${focusQuestion?.label ?? ""}"
(Frame: ${focusQuestion?.anchorFrameTitle ?? ""})

${toolDescription ? `Tool description: ${toolDescription}` : ""}

Based on:
1. The methodology knowledge for each tool
2. The user's actual answers across the entire board
3. The specific focus question above

IMPORTANT: You MUST respond entirely in ${detectedLanguage}. All titles and content must be in ${detectedLanguage}.

Generate 3 concrete, actionable suggestions to help the user answer the focus question.
Each suggestion should reference the user's existing work and be grounded in Toolboard methodology.`;

    // Call GPT-4o
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 1500,
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";

    // Parse JSON
    let parsed;
    try {
      const clean = raw.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(clean);
    } catch {
      console.error("Failed to parse GPT response:", raw);
      parsed = {
        suggestions: [{ id: "s1", title: "Response", content: raw }],
      };
    }

    res.json(parsed);
  } catch (err) {
    console.error("Error in /api/suggest:", err);
    res.status(500).json({ error: err.message, suggestions: [] });
  }
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`✅ Toolboard GPT Server running at http://localhost:${PORT}`);
});