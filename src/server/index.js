import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { retrieveRelevantContext } from "./rag/retriever.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  `file:///${workerPath.replace(/\\/g, "/")}`
).href;

const app = express();
const PORT = process.env.PORT || 8787;
const OPENAI_MAX_RETRIES = Number(process.env.OPENAI_MAX_RETRIES || 3);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 10);
const TOTAL_FRAME_COUNT = 41;
const KNOWLEDGE_DIR = path.join(__dirname, "knowledge");
const ASSISTANT_MEMORY_PATH = path.join(__dirname, "assistant-memory.json");
const GLOBAL_ASSISTANT_NAME = "Toolboard Global Methodology Expert";
const DEFAULT_BOARD_ID = "default-board";
const GLOBAL_ASSISTANT_SYSTEM_ROLE =
  "You are a senior advisor who has fully mastered the complete Toolboard methodology.";
const GLOBAL_ASSISTANT_MODEL = "gpt-4o-mini";
const LOG_LEVEL = String(
  process.env.TOOLBOARD_LOG_LEVEL || "info"
).toLowerCase();
const LOG_PRIORITY = { error: 0, warn: 1, info: 2, debug: 3 };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const rateLimitBuckets = new Map();
const recentGeneratedContentHashes = new Set();
let methodologyCorpusPromise = null;
let assistantBootstrapPromise = null;
const assistantMemoryStore = loadAssistantMemoryStore();

function shouldLog(level = "info") {
  const currentPriority = LOG_PRIORITY[LOG_LEVEL] ?? LOG_PRIORITY.info;
  const levelPriority = LOG_PRIORITY[level] ?? LOG_PRIORITY.info;
  return levelPriority <= currentPriority;
}

function toPrettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function indentBlock(value = "") {
  return String(value)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function normalizeSectionValue(value, format = "text") {
  if (value === undefined || value === null || value === "") {
    return "(empty)";
  }

  if (format === "json") {
    return toPrettyJson(value);
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value.join("\n") : "(empty)";
  }

  if (typeof value === "object") {
    return toPrettyJson(value);
  }

  return String(value);
}

function logStructured(level, title, { sections = [], error = null } = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const blocks = [`[Toolboard GPT] [${level.toUpperCase()}] ${title}`];

  for (const section of sections) {
    if (!section?.label) continue;
    const rendered = normalizeSectionValue(
      section.value,
      section.format || "text"
    );
    blocks.push(`${section.label}:\n${indentBlock(rendered)}`);
  }

  if (error) {
    blocks.push(
      `Error Message:\n${indentBlock(error.message || String(error))}`
    );
    if (error.stack) {
      blocks.push(`Stack Trace:\n${indentBlock(error.stack)}`);
    }
  }

  const method =
    level === "error"
      ? console.error
      : level === "warn"
      ? console.warn
      : console.log;
  method(blocks.join("\n\n"));
}

const logger = {
  debug(title, options = {}) {
    logStructured("debug", title, options);
  },
  info(title, options = {}) {
    logStructured("info", title, options);
  },
  warn(title, options = {}) {
    logStructured("warn", title, options);
  },
  error(title, options = {}) {
    logStructured("error", title, options);
  },
};

function summarizeChatPayload(payload = {}) {
  return {
    model: payload.model,
    messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
    responseFormat: payload.response_format?.type || null,
    temperature: payload.temperature ?? null,
    maxTokens: payload.max_tokens ?? null,
  };
}

function summarizeFactsPayload(factsPayload = {}) {
  return {
    dominantLanguage: factsPayload.dominantLanguage || "EN",
    currentTool: factsPayload.currentTool?.toolName || "",
    targetQuestion: factsPayload.targetQuestion?.label || "",
    authoritativeLanguageSourceLevel:
      factsPayload.authoritativeLanguageSourceLevel || "default-english",
    authoritativeLanguageFactCount: Array.isArray(
      factsPayload.authoritativeLanguageFacts
    )
      ? factsPayload.authoritativeLanguageFacts.length
      : 0,
    latestFactCount: Array.isArray(factsPayload.latestStickyFacts)
      ? factsPayload.latestStickyFacts.length
      : 0,
    otherFrameCount: Array.isArray(factsPayload.otherFilledFrames)
      ? factsPayload.otherFilledFrames.length
      : 0,
    boardSummary: factsPayload.boardSummary || {},
  };
}

function formatSuggestionsList(suggestions = []) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return "(empty)";
  }

  return suggestions.map((suggestion, index) => {
    const text = String(
      suggestion?.title || suggestion?.content || suggestion?.text || ""
    )
      .replace(/\s+/g, " ")
      .trim();
    return `${index + 1}. ${text}`;
  });
}

app.use(cors());
app.use(express.json());

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
const ASSISTANT_KNOWLEDGE_FILES = [
  ...new Set([
    ...Object.values(TOOL_KNOWLEDGE_FILES).flat(),
    ...BACKGROUND_FILES,
  ]),
];

const EMPTY_DIAGNOSIS = {
  score: 0,
  progress: {
    filledFrames: 0,
    totalFrames: TOTAL_FRAME_COUNT,
    toolStats: [],
  },
  logicAuditSuggestions: [],
  recommendedFocus: {
    toolId: null,
    toolName: "",
    frameTitle: "",
    reason: "",
  },
  coachMessage: "",
  isIntervention: false,
  qualityAlert: null,
  cardAnalyses: [],
};

const EN_PRONOUNS = new Set([
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "our",
  "their",
  "mine",
  "yours",
  "ours",
  "theirs",
  "this",
  "that",
  "these",
  "those",
]);
const EN_PREPOSITIONS = new Set([
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "to",
  "from",
  "of",
  "into",
  "over",
  "under",
  "between",
  "among",
  "across",
  "through",
  "during",
  "before",
  "after",
  "within",
  "without",
]);
const EN_ARTICLES = new Set(["a", "an", "the"]);
const EN_INTERJECTIONS = new Set(["wow", "hey", "oh", "ah", "hmm", "oops"]);
const EN_AUXILIARIES = new Set([
  "be",
  "am",
  "is",
  "are",
  "was",
  "were",
  "been",
  "being",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "can",
  "could",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
]);

const ES_PRONOUNS = new Set([
  "yo",
  "tu",
  "tus",
  "usted",
  "ustedes",
  "el",
  "ella",
  "ellos",
  "ellas",
  "nosotros",
  "nosotras",
  "me",
  "te",
  "se",
  "nos",
  "mi",
  "mis",
  "su",
  "sus",
  "este",
  "esta",
  "estos",
  "estas",
]);
const ES_PREPOSITIONS = new Set([
  "a",
  "ante",
  "bajo",
  "con",
  "contra",
  "de",
  "desde",
  "durante",
  "en",
  "entre",
  "hacia",
  "hasta",
  "para",
  "por",
  "segun",
  "sin",
  "sobre",
  "tras",
  "mediante",
]);
const ES_ARTICLES = new Set([
  "el",
  "la",
  "los",
  "las",
  "lo",
  "un",
  "una",
  "unos",
  "unas",
]);
const ES_INTERJECTIONS = new Set(["hola", "oye", "ay", "eh", "uf", "wow"]);
const ES_ADVERBIAL_FILLERS = new Set([
  "creo",
  "pienso",
  "quizas",
  "quiza",
  "talvez",
  "talvez",
]);
const ES_FIRST_PERSON_VERBS = new Set([
  "creo",
  "pienso",
  "quiero",
  "opino",
  "siento",
  "considero",
]);
const ZH_STRONG_PRONOUN_TERMS = new Set([
  "我",
  "你",
  "他",
  "我们",
  "这个",
  "那个",
]);
const ZH_STRONG_SUBJECTIVE_TERMS = new Set([
  "觉得",
  "感觉",
  "想",
  "好像",
]);
const ZH_BUSINESS_NOUN_TERMS = new Set([
  "市场",
  "用户",
  "机制",
  "策略",
]);
const ZH_BUSINESS_PREP_TERMS = new Set([
  "基于",
  "针对",
  "通过",
]);
const ZH_PROFESSIONAL_NOUN_TERMS = new Set([
  "架构",
  "职能",
  "维度",
  "闭环",
  "驱动",
  "验证",
  "战略",
  "机制",
  "策略",
]);
const EN_PROFESSIONAL_NOUN_TERMS = new Set([
  "architecture",
  "function",
  "functional",
  "dimension",
  "loop",
  "driver",
  "validation",
  "strategy",
  "framework",
  "governance",
]);
const ES_PROFESSIONAL_NOUN_TERMS = new Set([
  "arquitectura",
  "funcion",
  "funcional",
  "dimension",
  "cierre",
  "impulsor",
  "validacion",
  "estrategia",
  "marco",
  "gobernanza",
]);
const ZH_FUNCTION_WORDS = new Set([
  "的",
  "了",
  "呢",
  "吧",
  "这个",
]);
const ZH_COMPLEXITY_PATTERNS = [
  /因为[\s\S]{0,20}所以/,
  /从而/,
  /虽然[\s\S]{0,20}但是/,
];
const ZH_SEGMENT_HINTS = [
  ...ZH_STRONG_PRONOUN_TERMS,
  ...ZH_STRONG_SUBJECTIVE_TERMS,
  ...ZH_BUSINESS_NOUN_TERMS,
  ...ZH_BUSINESS_PREP_TERMS,
  ...ZH_PROFESSIONAL_NOUN_TERMS,
  ...ZH_FUNCTION_WORDS,
  "因为",
  "所以",
  "从而",
  "虽然",
  "但是",
];

const ZH_PRONOUNS = [
  "我们",
  "你们",
  "他们",
  "她们",
  "它们",
  "自己",
  "大家",
  "有人",
  "本人",
  "我",
  "你",
  "他",
  "她",
  "它",
];
const ZH_PREPOSITIONS = [
  "关于",
  "针对",
  "对于",
  "依据",
  "通过",
  "按照",
  "为了",
  "根据",
  "围绕",
  "向",
  "从",
  "对",
  "在",
  "把",
  "被",
  "给",
];
const ZH_INTERJECTIONS = ["啊", "哦", "呀", "哇", "嗯", "唉"];
const ZH_ADVERBS = [
  "非常",
  "比较",
  "已经",
  "正在",
  "仍然",
  "继续",
  "可能",
  "大概",
  "也许",
  "逐步",
  "更",
  "很",
  "太",
  "较",
  "再",
  "可",
  "都",
];
const ZH_ADJECTIVES = [
  "重要",
  "关键",
  "明确",
  "清晰",
  "稳定",
  "正式",
  "完整",
  "有效",
  "核心",
  "可行",
  "具体",
  "深入",
];
const ZH_VERBS = [
  "建立",
  "提升",
  "分析",
  "定义",
  "验证",
  "规划",
  "构建",
  "推动",
  "形成",
  "识别",
  "优化",
  "说明",
  "解决",
  "认为",
  "觉得",
  "好像",
  "是",
  "有",
  "做",
];

function loadAssistantMemoryStore() {
  try {
    if (!fs.existsSync(ASSISTANT_MEMORY_PATH)) {
      return { assistantId: null, boards: {} };
    }

    const raw = fs.readFileSync(ASSISTANT_MEMORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      assistantId: parsed?.assistantId || null,
      boards: parsed?.boards && typeof parsed.boards === "object" ? parsed.boards : {},
    };
  } catch (error) {
    logger.warn("Failed to load assistant memory store.", {
      sections: [{ label: "File", value: ASSISTANT_MEMORY_PATH }],
      error,
    });
    return { assistantId: null, boards: {} };
  }
}

function saveAssistantMemoryStore() {
  fs.writeFileSync(
    ASSISTANT_MEMORY_PATH,
    JSON.stringify(assistantMemoryStore, null, 2),
    "utf8"
  );
}

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
  for (let i = 1; i <= pdfDoc.numPages; i += 1) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map((item) => item.str).join(" ") + "\n";
  }

  return fullText;
}

async function extractKnowledgeText(fileName) {
  const filePath = path.join(KNOWLEDGE_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return "";
  }

  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".txt" || ext === ".md") {
      return fs.readFileSync(filePath, "utf8");
    }

    if (ext === ".docx") {
      const buf = fs.readFileSync(filePath);
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return value || "";
    }

    if (ext === ".pdf") {
      return await extractTextFromPdf(filePath);
    }
  } catch (error) {
    logger.warn("Failed to preload methodology file.", {
      sections: [{ label: "File", value: fileName }],
      error,
    });
  }

  return "";
}

function clampAssistantCorpus(text = "", maxChars = 12000) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars)} ...[truncated for assistant bootstrap]`;
}

async function loadMethodologyCorpus() {
  if (!methodologyCorpusPromise) {
    methodologyCorpusPromise = (async () => {
      const sections = [];

      for (const fileName of ASSISTANT_KNOWLEDGE_FILES) {
        const text = await extractKnowledgeText(fileName);
        if (!text.trim()) continue;
        sections.push(`[Source: ${fileName}]\n${clampAssistantCorpus(text)}`);
      }

      return sections.join("\n\n---\n\n");
    })();
  }

  return methodologyCorpusPromise;
}

function buildGlobalAssistantInstructions(methodologyCorpus = "") {
  return `${GLOBAL_ASSISTANT_SYSTEM_ROLE}

You are the permanent Toolboard methodology expert for this workspace.
You should behave like a long-term strategic advisor who already knows the Toolboard 0-9 framework by heart.

Operating rules:
- Treat the methodology below as your global memory. Do not ask the user to resend the full methodology.
- Ground every suggestion in the user's current tool, current question, latest sticky-note facts, and the existing board context.
- Extend the user's real reasoning instead of inventing a disconnected answer.
- Keep suggestions concise, specific, and action-oriented.
- When facts are missing, point out the missing decision or evidence clearly.
- Preserve the user's dominant language.
- For suggestion requests, return only valid JSON with a top-level "suggestions" array containing 3 actionable suggestions.

Global Toolboard methodology memory:
${methodologyCorpus}`;
}

async function ensureGlobalToolboardAssistant() {
  if (!assistantBootstrapPromise) {
    assistantBootstrapPromise = (async () => {
      const methodologyCorpus = await loadMethodologyCorpus();
      const desiredInstructions = buildGlobalAssistantInstructions(methodologyCorpus);

      if (assistantMemoryStore.assistantId) {
        try {
          const existingAssistant = await openai.beta.assistants.retrieve(
            assistantMemoryStore.assistantId
          );

          if (
            existingAssistant.model !== GLOBAL_ASSISTANT_MODEL ||
            existingAssistant.name !== GLOBAL_ASSISTANT_NAME ||
            existingAssistant.instructions !== desiredInstructions
          ) {
            return await openai.beta.assistants.update(existingAssistant.id, {
              name: GLOBAL_ASSISTANT_NAME,
              model: GLOBAL_ASSISTANT_MODEL,
              instructions: desiredInstructions,
              metadata: {
                app: "toolboard-gpt-miro",
                role: "global-methodology-expert",
              },
            });
          }

          return existingAssistant;
        } catch (error) {
          logger.warn("Stored assistant could not be retrieved. Recreating it.", {
            sections: [
              { label: "Assistant ID", value: assistantMemoryStore.assistantId || "(none)" },
            ],
            error,
          });
          assistantMemoryStore.assistantId = null;
          saveAssistantMemoryStore();
        }
      }

      const assistant = await openai.beta.assistants.create({
        name: GLOBAL_ASSISTANT_NAME,
        model: GLOBAL_ASSISTANT_MODEL,
        instructions: desiredInstructions,
        metadata: {
          app: "toolboard-gpt-miro",
          role: "global-methodology-expert",
        },
      });

      assistantMemoryStore.assistantId = assistant.id;
      saveAssistantMemoryStore();
      return assistant;
    })();
  }

  return assistantBootstrapPromise;
}

async function ensureBoardThread(boardId = DEFAULT_BOARD_ID) {
  const normalizedBoardId = String(boardId || DEFAULT_BOARD_ID);
  const existing = assistantMemoryStore.boards[normalizedBoardId];

  if (existing?.threadId) {
    try {
      await openai.beta.threads.retrieve(existing.threadId);
      return existing.threadId;
    } catch (error) {
      logger.warn("Stored thread could not be retrieved. Recreating it.", {
        sections: [{ label: "Board ID", value: normalizedBoardId }],
        error,
      });
    }
  }

  const thread = await openai.beta.threads.create({
    metadata: {
      board_id: normalizedBoardId,
      app: "toolboard-gpt-miro",
    },
  });

  assistantMemoryStore.boards[normalizedBoardId] = {
    threadId: thread.id,
    updatedAt: new Date().toISOString(),
  };
  saveAssistantMemoryStore();
  return thread.id;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "requires_action",
  "cancelling",
]);

async function waitForRunToSettle(threadId, runId, timeoutMs = 30_000, pollMs = 1_500) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const run = await openai.beta.threads.runs.retrieve(threadId, runId);
    if (!ACTIVE_RUN_STATUSES.has(run.status)) {
      return run;
    }
    await sleep(pollMs);
  }

  return openai.beta.threads.runs.retrieve(threadId, runId);
}

async function ensureNoActiveRunOnThread(threadId) {
  const runsPage = await openai.beta.threads.runs.list(threadId, { limit: 10 });
  const activeRun = (runsPage.data || []).find((run) =>
    ACTIVE_RUN_STATUSES.has(run.status)
  );

  if (!activeRun) {
    return null;
  }

  logger.warn("Active assistant run detected. Waiting before starting a new run.", {
    sections: [
      { label: "Thread ID", value: threadId },
      { label: "Run ID", value: activeRun.id },
      { label: "Run Status", value: activeRun.status },
    ],
  });

  let settledRun = await waitForRunToSettle(threadId, activeRun.id, 8_000, 1_000);
  if (!ACTIVE_RUN_STATUSES.has(settledRun.status)) {
    return settledRun;
  }

  if (settledRun.status === "queued" || settledRun.status === "in_progress") {
    logger.warn("Active run did not settle in time. Cancelling it to avoid thread conflicts.", {
      sections: [
        { label: "Thread ID", value: threadId },
        { label: "Run ID", value: settledRun.id },
        { label: "Run Status", value: settledRun.status },
      ],
    });
    await openai.beta.threads.runs.cancel(threadId, settledRun.id);
    settledRun = await waitForRunToSettle(threadId, settledRun.id, 15_000, 1_000);
  }

  return settledRun;
}

function parseJsonResponse(raw, fallback = null) {
  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return fallback;
  }
}

function getRetryAfterMs(error) {
  const retryAfterHeader =
    error?.headers?.["retry-after"] ??
    error?.response?.headers?.["retry-after"] ??
    error?.cause?.headers?.["retry-after"];

  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  return null;
}

function isRetryableOpenAIError(error) {
  const status = error?.status ?? error?.response?.status;
  return status === 429 || (status >= 500 && status < 600);
}

async function createChatCompletionWithRetry(payload) {
  let attempt = 0;

  while (true) {
    try {
      logger.debug("OpenAI chat completion request.", {
        sections: [
          {
            label: "Payload Summary",
            value: summarizeChatPayload(payload),
            format: "json",
          },
          ...(LOG_LEVEL === "debug"
            ? [{ label: "Payload", value: payload, format: "json" }]
            : []),
        ],
      });
      return await openai.chat.completions.create(payload);
    } catch (error) {
      if (!isRetryableOpenAIError(error) || attempt >= OPENAI_MAX_RETRIES) {
        throw error;
      }

      const retryDelayMs =
        getRetryAfterMs(error) ?? Math.min(1000 * 2 ** attempt, 8000);

      logger.warn("OpenAI request failed. Retrying.", {
        sections: [
          { label: "HTTP Status", value: error?.status ?? "unknown" },
          { label: "Retry Delay (ms)", value: retryDelayMs },
          {
            label: "Attempt",
            value: `${attempt + 1}/${OPENAI_MAX_RETRIES}`,
          },
        ],
        error,
      });

      await sleep(retryDelayMs);
      attempt += 1;
    }
  }
}

async function detectLanguageWithModel(text = "", fallbackLanguage = "EN") {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) {
    return fallbackLanguage;
  }
  try {
    const completion = await createChatCompletionWithRetry({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            'You are a language classifier. Based only on the user text you receive, return exactly one code: EN, ZH, ES, or CA. If the text is empty, unclear, or mixed without a dominant language, return EN. Do not explain your choice.',
        },
        {
          role: "user",
          content: normalizedText,
        },
      ],
      temperature: 0,
      max_tokens: 5,
    });

    const raw = (completion.choices[0]?.message?.content || "").trim().toUpperCase();
    const normalized = raw.match(/\b(EN|ZH|ES|CA)\b/)?.[1] || fallbackLanguage;

    logger.debug("Model-based language detection completed.", {
      sections: [
        { label: "Detected Language", value: normalized },
        {
          label: "Source Text",
          value: truncateFactText(normalizedText, 280),
        },
      ],
    });

    return normalized;
  } catch (error) {
    const fallback = detectLanguageCode(normalizedText, fallbackLanguage);
    logger.warn("Model-based language detection failed. Falling back to heuristic detection.", {
      sections: [
        { label: "Fallback Language", value: fallback },
        { label: "Source Text", value: truncateFactText(normalizedText, 280) },
      ],
      error,
    });
    return fallback;
  }
}

function getClientKey(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.ip || "unknown";
}

function checkRateLimit(req) {
  const clientKey = getClientKey(req);
  const now = Date.now();
  const bucket = rateLimitBuckets.get(clientKey) ?? [];
  const recentRequests = bucket.filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS
  );

  if (recentRequests.length >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - recentRequests[0]);
    rateLimitBuckets.set(clientKey, recentRequests);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }

  recentRequests.push(now);
  rateLimitBuckets.set(clientKey, recentRequests);
  return { allowed: true };
}

function detectLanguageCode(text = "", forcedLang = "") {
  if (forcedLang) {
    const normalized = forcedLang.toUpperCase();
    if (["ZH", "EN", "ES", "CA"].includes(normalized)) {
      return normalized;
    }
  }

  if (/[\u4E00-\u9FFF]/.test(text)) {
    return "ZH";
  }

  const lower = text.toLowerCase();
  const countHints = (source, hints) =>
    hints.reduce((count, hint) => count + (source.includes(hint) ? 1 : 0), 0);
  const catalanHints = [
    " el ",
    " la ",
    " de ",
    " per ",
    " amb ",
    " projecte ",
    " mercat ",
    " client ",
    " proposta ",
    " equip ",
    " validacio ",
    " estratègia ",
    " estrategia ",
    " valor ",
    " usuaris ",
    " servei ",
    " aquest ",
    " aquesta ",
    " els ",
    " les ",
    " una ",
    " un ",
    " i ",
    " que ",
    " dels ",
    " al ",
    " pel ",
    " com ",
    " model de negoci ",
    " proposta de valor ",
    " però ",
    " perque ",
    " perquè ",
  ];
  const catalanScore = countHints(lower, catalanHints);
  if (/[àèéíïòóúüç]/i.test(text) || catalanScore >= 2) {
    return "CA";
  }

  if (/[áéíóúñü¿¡]/i.test(text)) {
    return "ES";
  }

  const spanishHints = [
    " el ",
    " la ",
    " de ",
    " para ",
    " con ",
    " por ",
    " los ",
    " las ",
    " una ",
    " un ",
    " y ",
    " que ",
    " del ",
    " al ",
    " como ",
    " mercado ",
    " cliente ",
    " propuesta ",
    " usuarios ",
    " servicio ",
    " modelo de negocio ",
    " propuesta de valor ",
  ];
  const spanishScore = countHints(lower, spanishHints);
  if (spanishScore >= 2) {
    return "ES";
  }

  return "EN";
}

function getLanguageLabel(langCode = "EN") {
  if (langCode === "ZH") return "Chinese";
  if (langCode === "ES") return "Spanish";
  if (langCode === "CA") return "Catalan";
  return "English";
}

function splitSentences(text = "", lang = "EN") {
  const pattern = lang === "ZH" ? /[銆傦紒锛燂紱\n]+/ : /[.!?;\n]+/;
  return text
    .split(pattern)
    .map((part) => part.trim())
    .filter(Boolean);
}

function tokenizeWestern(text = "") {
  return (text.toLowerCase().match(/[a-z谩茅铆贸煤眉帽']+/gi) || []).map((token) =>
    token.toLowerCase()
  );
}

function tokenizeChinese(text = "") {
  const matches = text.match(/[\u4E00-\u9FFF]+|[a-z0-9]+/gi) || [];
  const tokens = [];
  const prioritizedTerms = [...new Set(ZH_SEGMENT_HINTS)].sort(
    (left, right) => right.length - left.length
  );

  for (const match of matches) {
    if (/^[a-z0-9]+$/i.test(match)) {
      tokens.push(match.toLowerCase());
      continue;
    }

    let index = 0;
    while (index < match.length) {
      const remainder = match.slice(index);
      const matchedTerm = prioritizedTerms.find((term) => remainder.startsWith(term));
      if (matchedTerm) {
        tokens.push(matchedTerm);
        index += matchedTerm.length;
        continue;
      }

      const remaining = match.length - index;
      const chunkLength = remaining >= 2 ? 2 : 1;
      const chunk = match.slice(index, index + chunkLength);
      tokens.push(chunk);
      index += chunk.length;
    }
  }

  if (tokens.length === 0) {
    return (text.match(/[\u4E00-\u9FFF]/g) || []).map((char) => char.trim()).filter(Boolean);
  }

  return tokens;
}

function tagEnglishToken(token) {
  if (EN_INTERJECTIONS.has(token)) return "interj";
  if (EN_ARTICLES.has(token)) return "art";
  if (EN_PREPOSITIONS.has(token)) return "prep";
  if (EN_PRONOUNS.has(token)) return "pron";
  if (EN_PROFESSIONAL_NOUN_TERMS.has(token)) return "noun";
  if (token.endsWith("ly")) return "adv";
  if (EN_AUXILIARIES.has(token)) return "verb";
  if (/(ing|ed|en|ize|ise)$/.test(token)) return "verb";
  if (/(ous|ful|ive|less|able|ible|al|ic)$/.test(token)) return "adj";
  if (/(tion|ment|ness|ity|ship|ence|ance|er|or)$/.test(token)) return "noun";
  return "other";
}

function tagSpanishToken(token) {
  if (ES_INTERJECTIONS.has(token)) return "interj";
  if (ES_ARTICLES.has(token)) return "art";
  if (ES_PREPOSITIONS.has(token)) return "prep";
  if (ES_PRONOUNS.has(token)) return "pron";
  if (ES_PROFESSIONAL_NOUN_TERMS.has(token)) return "noun";
  if (token.endsWith("mente")) return "adv";
  if (ES_FIRST_PERSON_VERBS.has(token)) return "verb";
  if (
    token.endsWith("o") &&
    token.length > 3 &&
    !/(cion|sion|miento|dad|tad|ez|eza|ismo|ario|aria)$/.test(token)
  ) {
    return "verb";
  }
  if (/(ar|er|ir|ado|ido|ando|iendo|aron|eran|aba|aban|emos|imos)$/.test(token)) {
    return "verb";
  }
  if (/(al|able|ible|ivo|iva|ivos|ivas|oso|osa|ario|aria)$/.test(token)) {
    return "adj";
  }
  if (/(cion|sion|dad|tad|ez|eza|miento|ncia|ncias)$/.test(token)) {
    return "noun";
  }
  if (ES_ADVERBIAL_FILLERS.has(token)) return "adv";
  return "other";
}

function tagChineseToken(token) {
  if (ZH_STRONG_PRONOUN_TERMS.has(token)) return "pron";
  if (ZH_STRONG_SUBJECTIVE_TERMS.has(token)) return "verb";
  if (ZH_BUSINESS_PREP_TERMS.has(token)) return "prep";
  if (ZH_BUSINESS_NOUN_TERMS.has(token)) return "noun";
  if (ZH_PROFESSIONAL_NOUN_TERMS.has(token)) return "noun";
  if (ZH_FUNCTION_WORDS.has(token)) return "other";
  if (ZH_INTERJECTIONS.some((entry) => token.includes(entry))) return "interj";
  if (ZH_PRONOUNS.some((entry) => token === entry)) return "pron";
  if (ZH_PREPOSITIONS.some((entry) => token.includes(entry))) return "prep";
  if (ZH_ADVERBS.some((entry) => token.includes(entry))) return "adv";
  if (ZH_ADJECTIVES.some((entry) => token.includes(entry))) return "adj";
  if (ZH_VERBS.some((entry) => token.includes(entry))) return "verb";
  return "other";
}

function getLocalizedShortMessage(lang) {
  if (lang === "ZH") {
    return "内容过于简略";
  }
  if (lang === "ES") {
    return "El contenido es demasiado breve";
  }
  return "The content is too brief";
}

function getLocalizedRefinementHint(lang) {
  if (lang === "ZH") {
    return "建议：为了确保后续机会分析和商业洞察的生成质量，建议将该描述提升至更具正式性和信息密度的表达方式。";
  }
  if (lang === "ES") {
    return "Sugerencia: para asegurar la calidad del analisis posterior de oportunidades y de los hallazgos comerciales, conviene elevar esta descripcion a una expresion mas formal y con mayor densidad informativa.";
  }
  return "Suggestion: to support stronger opportunity analysis and business insight generation, this description should be elevated into a more formal and information-dense expression.";
}

function tokenizeAndTag(text = "", lang = "EN") {
  const tokens = lang === "ZH" ? tokenizeChinese(text) : tokenizeWestern(text);
  return tokens.map((token) => {
    const pos =
      lang === "ZH"
        ? tagChineseToken(token)
        : lang === "ES"
        ? tagSpanishToken(token)
        : tagEnglishToken(token);
    const weight = lang === "ZH" && pos === "noun" && token.length >= 2 ? 1.3 : 1;
    return { token, pos, weight };
  });
}

function countRegexMatches(text = "", regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function hashText(text = "") {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33) ^ text.charCodeAt(index);
  }
  return `h${(hash >>> 0).toString(16)}`;
}

function rememberGeneratedText(text = "") {
  const normalized = String(text || "").trim();
  if (!normalized) return;
  recentGeneratedContentHashes.add(hashText(normalized));
  if (recentGeneratedContentHashes.size > 200) {
    const first = recentGeneratedContentHashes.values().next().value;
    recentGeneratedContentHashes.delete(first);
  }
}

function countOccurrences(text = "", terms = []) {
  return terms.reduce(
    (total, term) => total + countRegexMatches(text, new RegExp(term, "g")),
    0
  );
}

function getShortTextPenaltyFactor(text, lang, cjkCharCount, tokenCount) {
  const compactLength = text.replace(/\s+/g, "").length;
  const langSpecificShort =
    lang === "ZH" ? cjkCharCount < 12 : tokenCount < 8;
  return compactLength < 15 || langSpecificShort ? 0.6 : 1;
}

function getComplexityConnectorBonus(text, lang) {
  if (lang === "ZH") {
    return ZH_COMPLEXITY_PATTERNS.reduce(
      (score, pattern) => score + (pattern.test(text) ? 14 : 0),
      0
    );
  }

  if (lang === "ES") {
    let score = 0;
    if (/porque[\s\S]{0,20}por eso/i.test(text)) score += 14;
    if (/por lo tanto|por tanto|de modo que|de manera que/i.test(text)) score += 10;
    if (/aunque[\s\S]{0,20}pero/i.test(text)) score += 12;
    return score;
  }

  let score = 0;
  if (/because[\s\S]{0,20}therefore/i.test(text)) score += 14;
  if (/therefore|thereby|as a result|so that/i.test(text)) score += 10;
  if (/although[\s\S]{0,20}but/i.test(text)) score += 12;
  return score;
}

function countProfessionalTerms(text = "", lang = "EN", taggedTokens = []) {
  if (lang === "ZH") {
    return countOccurrences(text, [...ZH_PROFESSIONAL_NOUN_TERMS]);
  }

  const normalized = taggedTokens.map((token) => token.token.toLowerCase());
  const sourceSet =
    lang === "ES" ? ES_PROFESSIONAL_NOUN_TERMS : EN_PROFESSIONAL_NOUN_TERMS;
  return normalized.filter((token) => sourceSet.has(token)).length;
}

export function analyzeFormality(text, lang = "", options = {}) {
  const normalizedText = (text || "").trim();
  const detectedLang = detectLanguageCode(normalizedText, lang);
  const taggedTokens = tokenizeAndTag(normalizedText, detectedLang);
  const isSystemRefined = options?.isSystemRefined === true;
  const isVerified = options?.isVerified === true;
  const isSystemGenerated = options?.isSystemGenerated === true;
  const trustedByHash = recentGeneratedContentHashes.has(hashText(normalizedText));
  const sentences = splitSentences(normalizedText, detectedLang);
  const totalTokens = taggedTokens.length;
  const cjkCharCount = (normalizedText.match(/[\u4E00-\u9FFF]/g) || []).length;
  const effectiveTokenCount =
    detectedLang === "ZH"
      ? Math.max(totalTokens, Math.ceil(cjkCharCount / 2))
      : totalTokens;
  const structurallyTooShort =
    detectedLang === "ZH"
      ? cjkCharCount < 8 && effectiveTokenCount <= 3
      : totalTokens <= 3;
  const shortTextPenaltyFactor = getShortTextPenaltyFactor(
    normalizedText,
    detectedLang,
    cjkCharCount,
    effectiveTokenCount
  );
  const professionalTermCount = countProfessionalTerms(
    normalizedText,
    detectedLang,
    taggedTokens
  );
  const isTrustedContent =
    isSystemRefined || isVerified || isSystemGenerated || trustedByHash;
  const hasWhitelistTerms =
    professionalTermCount > 0 ||
    (detectedLang === "ZH" &&
      countOccurrences(normalizedText, [...ZH_PROFESSIONAL_NOUN_TERMS]) > 0);

  logger.debug("Formality analysis input.", {
    sections: [
      {
        label: "Input",
        value: {
          detectedLang,
          rawText: normalizedText,
          totalTokens,
          effectiveTokenCount,
          cjkCharCount,
          sentenceCount: sentences.length,
          shortTextPenaltyFactor,
          isTrustedContent,
          trustedByHash,
        },
        format: "json",
      },
    ],
  });

  if (isTrustedContent) {
    const trustedOverallScore = Math.min(
      95,
      Math.max(85, 85 + Math.min(10, professionalTermCount * 2))
    );
    return {
      lang: detectedLang,
      tooShort: false,
      message: "",
      formalityScore: Math.max(88, 82 + professionalTermCount * 2),
      lexicalDensity: Math.max(85, 80 + professionalTermCount * 2),
      syntacticComplexity: Math.max(82, 78 + Math.min(12, professionalTermCount * 2)),
      overallScore: trustedOverallScore,
      avgSentenceLength: Number(
        (effectiveTokenCount / Math.max(1, sentences.length)).toFixed(1)
      ),
      level: "formal",
      needsRefinement: false,
      shouldIntervene: false,
      nextStepHint: "",
      counts: {},
      tokens: taggedTokens,
      shortTextPenaltyFactor: 1,
      professionalTermCount,
      nounRatio: 0,
      isSystemRefined,
      isVerified,
      isSystemGenerated,
      trustedByHash,
    };
  }

  if (structurallyTooShort) {
    logger.debug("Formality analysis flagged content as too short.", {
      sections: [
        {
          label: "Too Short Evaluation",
          value: {
            detectedLang,
            rawText: normalizedText,
            totalTokens,
            effectiveTokenCount,
            cjkCharCount,
          },
          format: "json",
        },
      ],
    });
    return {
      lang: detectedLang,
      tooShort: true,
      message: getLocalizedShortMessage(detectedLang),
      formalityScore: 0,
      lexicalDensity: 0,
      syntacticComplexity: 0,
      overallScore: 0,
      avgSentenceLength: totalTokens,
      level: "too-short",
      needsRefinement: true,
      shouldIntervene: true,
      nextStepHint: getLocalizedShortMessage(detectedLang),
      counts: {},
      tokens: taggedTokens,
    };
  }

  const weightedCounts = {
    noun: 0,
    adj: 0,
    prep: 0,
    art: 0,
    pron: 0,
    verb: 0,
    adv: 0,
    interj: 0,
    other: 0,
  };

  for (const token of taggedTokens) {
    weightedCounts[token.pos] = (weightedCounts[token.pos] || 0) + token.weight;
  }

  if (detectedLang === "ZH") {
    weightedCounts.pron += countOccurrences(normalizedText, [...ZH_STRONG_PRONOUN_TERMS]) * 1.4;
    weightedCounts.verb += countOccurrences(normalizedText, [...ZH_STRONG_SUBJECTIVE_TERMS]) * 1.6;
    weightedCounts.noun += countOccurrences(normalizedText, [...ZH_BUSINESS_NOUN_TERMS]) * 1.5;
    weightedCounts.prep += countOccurrences(normalizedText, [...ZH_BUSINESS_PREP_TERMS]) * 1.2;
  }

  if (detectedLang === "ES") {
    weightedCounts.verb += countOccurrences(normalizedText.toLowerCase(), [...ES_FIRST_PERSON_VERBS]) * 1.2;
  }

  const denominator = Math.max(totalTokens, 1);
  const percentage = (value) => (value / denominator) * 100;
  let nounPercent = percentage(weightedCounts.noun);
  const adjPercent = percentage(weightedCounts.adj);
  const prepPercent = percentage(weightedCounts.prep);
  const artPercent = percentage(weightedCounts.art);
  const pronPercent = percentage(weightedCounts.pron);
  const verbPercent = percentage(weightedCounts.verb);
  const advPercent = percentage(weightedCounts.adv);
  const interjPercent = percentage(weightedCounts.interj);

  if (detectedLang === "ZH") {
    nounPercent += 6;
    nounPercent += countOccurrences(normalizedText, [...ZH_PROFESSIONAL_NOUN_TERMS]) * 4;
  }
  if (detectedLang === "EN") {
    nounPercent += countProfessionalTerms(normalizedText, detectedLang, taggedTokens) * 2;
  }
  if (detectedLang === "ES") {
    nounPercent += countProfessionalTerms(normalizedText, detectedLang, taggedTokens) * 2;
  }

  let rawFScore =
    (nounPercent +
      adjPercent +
      prepPercent +
      artPercent -
      pronPercent -
      verbPercent -
      advPercent -
      interjPercent +
      100) /
    2;
  if (detectedLang === "ZH" && /鎴憒瑙夊緱/.test(normalizedText)) {
    rawFScore = Math.min(rawFScore, 50);
  }
  const formalityScore = Math.max(0, Math.min(100, Math.round(rawFScore)));

  let contentWordWeight =
    weightedCounts.noun +
    weightedCounts.adj +
    weightedCounts.verb +
    weightedCounts.adv;
  const nounRatio = weightedCounts.noun / denominator;
  if (detectedLang === "ZH") {
    const functionWordPenalty = countOccurrences(normalizedText, [...ZH_FUNCTION_WORDS]) * 1.2;
    contentWordWeight = Math.max(0, contentWordWeight - functionWordPenalty);
  }
  let lexicalDensity = Math.max(
    0,
    Math.min(100, Math.round((contentWordWeight / denominator) * 100))
  );
  if (isSystemRefined || nounRatio >= 0.55 || (denominator <= 6 && nounRatio >= 0.8)) {
    lexicalDensity = Math.max(lexicalDensity, 75);
  } else if (professionalTermCount >= 3 && denominator <= 8) {
    lexicalDensity = Math.max(lexicalDensity, 68);
  }

  const avgSentenceLength = Number(
    (effectiveTokenCount / Math.max(1, sentences.length)).toFixed(1)
  );
  let syntacticComplexity = Math.max(
    0,
    Math.min(
      100,
      Math.round(avgSentenceLength * 5 + getComplexityConnectorBonus(normalizedText, detectedLang))
    )
  );
  if (syntacticComplexity < 60 && professionalTermCount >= 3) {
    syntacticComplexity = Math.min(100, syntacticComplexity + 20);
  }
  if (hasWhitelistTerms && denominator <= 8) {
    syntacticComplexity = Math.max(syntacticComplexity, 72);
  }

  let overallScore = Math.round(
    ((formalityScore + lexicalDensity + syntacticComplexity) / 3) *
      (denominator <= 6 && nounRatio >= 0.8 ? 1 : shortTextPenaltyFactor)
  );
  if (isSystemRefined) {
    overallScore = Math.max(overallScore, 80);
  }
  if (hasWhitelistTerms && denominator <= 8) {
    overallScore = Math.max(overallScore, 80);
  }
  overallScore = Math.max(0, Math.min(100, overallScore));

  const invalidBriefHighScore =
    !isSystemRefined &&
    shortTextPenaltyFactor < 1 &&
    formalityScore > 90 &&
    (detectedLang === "ZH" ? cjkCharCount < 12 : effectiveTokenCount < 8);

  if (invalidBriefHighScore) {
    return {
      lang: detectedLang,
      tooShort: true,
      message:
        detectedLang === "ZH"
          ? "内容过于简略，导师无法提供有效建议。"
          : detectedLang === "ES"
          ? "El contenido es demasiado breve y no permite ofrecer una sugerencia util."
          : "The content is too brief for the mentor to provide effective guidance.",
      formalityScore,
      lexicalDensity,
      syntacticComplexity,
      overallScore: Math.round(overallScore * 0.6),
      avgSentenceLength,
      level: "too-short",
      needsRefinement: true,
      shouldIntervene: true,
      nextStepHint: getLocalizedShortMessage(detectedLang),
      counts: weightedCounts,
      tokens: taggedTokens,
    };
  }

  let level = "informal";
  if (overallScore >= 75) {
    level = "formal";
  } else if (overallScore >= 60) {
    level = "semi-formal";
  }
  const needsRefinement = overallScore < 60;

  logger.debug("Formality analysis metrics.", {
    sections: [
      {
        label: "Metrics",
        value: {
          detectedLang,
          totalTokens,
          effectiveTokenCount,
          cjkCharCount,
          noun_count: weightedCounts.noun,
          adj_count: weightedCounts.adj,
          prep_count: weightedCounts.prep,
          art_count: weightedCounts.art,
          pron_count: weightedCounts.pron,
          verb_count: weightedCounts.verb,
          adv_count: weightedCounts.adv,
          interj_count: weightedCounts.interj,
          formalityScore,
          lexicalDensity,
          syntacticComplexity,
          overallScore,
          avgSentenceLength,
          level,
          shortTextPenaltyFactor,
          professionalTermCount,
          nounRatio,
          isSystemRefined,
        },
        format: "json",
      },
    ],
  });

  return {
    lang: detectedLang,
    tooShort: false,
    message: level === "formal" ? "" : getLocalizedRefinementHint(detectedLang),
    formalityScore,
    lexicalDensity,
    syntacticComplexity,
    overallScore,
    avgSentenceLength,
    level,
    needsRefinement,
    shouldIntervene: needsRefinement,
    nextStepHint: level !== "formal" ? getLocalizedRefinementHint(detectedLang) : "",
    counts: weightedCounts,
    tokens: taggedTokens,
    shortTextPenaltyFactor,
    professionalTermCount,
    nounRatio,
    isSystemRefined,
  };
}

async function rewriteFormalText(text, lang = "") {
  const detectedLang = detectLanguageCode(text, lang);
  const promptLanguage =
    detectedLang === "ZH" ? "涓枃" : detectedLang === "ES" ? "瑗跨彮鐗欒" : "English";

  const completion = await createChatCompletionWithRetry({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "You are a senior business advisor. Rewrite the following [Lang] text into a formal business statement with a high F-score, high lexical density, and strong syntactic structure. Preserve the core facts, remove conversational fillers such as 觉得, 好像, creo que, and I think, and return only the rewritten text.",
      },
      {
        role: "user",
        content: `[Lang: ${promptLanguage}]\n${text}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 600,
  });

  return {
    lang: detectedLang,
    rewrittenText: (completion.choices[0]?.message?.content || "").trim(),
  };
}

function getMethodologyGoal(toolId, toolTitle = "", questionDescription = "") {
  const defaults = {
    0: "clarify role boundaries, responsibilities, and collaboration rules within the team",
    1: "clarify market size, pain depth, evidence, and the target-user profile behind the opportunity",
    2: "capture observed facts and infer concrete user needs from field evidence",
    3: "define the ideal client and frame the entrepreneurship opportunity with explicit insights",
    4: "shape solution concepts around feasibility, value proposition, and delivery logic",
    5: "explain how value is created, delivered, and monetized through a coherent business model",
    6: "translate solution assumptions into a testable prototype and sharpen product positioning",
    7: "validate hypotheses with well-scoped experiments, evidence, and learning outcomes",
    8: "organize financial evidence and assess business viability",
    9: "synthesize the venture into a clear, convincing dissemination pitch",
  };

  return (
    defaults[toolId] ||
    `${toolTitle || "The current tool"} should help clarify ${questionDescription || "the current business decision"}.`
  );
}

function getToolRewriteFocus(toolId) {
  const defaults = {
    0: "emphasize functional boundaries, ownership, and collaboration relationships",
    1: "emphasize market size, pain depth, evidence, and user segmentation",
    2: "emphasize observed facts, behaviors, and inferred user needs",
    3: "emphasize ideal-client clarity, opportunity framing, and actionable design principles",
    4: "emphasize technical feasibility, value proposition, and delivery model",
    5: "emphasize value creation, monetization logic, and business-model coherence",
    6: "emphasize test priorities, validation scope, and positioning logic",
    7: "emphasize hypothesis quality, experiment design, and evidence-based learning",
    8: "emphasize assumptions, cost structure, and financial viability logic",
    9: "emphasize synthesis, strategic clarity, and persuasive venture storytelling",
  };

  return defaults[toolId] || "emphasize structured business reasoning and explicit decision logic";
}

function buildRefinementContext(note = {}) {
  return {
    toolId: note.toolId ?? null,
    toolTitle: note.toolName || note.toolTitle || "",
    questionId: note.qId || note.frameTitle || note.questionId || "",
    questionDescription: note.questionDescription || "",
    methodologyGoal:
      note.methodologyGoal ||
      getMethodologyGoal(note.toolId, note.toolName || note.toolTitle, note.questionDescription),
    toolSpecificFocus:
      note.toolSpecificFocus || getToolRewriteFocus(note.toolId),
    frameTitle: note.frameTitle || "",
  };
}

async function rewriteFormalTextWithContext(text, lang = "", context = {}) {
  const detectedLang = detectLanguageCode(text, lang);
  const promptLanguage =
    detectedLang === "ZH" ? "Chinese" : detectedLang === "ES" ? "Spanish" : "English";
  const safeContext = buildRefinementContext(context);
  const currentContext = context.currentContext || {
    toolContext: [],
    projectContext: [],
    targetQuestion: {
      questionId: safeContext.questionId,
      questionText: safeContext.questionDescription,
      toolName: safeContext.toolTitle,
    },
  };

  const completion = await createChatCompletionWithRetry({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "You are a professional entrepreneurship mentor. Your task is to optimize a beginner-level idea written on a Miro sticky note.\n\nCurrent context:\n- The user is working in [{{toolTitle}}] during [{{questionDescription}}].\n- The core goal of this step is [{{methodologyGoal}}].\n- For this tool, the rewrite should especially [{{toolSpecificFocus}}].\n\nRewrite rules:\n- Reject superficial polishing. If the source text is sparse, do not merely swap synonyms.\n- Use logical placeholder guidance. Rewrite the note into a professional, structured statement.\n- When critical information is missing for this step, insert bracketed placeholders such as [target user segment], [evidence to validate], or [delivery constraint] so the user knows what to complete next.\n- Preserve the user's intent and keep the rewritten text relatively close in length.\n- Remove subjective fillers such as 鎴戣寰? 鎰熻, 濂藉儚, creo que, pienso que, I think, or I feel.\n- Return only the rewritten text in the same language as the source, with no preamble or explanation.",
      },
      {
        role: "user",
        content: `[Lang: ${promptLanguage}]
[Tool Title: ${safeContext.toolTitle}]
[Question Description: ${safeContext.questionDescription}]
[Methodology Goal: ${safeContext.methodologyGoal}]
[Tool-Specific Focus: ${safeContext.toolSpecificFocus}]
[Frame: ${safeContext.frameTitle}]

Original sticky text:
${text}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 600,
  });

  return {
    lang: detectedLang,
    rewrittenText: (completion.choices[0]?.message?.content || "").trim(),
  };
}

async function rewriteFormalTextWithGlobalContext(text, lang = "", context = {}) {
  const detectedLang = detectLanguageCode(text, lang);
  const promptLanguage =
    detectedLang === "ZH" ? "Chinese" : detectedLang === "ES" ? "Spanish" : "English";
  const safeContext = buildRefinementContext(context);
  const currentContext = context.currentContext || {
    toolContext: [],
    projectContext: [],
    targetQuestion: {
      questionId: safeContext.questionId,
      questionText: safeContext.questionDescription,
      toolName: safeContext.toolTitle,
    },
  };

  const completion = await createChatCompletionWithRetry({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "You are an extremely insightful entrepreneurship partner. Your task is to optimize the user's current expression based on the user's existing reasoning, and your answer must remain fully professional and concise.\n\nInput data:\n- Existing user context: {{currentContext}}. You must reason from these established facts.\n- Current problem background: [{{toolTitle}}] / [{{questionDescription}}].\n- Core step goal: [{{methodologyGoal}}].\n- Tool-specific emphasis: [{{toolSpecificFocus}}].\n- Current draft to optimize: '{{originalText}}'.\n\nRewrite rules:\n- Stay faithful to the user's intent. Never invent a direction that ignores the existing board context.\n- Use the existing facts from the current tool and previous tools to complete the logic of the current card.\n- Keep the writing concise, business-like, and dense. Remove redundancy and keep only the most useful content.\n- Reject superficial polishing. If the original input is sparse, do not just replace words. Turn it into a structured business statement.\n- If critical information is missing for this step, insert compact bracketed placeholders such as [target user segment] or [evidence to validate] so the user can complete them later.\n- Return only the final rewritten text in the original language. No preamble, no bullet list, and no explanation.",
      },
      {
        role: "user",
        content: `[Lang: ${promptLanguage}]
[Current Context: ${JSON.stringify(currentContext)}]
[Tool Title: ${safeContext.toolTitle}]
[Question Description: ${safeContext.questionDescription}]
[Methodology Goal: ${safeContext.methodologyGoal}]
[Tool-Specific Focus: ${safeContext.toolSpecificFocus}]
[Frame: ${safeContext.frameTitle}]

Original sticky text:
${text}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 600,
  });

  return {
    lang: detectedLang,
    rewrittenText: (completion.choices[0]?.message?.content || "").trim(),
  };
}

function flattenNotes(boardContext = []) {
  const notes = [];

  for (const tool of boardContext) {
    for (const question of tool.questions ?? []) {
      const noteDetails = Array.isArray(question.noteDetails)
        ? question.noteDetails
        : (question.notes ?? []).map((text) => ({ id: null, text }));

      for (const note of noteDetails) {
        if (!note?.text?.trim()) continue;
        notes.push({
          toolId: tool.toolId,
          toolName: tool.toolName,
          toolDescription: tool.toolDescription || "",
          qId: question.qId,
          questionDescription: question.label || "",
          methodologyGoal: getMethodologyGoal(
            tool.toolId,
            tool.toolName,
            question.label || ""
          ),
          toolSpecificFocus: getToolRewriteFocus(tool.toolId),
          frameTitle: question.anchorFrameTitle,
          noteId: note.id ?? null,
          text: note.text.trim(),
          widgetType: note.widgetType ?? "sticky_note",
          refinedByAgent: note.refinedByAgent === true,
          verified: note.verified === true,
          isSystemGenerated: note.isSystemGenerated === true,
        });
      }
    }
  }

  return notes;
}

function extractQuestionNotes(question = {}) {
  const noteDetails = Array.isArray(question.noteDetails)
    ? question.noteDetails
    : (question.notes ?? []).map((text) => ({ text }));

  return noteDetails
    .map((note) => String(note?.text || "").trim())
    .filter(Boolean);
}

function extractQuestionUserNotes(question = {}) {
  const noteDetails = Array.isArray(question.noteDetails)
    ? question.noteDetails
    : (question.notes ?? []).map((text) => ({ text }));

  return noteDetails
    .filter((note) => {
      if (!String(note?.text || "").trim()) {
        return false;
      }

      return note?.isSystemGenerated !== true && note?.refinedByAgent !== true;
    })
    .map((note) => String(note?.text || "").trim())
    .filter(Boolean);
}

function buildCurrentContextFromBoard(boardContext = [], note = {}) {
  const currentTool = boardContext.find((tool) => tool.toolId === note.toolId);
  const toolContext = (currentTool?.questions ?? [])
    .filter((question) => question.qId !== note.qId)
    .map((question) => ({
      questionId: question.qId,
      questionText: question.label || "",
      notes: extractQuestionNotes(question),
    }))
    .filter((entry) => entry.notes.length > 0);

  const projectContext = boardContext
    .filter((tool) => typeof tool.toolId === "number" && tool.toolId < (note.toolId ?? 999))
    .flatMap((tool) =>
      (tool.questions ?? [])
        .map((question) => ({
          toolId: tool.toolId,
          toolName: tool.toolName,
          questionId: question.qId,
          questionText: question.label || "",
          notes: extractQuestionNotes(question),
        }))
        .filter((entry) => entry.notes.length > 0)
    )
    .slice(-8);

  return {
    toolContext,
    projectContext,
    targetQuestion: {
      questionId: note.qId || note.questionId || note.frameTitle || "",
      questionText: note.questionDescription || "",
      toolName: note.toolName || note.toolTitle || "",
    },
  };
}

function truncateFactText(text = "", maxLength = 160) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

function extractLatestQuestionFacts(question = {}, maxFacts = 4) {
  const noteDetails = Array.isArray(question.noteDetails)
    ? question.noteDetails
    : (question.notes ?? []).map((text) => ({ text }));

  return noteDetails
    .map((note) => String(note?.text || "").trim())
    .filter(Boolean)
    .slice(-maxFacts)
    .map((text) => truncateFactText(text, 220));
}

function buildAuthoritativeLanguageSource(
  boardContext = [],
  focusToolId = null,
  focusQuestionId = "",
  maxFacts = 12
) {
  const currentTool = boardContext.find((entry) => entry.toolId === focusToolId);
  const currentQuestion = (currentTool?.questions ?? []).find(
    (entry) => entry.qId === focusQuestionId
  );
  const currentQuestionUserNotes = extractQuestionUserNotes(currentQuestion)
    .slice(-maxFacts)
    .map((text) => truncateFactText(text, 220));

  if (currentQuestionUserNotes.length > 0) {
    return {
      facts: currentQuestionUserNotes,
      sourceLevel: "current-question-user-notes",
    };
  }

  const historicalUserNotes = flattenNotes(boardContext)
    .filter(
      (note) =>
        note.isSystemGenerated !== true &&
        note.refinedByAgent !== true &&
        String(note.text || "").trim()
    )
    .filter(
      (note) => !(note.toolId === focusToolId && note.qId === focusQuestionId)
    )
    .slice(-maxFacts)
    .map((note) => truncateFactText(note.text, 220));

  if (historicalUserNotes.length > 0) {
    return {
      facts: historicalUserNotes,
      sourceLevel: "historical-user-notes",
    };
  }

  return {
    facts: [],
    sourceLevel: "default-english",
  };
}

function buildFilledFrameSummaries(
  boardContext = [],
  focusToolId = null,
  focusQuestionId = "",
  maxFrames = 10
) {
  const summaries = [];

  for (const tool of boardContext) {
    for (const question of tool.questions ?? []) {
      const notes = extractQuestionNotes(question);
      if (notes.length === 0) continue;
      if (tool.toolId === focusToolId && question.qId === focusQuestionId) continue;

      summaries.push({
        toolId: tool.toolId,
        toolName: tool.toolName,
        questionId: question.qId,
        frameTitle: question.anchorFrameTitle,
        summary: truncateFactText(notes.join(" | "), 220),
      });
    }
  }

  return summaries.slice(0, maxFrames);
}

function countQuestionPrompts(label = "") {
  const text = String(label || "").trim();
  if (!text) {
    return 0;
  }

  const matches = text.match(/\?/g);
  return matches ? matches.length : 0;
}

function getSuggestionCountPlan(focusQuestion = {}) {
  const subQuestionCount = countQuestionPrompts(focusQuestion?.label || "");
  const isMultiSubQuestion = subQuestionCount >= 4;
  const targetCount = isMultiSubQuestion
    ? Math.min(Math.max(subQuestionCount, 4), 5)
    : 3;

  return {
    subQuestionCount,
    isMultiSubQuestion,
    targetCount,
  };
}

function buildIncrementalFactsPayload({
  boardContext = [],
  toolId = null,
  toolName = "",
  toolDescription = "",
  focusQuestion = {},
  preferredLanguage = "",
  dominantLanguageOverride = "",
} = {}) {
  const currentTool = boardContext.find((entry) => entry.toolId === toolId);
  const dominantLanguage =
    dominantLanguageOverride ||
    getPreferredSuggestionLanguage(
      boardContext,
      toolId,
      focusQuestion?.qId || "",
      preferredLanguage
    );
  const currentQuestion = (currentTool?.questions ?? []).find(
    (entry) => entry.qId === focusQuestion?.qId
  );
  const authoritativeLanguageSource = buildAuthoritativeLanguageSource(
    boardContext,
    toolId,
    focusQuestion?.qId || ""
  );
  const latestFacts = extractLatestQuestionFacts(currentQuestion);
  const otherFrameSummaries = buildFilledFrameSummaries(
    boardContext,
    toolId,
    focusQuestion?.qId || ""
  );
  const boardSummary = summarizeBoardContext(boardContext);
  const suggestionCountPlan = getSuggestionCountPlan(focusQuestion);

  return {
    currentTool: {
      toolId,
      toolName,
      toolDescription,
    },
    targetQuestion: {
      qId: focusQuestion?.qId || "",
      label: focusQuestion?.label || "",
      anchorFrameTitle: focusQuestion?.anchorFrameTitle || "",
    },
    authoritativeLanguageFacts: authoritativeLanguageSource.facts,
    authoritativeLanguageSourceLevel:
      authoritativeLanguageSource.sourceLevel,
    suggestionCountPlan,
    latestStickyFacts: latestFacts,
    otherFilledFrames: otherFrameSummaries,
    boardSummary: {
      filledFrames: boardSummary.filledFrames,
      totalFrames: boardSummary.totalFrames,
      completionScore: boardSummary.completionScore,
    },
    dominantLanguage,
  };
}

function formatIncrementalFactsMessage(factsPayload, eventType = "analyse") {
  const languageLabel = getLanguageLabel(factsPayload.dominantLanguage);

  return [
    `Event: ${eventType}`,
    `Required response language: ${languageLabel} (${factsPayload.dominantLanguage})`,
    `Current tool: ${factsPayload.currentTool.toolName} (#${factsPayload.currentTool.toolId})`,
    `Current question: ${factsPayload.targetQuestion.label}`,
    `Current frame: ${factsPayload.targetQuestion.anchorFrameTitle}`,
    `Authoritative language source level: ${factsPayload.authoritativeLanguageSourceLevel}`,
    `Suggestion count plan: ${JSON.stringify(factsPayload.suggestionCountPlan)}`,
    `Authoritative language facts: ${JSON.stringify(
      factsPayload.authoritativeLanguageFacts
    )}`,
    `Latest sticky facts: ${JSON.stringify(factsPayload.latestStickyFacts)}`,
    `Other filled frame summaries: ${JSON.stringify(factsPayload.otherFilledFrames)}`,
    `Board summary: ${JSON.stringify(factsPayload.boardSummary)}`,
  ].join("\n");
}

async function extractLatestAssistantReply(threadId) {
  const messages = await openai.beta.threads.messages.list(threadId, {
    order: "desc",
    limit: 10,
  });
  const latestAssistantMessage = messages.data.find(
    (message) => message.role === "assistant"
  );

  if (!latestAssistantMessage) {
    return "";
  }

  return latestAssistantMessage.content
    .map((block) => {
      if (block.type === "text") {
        return block.text?.value || "";
      }

      return "";
    })
    .join("\n")
    .trim();
}

function doSuggestionsMatchLanguage(suggestions = [], targetLanguage = "EN") {
  const combinedText = suggestions
    .flatMap((suggestion) => [suggestion?.title || "", suggestion?.content || suggestion?.text || ""])
    .join(" ")
    .trim();

  if (!combinedText) {
    return true;
  }

  return detectLanguageCode(combinedText) === targetLanguage;
}

async function realignSuggestionsToLanguage(suggestions = [], targetLanguage = "EN") {
  const languageLabel = getLanguageLabel(targetLanguage);
  const completion = await createChatCompletionWithRetry({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          `You are a precise JSON editor. Rewrite the suggestion titles and contents so they are entirely in ${languageLabel}. Preserve the meaning, business intent, and JSON structure. Return only valid JSON in the form {"suggestions":[{"id":"s1","title":"...","content":"..."},{"id":"s2","title":"...","content":"..."},{"id":"s3","title":"...","content":"..."}]}. Do not mix languages.`,
      },
      {
        role: "user",
        content: JSON.stringify({ suggestions }),
      },
    ],
    temperature: 0.2,
    max_tokens: 1200,
  });
  return parseJsonResponse(completion.choices[0]?.message?.content || "", null);
}

async function generateDirectSuggestions({
  factsPayload,
  toolName = "",
  toolDescription = "",
} = {}) {
  const targetLanguage = factsPayload?.dominantLanguage || "EN";
  const languageLabel = getLanguageLabel(targetLanguage);
  const authoritativeLanguageFacts = Array.isArray(
    factsPayload?.authoritativeLanguageFacts
  )
    ? factsPayload.authoritativeLanguageFacts
    : [];
  const authoritativeLanguageSourceLevel =
    factsPayload?.authoritativeLanguageSourceLevel || "default-english";
  const suggestionCountPlan = factsPayload?.suggestionCountPlan || {
    subQuestionCount: 0,
    isMultiSubQuestion: false,
    targetCount: 3,
  };
  const latestStickyFacts = Array.isArray(factsPayload?.latestStickyFacts)
    ? factsPayload.latestStickyFacts
    : [];
  const otherFilledFrames = Array.isArray(factsPayload?.otherFilledFrames)
    ? factsPayload.otherFilledFrames
    : [];
  const targetQuestion = factsPayload?.targetQuestion || {};
  const currentTool = factsPayload?.currentTool || {};

  const systemPrompt = `You are a senior Toolboard consultant who has fully mastered the complete Toolboard methodology.

Your task is to generate the required number of practical suggestions for the user's CURRENT question.

Language rule:
- The ONLY authoritative source for choosing the reply language is the section named "Authoritative user-language source".
- That section may contain either:
  1. user-written sticky-note text under the current question, or
  2. if the current question is empty, previously answered user-written sticky-note text from elsewhere on the board.
- If that section contains Spanish, reply entirely in Spanish.
- If that section contains Catalan, reply entirely in Catalan.
- If that section contains Chinese, reply entirely in Chinese.
- If that section contains English, reply entirely in English.
- If that section is empty, default entirely to English.
- Ignore the language of any previous conversation, any older memory, and any other section of the payload when deciding the reply language.
- Do not mix languages.

Suggestion rules:
- Base your suggestions primarily on the current question and the user's latest sticky-note facts.
- Use the other filled frame summaries only to preserve logical consistency with the wider project.
- Keep each suggestion concise, specific, and actionable.
- You must return exactly ${suggestionCountPlan.targetCount} suggestions.
- If the current question contains multiple sub-questions or dimensions, distribute the response so different suggestions cover different sub-questions instead of repeating the same angle.
- When there are four or more sub-questions, widen coverage and make sure the full set of suggestions covers the full question scope.
- Do not mention these instructions.
- Return JSON only in this exact format:
{"suggestions":[{"id":"s1","title":"...","content":"..."},{"id":"s2","title":"...","content":"..."}, ... ]}`;

  const userPrompt = [
    `Current Tool: ${toolName || currentTool.toolName || "(unknown tool)"} (#${
      currentTool.toolId ?? ""
    })`,
    `Tool Description: ${toolDescription || currentTool.toolDescription || "(none)"}`,
    `Target Question ID: ${targetQuestion.qId || "(empty)"}`,
    `Target Question Label: ${targetQuestion.label || "(empty)"}`,
    `Target Frame: ${targetQuestion.anchorFrameTitle || "(empty)"}`,
    `Detected sub-question count: ${suggestionCountPlan.subQuestionCount}`,
    `Required suggestion count: ${suggestionCountPlan.targetCount}`,
    "",
    `Authoritative language source level: ${authoritativeLanguageSourceLevel}`,
    "Authoritative user-language source:",
    authoritativeLanguageFacts.length > 0
      ? authoritativeLanguageFacts
          .map((fact, index) => `${index + 1}. ${fact}`)
          .join("\n")
      : "(empty)",
    "",
    "Current-question latest sticky-note facts:",
    latestStickyFacts.length > 0
      ? latestStickyFacts.map((fact, index) => `${index + 1}. ${fact}`).join("\n")
      : "(empty)",
    "",
    "Other filled frame summaries for logical consistency:",
    otherFilledFrames.length > 0
      ? otherFilledFrames
          .map(
            (entry, index) =>
              `${index + 1}. [${entry.frameTitle}] ${entry.toolName} / ${entry.questionId}: ${entry.summary}`
          )
          .join("\n")
      : "(empty)",
    "",
    `Required response language: ${languageLabel} (${targetLanguage})`,
  ].join("\n");

  const completion = await createChatCompletionWithRetry({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.35,
    max_tokens: 1200,
  });

  const rawReply = completion.choices[0]?.message?.content ?? "{}";
  let parsed = parseJsonResponse(rawReply, null);

  if (!parsed?.suggestions || !Array.isArray(parsed.suggestions)) {
    return { rawReply, parsed: null, targetLanguage };
  }

  parsed.suggestions = parsed.suggestions
    .filter((entry) => entry && (entry.title || entry.content || entry.text))
    .slice(0, suggestionCountPlan.targetCount)
    .map((entry, index) => ({
      id: entry.id || `s${index + 1}`,
      title: entry.title || `Suggestion ${index + 1}`,
      content: entry.content || entry.text || "",
    }));

  if (!doSuggestionsMatchLanguage(parsed.suggestions, targetLanguage)) {
    logger.warn("Suggestion language drift detected in direct suggestion mode. Realigning output.", {
      sections: [
        { label: "Expected Language", value: `${languageLabel} (${targetLanguage})` },
        { label: "Detected Output", value: formatSuggestionsList(parsed.suggestions) },
      ],
    });
    const realigned = await realignSuggestionsToLanguage(parsed.suggestions, targetLanguage);
    if (realigned?.suggestions && Array.isArray(realigned.suggestions)) {
      parsed = realigned;
    }
  }

  return {
    rawReply,
    parsed,
    targetLanguage,
  };
}

async function syncThreadMemory({
  boardId = DEFAULT_BOARD_ID,
  boardContext = [],
  toolId = null,
  toolName = "",
  toolDescription = "",
  focusQuestion = null,
  preferredLanguage = "",
  eventType = "preview",
} = {}) {
  const assistant = await ensureGlobalToolboardAssistant();
  const threadId = await ensureBoardThread(boardId);
  const dominantLanguageOverride =
    eventType === "analyse"
      ? await detectSuggestionLanguageWithModel(
          boardContext,
          toolId,
          focusQuestion?.qId || ""
        )
      : "";
  const factsPayload = buildIncrementalFactsPayload({
    boardContext,
    toolId,
    toolName,
    toolDescription,
    focusQuestion: focusQuestion || {},
    preferredLanguage,
    dominantLanguageOverride,
  });
  const content = formatIncrementalFactsMessage(factsPayload, eventType);

  await openai.beta.threads.messages.create(threadId, {
    role: "user",
    content,
    metadata: {
      board_id: String(boardId || DEFAULT_BOARD_ID),
      event_type: eventType,
      focus_frame: factsPayload.targetQuestion.anchorFrameTitle || "board-summary",
    },
  });

  assistantMemoryStore.boards[String(boardId || DEFAULT_BOARD_ID)] = {
    ...(assistantMemoryStore.boards[String(boardId || DEFAULT_BOARD_ID)] || {}),
    threadId,
    updatedAt: new Date().toISOString(),
  };
  saveAssistantMemoryStore();

  return {
    assistantId: assistant.id,
    threadId,
    factsPayload,
  };
}

async function generateAssistantSuggestionsFromThread({
  threadId,
  assistantId,
  factsPayload,
}) {
  await ensureNoActiveRunOnThread(threadId);

  const targetLanguage = factsPayload?.dominantLanguage || "EN";
  const responseLanguage = getLanguageLabel(targetLanguage);
  const currentStickyLanguageEvidence = Array.isArray(factsPayload?.latestStickyFacts)
    ? factsPayload.latestStickyFacts.join(" | ")
    : "";

  const run = await openai.beta.threads.runs.createAndPoll(threadId, {
    assistant_id: assistantId,
    additional_instructions:
      `Respond with only valid JSON in the form {"suggestions":[{"id":"s1","title":"...","content":"..."},{"id":"s2","title":"...","content":"..."},{"id":"s3","title":"...","content":"..."}]}. Use the thread memory plus the new facts for this run. The language of the user's current sticky-note answer is ${responseLanguage}. Every suggestion title and every suggestion content field must be written entirely in ${responseLanguage}. Base your reply language on the user's current sticky-note text, not on any previous thread language. Do not mix languages and do not default back to a previous thread language. Current sticky-note language evidence: ${currentStickyLanguageEvidence || "(empty)"}.`,
    response_format: { type: "json_object" },
    temperature: 0.4,
  });

  if (run.status !== "completed") {
    logger.error("Assistant run failed before completion.", {
      sections: [
        { label: "Thread ID", value: threadId },
        { label: "Run ID", value: run.id },
        { label: "Run Status", value: run.status },
        { label: "Last Error", value: run.last_error || "(none)", format: "json" },
        {
          label: "Incomplete Details",
          value: run.incomplete_details || "(none)",
          format: "json",
        },
      ],
    });
    throw new Error(`Assistant run ended with status ${run.status}`);
  }

  const rawReply = await extractLatestAssistantReply(threadId);
  let parsed = parseJsonResponse(rawReply, null);

  if (
    parsed?.suggestions &&
    Array.isArray(parsed.suggestions) &&
    !doSuggestionsMatchLanguage(parsed.suggestions, targetLanguage)
  ) {
    logger.warn("Assistant suggestions language drift detected. Realigning response language.", {
      sections: [
        { label: "Thread ID", value: threadId },
        { label: "Run ID", value: run.id },
        { label: "Target Language", value: targetLanguage },
      ],
    });
    const realigned = await realignSuggestionsToLanguage(parsed.suggestions, targetLanguage);
    if (realigned?.suggestions && Array.isArray(realigned.suggestions)) {
      parsed = realigned;
    }
  }

  return {
    runId: run.id,
    rawReply,
    parsed,
  };
}

async function buildQualityAlert(boardContext = []) {
  const notes = flattenNotes(boardContext);
  if (notes.length === 0) {
    return null;
  }

  const scoredNotes = notes
    .map((note) => ({
      ...note,
      audit: analyzeFormality(note.text, "", {
        isSystemRefined: note.refinedByAgent,
        isVerified: note.verified,
        isSystemGenerated: note.isSystemGenerated,
      }),
    }))
    .sort((left, right) => left.audit.overallScore - right.audit.overallScore);

  const substantiveNotes = scoredNotes.filter((entry) => !entry.audit.tooShort);
  const shortNotes = scoredNotes.filter((entry) => entry.audit.tooShort);
  const candidate =
    substantiveNotes.find((entry) => entry.audit.needsRefinement) ||
    substantiveNotes.find((entry) => entry.audit.level === "semi-formal") ||
    (substantiveNotes.length === 0 ? shortNotes[0] : null);

  logger.debug("Quality alert candidate selection.", {
    sections: [
      {
        label: "Selection",
        value: {
          totalNotes: notes.length,
          substantiveNotes: substantiveNotes.length,
          shortNotes: shortNotes.length,
          selectedText: candidate?.text || null,
          selectedLevel: candidate?.audit?.level || null,
          selectedTooShort: candidate?.audit?.tooShort || false,
        },
        format: "json",
      },
    ],
  });

  if (!candidate) {
    return null;
  }

  if (candidate.audit.tooShort) {
    const candidateContext = buildCurrentContextFromBoard(boardContext, candidate);
    return {
      noteId: candidate.noteId,
      frameTitle: candidate.frameTitle,
      toolName: candidate.toolName,
      questionId: candidate.qId,
      questionDescription: candidate.questionDescription,
      methodologyGoal: candidate.methodologyGoal,
      toolSpecificFocus: candidate.toolSpecificFocus,
      currentContext: candidateContext,
      lang: candidate.audit.lang,
      sourceText: candidate.text,
      rewrittenText: "",
      canApply: false,
      needsRefinement: false,
      isTooShort: true,
      message: getLocalizedShortMessage(candidate.audit.lang),
      qualityMetrics: {
        formalityScore: candidate.audit.formalityScore,
        lexicalDensity: candidate.audit.lexicalDensity,
        syntacticComplexity: candidate.audit.syntacticComplexity,
        overallScore: candidate.audit.overallScore,
      },
    };
  }

  if (!candidate.audit.needsRefinement) {
    const candidateContext = buildCurrentContextFromBoard(boardContext, candidate);
    return {
      noteId: candidate.noteId,
      frameTitle: candidate.frameTitle,
      toolName: candidate.toolName,
      questionId: candidate.qId,
      questionDescription: candidate.questionDescription,
      methodologyGoal: candidate.methodologyGoal,
      toolSpecificFocus: candidate.toolSpecificFocus,
      currentContext: candidateContext,
      lang: candidate.audit.lang,
      sourceText: candidate.text,
      rewrittenText: "",
      canApply: false,
      needsRefinement: false,
      isTooShort: false,
      message: candidate.audit.nextStepHint,
      qualityMetrics: {
        formalityScore: candidate.audit.formalityScore,
        lexicalDensity: candidate.audit.lexicalDensity,
        syntacticComplexity: candidate.audit.syntacticComplexity,
        overallScore: candidate.audit.overallScore,
      },
    };
  }

  const candidateContext = buildCurrentContextFromBoard(boardContext, candidate);
  const rewritten = await rewriteFormalTextWithGlobalContext(
    candidate.text,
    candidate.audit.lang,
    {
      ...buildRefinementContext(candidate),
      currentContext: candidateContext,
    }
  );
  return {
    noteId: candidate.noteId,
    frameTitle: candidate.frameTitle,
    toolName: candidate.toolName,
    questionId: candidate.qId,
    questionDescription: candidate.questionDescription,
    methodologyGoal: candidate.methodologyGoal,
    toolSpecificFocus: candidate.toolSpecificFocus,
    currentContext: candidateContext,
    lang: candidate.audit.lang,
    sourceText: candidate.text,
    rewrittenText: rewritten.rewrittenText,
    canApply: Boolean(candidate.noteId && rewritten.rewrittenText),
    needsRefinement: true,
    isTooShort: false,
    message: getLocalizedRefinementHint(candidate.audit.lang),
    qualityMetrics: {
      formalityScore: candidate.audit.formalityScore,
      lexicalDensity: candidate.audit.lexicalDensity,
      syntacticComplexity: candidate.audit.syntacticComplexity,
      overallScore: candidate.audit.overallScore,
    },
  };
}

function buildCardAlert(audit, lang) {
  if (audit.tooShort) {
    return {
      type: "logic_quality",
      severity: "warning",
      message:
        lang === "ZH"
          ? "内容过于简略，导师暂时无法给出可靠的写作质量判断。"
          : lang === "ES"
          ? "Esta tarjeta es demasiado breve para sostener una revision fiable de calidad de escritura."
          : "This card is too brief to support a reliable writing-quality review.",
      reason:
        lang === "ZH"
          ? "当前文本缺少足够的事实信息，无法稳定评估正式度、词汇密度和句法结构。"
          : lang === "ES"
          ? "El texto todavia no contiene suficiente informacion concreta para evaluar con confianza la formalidad, la densidad lexical o la estructura sintactica."
          : "The text does not yet contain enough concrete information to evaluate formality, lexical density, or syntactic structure with confidence.",
    };
  }

  if (audit.needsRefinement) {
    return {
      type: "logic_quality",
      severity: "warning",
      message:
        lang === "ZH"
          ? "建议：为了确保后续机会分析和商业洞察的生成质量，建议将该描述提升至更具正式性和信息密度的表达方式。"
          : lang === "ES"
          ? "Esta tarjeta carece de suficiente densidad informativa y expresion formal."
          : "This card lacks sufficient information density and formal expression.",
      reason:
        lang === "ZH"
          ? "这段表达仍然偏口语化，主观词较多，事实支撑和分析细节还不够充分。"
          : lang === "ES"
          ? "El texto usa formulaciones amplias o conversacionales y todavia no aporta suficiente detalle analitico para una interpretacion empresarial solida."
          : "The text uses broad or conversational phrasing and does not yet provide enough analytical detail for a strong business interpretation.",
    };
  }

  if (audit.level === "semi-formal") {
    return {
      type: "logic_quality",
      severity: "notice",
      message:
        lang === "ZH"
          ? "表达尚可，但建议加入更多事实支撑。"
          : lang === "ES"
          ? "Esta tarjeta es comprensible, pero su tono empresarial puede reforzarse."
          : "This card is understandable, but its business tone can be strengthened.",
      reason:
        lang === "ZH"
          ? "文本已经包含一定信息，但还可以进一步增强正式表达与分析精度。"
          : lang === "ES"
          ? "El texto contiene hechos utiles, pero la redaccion puede ser mas formal y analiticamente precisa."
          : "The text contains useful facts, but the wording can become more formal and analytically precise.",
    };
  }

  return null;
}

async function buildCardQualityAnalyses(boardContext = []) {
  const notes = flattenNotes(boardContext);
  if (notes.length === 0) {
    return [];
  }

  const analyses = [];

  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    const audit = analyzeFormality(note.text, "", {
      isSystemRefined: note.refinedByAgent,
      isVerified: note.verified,
      isSystemGenerated: note.isSystemGenerated,
    });
    const alert = buildCardAlert(audit, audit.lang);
    const currentContext = buildCurrentContextFromBoard(boardContext, note);
    let optimizedText = "";

    if (audit.needsRefinement && !audit.tooShort) {
      const rewritten = await rewriteFormalTextWithGlobalContext(
        note.text,
        audit.lang,
        {
          ...buildRefinementContext(note),
          currentContext,
        }
      );
      optimizedText = rewritten.rewrittenText;
    }

    analyses.push({
      id: note.noteId || `card_${index + 1}`,
      noteId: note.noteId || null,
      cardIndex: index + 1,
      cardLabel: `Card ${index + 1}`,
      toolId: note.toolId,
      toolName: note.toolName,
      frameTitle: note.frameTitle,
      questionId: note.qId,
      questionDescription: note.questionDescription,
      methodologyGoal: note.methodologyGoal,
      toolSpecificFocus: note.toolSpecificFocus,
      currentContext,
      widgetType: note.widgetType,
      verified: note.verified === true || note.refinedByAgent === true,
      isSystemGenerated: note.isSystemGenerated === true || note.refinedByAgent === true,
      lang: audit.lang,
      originalText: note.text,
      scores: {
        fScore: audit.formalityScore,
        lexicalDensity: audit.lexicalDensity,
        syntacticComplexity: audit.syntacticComplexity,
        overallScore: audit.overallScore,
      },
      alerts: alert ? [alert] : [],
      optimizedText,
      canOptimize: Boolean(note.noteId && optimizedText),
      isTooShort: audit.tooShort,
      level: audit.level,
      shouldIntervene: audit.shouldIntervene,
      nextStepHint: audit.nextStepHint,
    });
  }

  return analyses;
}

function buildQualityAlertFromCardAnalyses(cardAnalyses = []) {
  const candidate =
    cardAnalyses.find((entry) => entry.alerts.length > 0) ||
    cardAnalyses.find((entry) => entry.canOptimize) ||
    null;

  if (!candidate) {
    return null;
  }

  return {
    noteId: candidate.noteId,
    frameTitle: candidate.frameTitle,
    toolName: candidate.toolName,
    questionId: candidate.questionId,
    questionDescription: candidate.questionDescription,
    methodologyGoal: candidate.methodologyGoal,
    toolSpecificFocus: candidate.toolSpecificFocus,
    currentContext: candidate.currentContext,
    verified: candidate.verified === true,
    isSystemGenerated: candidate.isSystemGenerated === true,
    lang: candidate.lang,
    sourceText: candidate.originalText,
    rewrittenText: candidate.optimizedText,
    canApply: candidate.canOptimize,
    needsRefinement: candidate.level === "informal",
    isTooShort: candidate.isTooShort,
    message:
      candidate.alerts[0]?.message ||
      candidate.nextStepHint ||
      getLocalizedRefinementHint(candidate.lang),
    qualityMetrics: {
      formalityScore: candidate.scores.fScore,
      lexicalDensity: candidate.scores.lexicalDensity,
      syntacticComplexity: candidate.scores.syntacticComplexity,
      overallScore: candidate.scores.overallScore,
    },
  };
}

function summarizeBoardContext(boardContext = []) {
  const tools = Array.isArray(boardContext) ? boardContext : [];
  const totalFrames = TOTAL_FRAME_COUNT;
  const filledFrames = tools.reduce(
    (sum, tool) =>
      sum +
      (tool.questions ?? []).filter((question) => (question.notes ?? []).length > 0)
        .length,
    0
  );
  const missingFrames = tools.reduce(
    (sum, tool) =>
      sum +
      (tool.questions ?? []).filter((question) => question.found === false).length,
    0
  );
  const emptyFrames = totalFrames - filledFrames - missingFrames;
  const toolStats = tools.map((tool) => {
    const questions = tool.questions ?? [];
    const filled = questions.filter((question) => (question.notes ?? []).length > 0).length;
    const missing = questions.filter((question) => question.found === false).length;
    const empty = questions.length - filled - missing;
    const status =
      filled === questions.length && questions.length > 0
        ? "complete"
        : filled > 4
        ? "basically-complete"
        : filled > 2
        ? "in-progress"
        : filled > 0
        ? "started"
        : "not-started";

    return {
      toolId: tool.toolId,
      toolName: tool.toolName,
      total: questions.length,
      filled,
      empty,
      missing,
      status,
    };
  });

  return {
    totalFrames,
    filledFrames,
    missingFrames,
    emptyFrames,
    completionScore:
      totalFrames > 0 ? Math.round((filledFrames / totalFrames) * 100) : 0,
    toolStats,
  };
}

function getBoardLanguage(boardContext = []) {
  const notesText = flattenNotes(boardContext)
    .map((note) => note.text)
    .filter(Boolean)
    .join(" ");

  return detectLanguageCode(notesText);
}

async function detectBoardLanguageWithModel(boardContext = []) {
  const notesText = flattenNotes(boardContext)
    .map((note) => note.text)
    .filter(Boolean)
    .join("\n");

  if (!notesText.trim()) {
    return "EN";
  }

  return detectLanguageWithModel(notesText, "EN");
}

function getPreferredSuggestionLanguage(
  boardContext = [],
  focusToolId = null,
  focusQuestionId = "",
  preferredLanguage = ""
) {
  if (preferredLanguage) {
    return detectLanguageCode("", preferredLanguage);
  }

  const currentTool = boardContext.find((entry) => entry.toolId === focusToolId);
  const currentQuestion = (currentTool?.questions ?? []).find(
    (entry) => entry.qId === focusQuestionId
  );
  const currentQuestionText = extractQuestionNotes(currentQuestion).join(" ").trim();
  if (currentQuestionText) {
    return detectLanguageCode(currentQuestionText);
  }

  const currentToolText = (currentTool?.questions ?? [])
    .flatMap((question) => extractQuestionNotes(question))
    .join(" ")
    .trim();
  if (currentToolText) {
    return detectLanguageCode(currentToolText);
  }

  return getBoardLanguage(boardContext);
}

function getCurrentQuestionText(boardContext = [], focusToolId = null, focusQuestionId = "") {
  const currentTool = boardContext.find((entry) => entry.toolId === focusToolId);
  const currentQuestion = (currentTool?.questions ?? []).find(
    (entry) => entry.qId === focusQuestionId
  );
  return extractQuestionNotes(currentQuestion).join(" ").trim();
}

async function detectSuggestionLanguageWithModel(
  boardContext = [],
  focusToolId = null,
  focusQuestionId = ""
) {
  const authoritativeLanguageSource = buildAuthoritativeLanguageSource(
    boardContext,
    focusToolId,
    focusQuestionId
  );
  const currentQuestionText = authoritativeLanguageSource.facts.join("\n").trim();

  if (!currentQuestionText) {
    return "EN";
  }
  return detectLanguageWithModel(currentQuestionText, "EN");
}

function localizeDiagnosisCopy(lang = "EN") {
  if (lang === "ZH") {
    return {
      weakFrameReason:
        "这个环节仍然缺少内容，建议你优先补齐它，让后续路径保持连贯。",
      keyNodeReason: "建议你先完善这个关键节点，再继续后续内容。",
      orderedReason: "建议你继续按当前顺序推进，并优先补齐最早出现的薄弱环节。",
      interventionTool3:
        "建议你：现在可以继续当前内容，不过如果稍微回看 Tool 3，把客户、需求和机会说清楚，后面的方案会更稳。",
      interventionTool5:
        "建议你：在规划验证和财务之前，如果能回访 Tool 5 补充价值主张和收入逻辑，整个商业模式会更闭环。",
      emptyBoard:
        "建议你先在白板上创建 Frame 并填写内容，再进行 Project Review。",
      followOrder: "建议你继续按照 ToolBoard 顺序补齐下一步内容。",
      auditPrefix: "建议你检查逻辑一致性：",
      auditHeading: "逻辑一致性建议",
    };
  }

  if (lang === "ES") {
    return {
      weakFrameReason:
        "Esta etapa sigue vacia; conviene completarla primero para mantener la continuidad del proceso.",
      keyNodeReason:
        "Conviene reforzar primero este nodo clave antes de seguir con el resto del contenido.",
      orderedReason:
        "Conviene seguir el orden actual y reforzar primero el punto debil que aparece antes en el recorrido.",
      interventionTool3:
        "Sugerencia: puedes continuar con el contenido actual, pero si vuelves un momento a Tool 3 y aclaras cliente, necesidad y oportunidad, la solucion posterior quedara mucho mas solida.",
      interventionTool5:
        "Sugerencia: antes de profundizar en validacion y finanzas, conviene volver a Tool 5 para reforzar la propuesta de valor y la logica de ingresos, de modo que el modelo de negocio quede mas cerrado.",
      emptyBoard:
        "Conviene crear primero los Frame en la pizarra y a帽adir contenido antes de ejecutar Project Review.",
      followOrder:
        "Conviene continuar el siguiente paso siguiendo el orden de ToolBoard.",
      auditPrefix: "Sugerencia: revisa la coherencia logica:",
      auditHeading: "Sugerencias de coherencia logica",
    };
  }

  if (lang === "CA") {
    return {
      weakFrameReason:
        "Aquest pas encara no te contingut. Convé completar-lo primer perquè la resta del recorregut mantingui coherencia.",
      keyNodeReason:
        "Convé reforçar primer aquest node clau abans de continuar amb la resta del contingut.",
      orderedReason:
        "Convé continuar seguint l'ordre actual i reforçar primer el punt feble que apareix abans en el recorregut.",
      interventionTool3:
        "Suggeriment: pots continuar amb el contingut actual, pero si tornes un moment a Tool 3 i aclareixes client, necessitat i oportunitat, la solucio posterior quedara molt mes solida.",
      interventionTool5:
        "Suggeriment: abans d'aprofundir en validacio i finances, convé tornar a Tool 5 per reforçar la proposta de valor i la logica d'ingressos, de manera que el model de negoci quedi mes tancat.",
      emptyBoard:
        "Convé crear primer els frames a la pissarra i afegir-hi contingut abans d'executar Project Review.",
      followOrder:
        "Convé continuar el pas següent seguint l'ordre de ToolBoard.",
      auditPrefix: "Suggeriment: revisa la coherencia logica:",
      auditHeading: "Suggeriments de coherencia logica",
    };
  }

  return {
    weakFrameReason:
      "This step is still missing content. It is best to complete it first so the rest of the path stays coherent.",
    keyNodeReason:
      "It is best to strengthen this key node first before continuing with the rest of the content.",
    orderedReason:
      "It is best to continue in the current order and strengthen the earliest weak point first.",
    interventionTool3:
      "Suggestion: you can continue with the current content, but if you briefly revisit Tool 3 and clarify the client, need, and opportunity, the later solution work will be much more solid.",
    interventionTool5:
      "Suggestion: before going deeper into validation and finance, it is best to revisit Tool 5 to strengthen the value proposition and revenue logic so the business model closes the loop.",
    emptyBoard:
      "Please create the relevant Frames on the board and add content before running Project Review.",
    followOrder:
      "It is best to continue with the next step following the ToolBoard order.",
    auditPrefix: "Suggestion: check the logical alignment:",
    auditHeading: "Logical alignment suggestions",
  };
}

function getToolStatsMap(summary) {
  return new Map(summary.toolStats.map((tool) => [tool.toolId, tool]));
}

function getToolCompletionPercent(summary, toolId) {
  const tool = getToolStatsMap(summary).get(toolId);
  if (!tool || tool.total === 0) {
    return 0;
  }

  return Math.round((tool.filled / tool.total) * 100);
}

function hasStartedToolRange(summary, minToolId, maxToolId) {
  return summary.toolStats.some(
    (tool) => tool.toolId >= minToolId && tool.toolId <= maxToolId && tool.filled > 0
  );
}

function firstAvailableFrame(boardContext = []) {
  for (const tool of boardContext) {
    for (const question of tool.questions ?? []) {
      if (question.found !== false) {
        return question.anchorFrameTitle;
      }
    }
  }

  return "TB_TOOL_1_Q1";
}

function findFirstWeakFrame(boardContext = [], lang = "EN") {
  const copy = localizeDiagnosisCopy(lang);
  for (const tool of boardContext) {
    for (const question of tool.questions ?? []) {
      if ((question.notes ?? []).length === 0) {
        return {
          toolId: tool.toolId,
          toolName: tool.toolName,
          frameTitle: question.anchorFrameTitle,
          reason: copy.weakFrameReason,
        };
      }
    }
  }

  return null;
}

function findFirstFrameForTool(boardContext = [], toolId, lang = "EN") {
  const copy = localizeDiagnosisCopy(lang);
  const tool = boardContext.find((entry) => entry.toolId === toolId);
  if (!tool) {
    return null;
  }

  const target =
    (tool.questions ?? []).find((question) => (question.notes ?? []).length === 0) ??
    tool.questions?.[0];

  if (!target) {
    return null;
  }

  return {
    toolId: tool.toolId,
    toolName: tool.toolName,
    frameTitle: target.anchorFrameTitle,
    reason: copy.keyNodeReason,
  };
}

function buildDeterministicDiagnosis(boardContext, summary, lang = "EN") {
  const copy = localizeDiagnosisCopy(lang);
  const tool3Completion = getToolCompletionPercent(summary, 3);
  const tool5Completion = getToolCompletionPercent(summary, 5);
  const startedTool4Plus = hasStartedToolRange(summary, 4, 9);
  const startedTool7To9 = hasStartedToolRange(summary, 7, 9);

  if (startedTool4Plus && tool3Completion < 30) {
    return {
      recommendedFocus:
        findFirstFrameForTool(boardContext, 3, lang) ??
        findFirstWeakFrame(boardContext, lang),
      isIntervention: true,
      coachMessage: copy.interventionTool3,
    };
  }

  if (startedTool7To9 && tool5Completion < 30) {
    return {
      recommendedFocus:
        findFirstFrameForTool(boardContext, 5, lang) ??
        findFirstWeakFrame(boardContext, lang),
      isIntervention: true,
      coachMessage: copy.interventionTool5,
    };
  }

  return {
    recommendedFocus:
      findFirstWeakFrame(boardContext, lang) ?? {
        toolId: summary.toolStats[0]?.toolId ?? null,
        toolName: summary.toolStats[0]?.toolName ?? "",
        frameTitle: firstAvailableFrame(boardContext),
        reason: copy.orderedReason,
      },
    isIntervention: false,
    coachMessage: copy.orderedReason,
  };
}

function collectAuditPairs(boardContext = []) {
  const joinToolNotes = (toolId) => {
    const tool = boardContext.find((entry) => entry.toolId === toolId);
    return (tool?.questions ?? [])
      .flatMap((question) => question.notes ?? [])
      .filter(Boolean)
      .join(" | ");
  };

  return {
    tool1: joinToolNotes(1),
    tool3: joinToolNotes(3),
    tool4: joinToolNotes(4),
    tool5: joinToolNotes(5),
  };
}

async function getRagContext(query, sourceFiles) {
  try {
    const text = await retrieveRelevantContext(query, sourceFiles);
    return { text, ragStatus: "online" };
  } catch (error) {
    logger.warn("RAG context is unavailable.", { error });
    return { text: "", ragStatus: "offline" };
  }
}

async function generateLogicAuditSuggestions(boardContext, summary, ragStatus) {
  const lang = getBoardLanguage(boardContext);
  return generateLogicAuditSuggestionsLocalized(boardContext, summary, ragStatus, lang);
}
async function generateLogicAuditSuggestionsLocalized(
  boardContext,
  summary,
  ragStatus,
  lang = "EN"
) {
  const auditPairs = collectAuditPairs(boardContext);
  const copy = localizeDiagnosisCopy(lang);
  const fallbackSuggestions = [];

  if (auditPairs.tool1 && auditPairs.tool4) {
    fallbackSuggestions.push(
      `${copy.auditPrefix} ${
        lang === "ZH"
          ? `你在 Tool 1 提到的“${auditPairs.tool1.slice(0, 60)}”与 Tool 4 的“${auditPairs.tool4.slice(0, 60)}”似乎可以更紧密地对齐。`
          : lang === "ES"
          ? `lo que escribiste en Tool 1, "${auditPairs.tool1.slice(0, 60)}", y lo que aparece en Tool 4, "${auditPairs.tool4.slice(0, 60)}", podria alinearse con mayor claridad.`
          : `what you wrote in Tool 1, "${auditPairs.tool1.slice(0, 60)}", and what appears in Tool 4, "${auditPairs.tool4.slice(0, 60)}", could align more tightly.`
      }`
    );
  }

  if (auditPairs.tool3 && auditPairs.tool5) {
    fallbackSuggestions.push(
      `${copy.auditPrefix} ${
        lang === "ZH"
          ? `你在 Tool 3 提到的“${auditPairs.tool3.slice(0, 60)}”与 Tool 5 的“${auditPairs.tool5.slice(0, 60)}”似乎可以更紧密地对齐。`
          : lang === "ES"
          ? `lo que escribiste en Tool 3, "${auditPairs.tool3.slice(0, 60)}", y lo que aparece en Tool 5, "${auditPairs.tool5.slice(0, 60)}", podria alinearse con mayor claridad.`
          : `what you wrote in Tool 3, "${auditPairs.tool3.slice(0, 60)}", and what appears in Tool 5, "${auditPairs.tool5.slice(0, 60)}", could align more tightly.`
      }`
    );
  }

  if (auditPairs.tool5 && auditPairs.tool4) {
    fallbackSuggestions.push(
      `${copy.auditPrefix} ${
        lang === "ZH"
          ? `你在 Tool 5 提到的“${auditPairs.tool5.slice(0, 60)}”与 Tool 4 的“${auditPairs.tool4.slice(0, 60)}”似乎可以更紧密地对齐。`
          : lang === "ES"
          ? `lo que escribiste en Tool 5, "${auditPairs.tool5.slice(0, 60)}", y lo que aparece en Tool 4, "${auditPairs.tool4.slice(0, 60)}", podria alinearse con mayor claridad.`
          : `what you wrote in Tool 5, "${auditPairs.tool5.slice(0, 60)}", and what appears in Tool 4, "${auditPairs.tool4.slice(0, 60)}", could align more tightly.`
      }`
    );
  }

  const backgroundRag = await getRagContext(
    "Toolboard semantic alignment audit entrepreneurship",
    BACKGROUND_FILES
  );
  const effectiveRagStatus =
    backgroundRag.ragStatus === "offline" ? "offline" : ragStatus;
  const languageLabel =
    lang === "ZH" ? "Chinese" : lang === "ES" ? "Spanish" : "English";

  const systemPrompt = `You are running a ToolBoard semantic alignment audit.
Check these relationships:
1. Tool 1 vs Tool 4: does the solution respond to the defined pain point?
2. Tool 3 vs Tool 5: does the value proposition match the identified market opportunity?
3. Tool 5 vs Tool 4: does the revenue logic match the product features or cost structure?

Output rules:
- Return JSON only.
- Use the exact format: {"logicAuditSuggestions": string[]}
- If there is no meaningful drift, return an empty array.
- Each suggestion must begin with "${copy.auditPrefix}"
- Do not use words equivalent to "error" or "warning".
- Cite concrete fragments you can actually see.
- Respond entirely in ${languageLabel}.`;

  const userPrompt = `Board summary:
- score: ${summary.completionScore}

Tool 1 notes:
${auditPairs.tool1 || "(empty)"}

Tool 3 notes:
${auditPairs.tool3 || "(empty)"}

Tool 4 notes:
${auditPairs.tool4 || "(empty)"}

Tool 5 notes:
${auditPairs.tool5 || "(empty)"}

${
  backgroundRag.text
    ? `Optional methodology context:\n${backgroundRag.text}\n`
    : ""
}

Return logicAuditSuggestions in ${languageLabel}.`;

  try {
    const completion = await createChatCompletionWithRetry({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 800,
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = parseJsonResponse(raw, null);
    const suggestions = Array.isArray(parsed?.logicAuditSuggestions)
      ? parsed.logicAuditSuggestions
      : [];

    return {
      logicAuditSuggestions:
        suggestions.length > 0
          ? suggestions.slice(0, 3)
          : fallbackSuggestions.slice(0, 3),
      ragStatus: effectiveRagStatus,
    };
  } catch (error) {
    logger.warn("Logic audit generation failed. Falling back to deterministic suggestions.", {
      error,
    });
    return {
      logicAuditSuggestions: fallbackSuggestions.slice(0, 3),
      ragStatus: "offline",
    };
  }
}


async function buildSuggestionPrompt(boardContext, focusToolId, focusQuestion) {
  const promptSections = [];
  let ragStatus = "online";

  for (const tool of boardContext) {
    const notesText = (tool.questions ?? [])
      .map((question) => {
        const questionNotes =
          question.notes && question.notes.length > 0
            ? question.notes.map((note) => `    - ${note}`).join("\n")
            : "    (empty)";

        return `  [${question.anchorFrameTitle}] ${question.label}\n${questionNotes}`;
      })
      .join("\n\n");

    let section = `=== ${tool.toolName} ===\n`;
    const sourceFiles = TOOL_KNOWLEDGE_FILES[tool.toolId] ?? [];

    if (sourceFiles.length > 0) {
      const ragResult = await getRagContext(
        `${tool.toolName} ${focusQuestion?.label ?? ""}`,
        sourceFiles
      );

      if (ragResult.ragStatus === "offline") {
        ragStatus = "offline";
      } else if (ragResult.text) {
        section += `\n[Knowledge Base for ${tool.toolName}]\n${ragResult.text}\n`;
      }
    }

    section += `\n[User Board Content for ${tool.toolName}]\n${notesText}`;

    if (tool.toolId === focusToolId) {
      section += `\n\nThis is the current focus tool.`;
    }

    promptSections.push(section);
  }

  const backgroundRag = await getRagContext(
    focusQuestion?.label ?? "Toolboard methodology entrepreneurship",
    BACKGROUND_FILES
  );

  if (backgroundRag.ragStatus === "offline") {
    ragStatus = "offline";
  } else if (backgroundRag.text) {
    promptSections.push(`=== Background Knowledge ===\n${backgroundRag.text}`);
  }

  return {
    prompt: promptSections.join("\n\n---\n\n"),
    ragStatus,
  };
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Toolboard GPT Server running" });
});

app.post("/api/thread/sync", async (req, res) => {
  try {
    const rateLimit = checkRateLimit(req);
    if (!rateLimit.allowed) {
      res.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return res.status(429).json({
        error: `Rate limit exceeded. Please retry in ${rateLimit.retryAfterSeconds} second(s).`,
      });
    }

    const boardId = String(req.body?.boardId || DEFAULT_BOARD_ID);
    const boardContext = Array.isArray(req.body?.boardContext) ? req.body.boardContext : [];
    const toolId = Number.isFinite(Number(req.body?.toolId)) ? Number(req.body.toolId) : null;
    const toolName = String(req.body?.toolName || "");
    const toolDescription = String(req.body?.toolDescription || "");
    const focusQuestion =
      req.body?.focusQuestion && typeof req.body.focusQuestion === "object"
        ? req.body.focusQuestion
        : null;
    const preferredLanguage = String(req.body?.preferredLanguage || "");
    const eventType = String(req.body?.eventType || "preview");

    const { assistantId, threadId, factsPayload } = await syncThreadMemory({
      boardId,
      boardContext,
      toolId,
      toolName,
      toolDescription,
      focusQuestion,
      preferredLanguage,
      eventType,
    });

    logger.info("Thread memory synchronized.", {
      sections: [
        { label: "Thread ID", value: threadId },
        { label: "Board ID", value: boardId },
        { label: "Event", value: eventType },
        {
          label: "New Facts",
      value: shouldLog("debug") ? factsPayload : summarizeFactsPayload(factsPayload),
          format: "json",
        },
      ],
    });

    res.json({
      ok: true,
      assistantId,
      threadId,
      ragStatus: "online",
    });
  } catch (error) {
    logger.error("Thread sync request failed.", { error });
    res.status(500).json({
      error: error.message,
      ragStatus: "offline",
    });
  }
});

app.post("/api/suggest", async (req, res) => {
  try {
    const rateLimit = checkRateLimit(req);
    if (!rateLimit.allowed) {
      res.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return res.status(429).json({
        error: `Rate limit exceeded. Please retry in ${rateLimit.retryAfterSeconds} second(s).`,
        suggestions: [],
        ragStatus: "online",
      });
    }

    const {
      boardId,
      toolId,
      toolName,
      toolDescription,
      focusQuestion,
      preferredLanguage,
      boardContext,
    } =
      req.body;

    const allTools = Array.isArray(boardContext)
      ? boardContext
      : boardContext?.questions
      ? [{ toolId, toolName, questions: boardContext.questions }]
      : [];
    const dominantLanguage = await detectSuggestionLanguageWithModel(
      allTools,
      toolId,
      focusQuestion?.qId || ""
    );
    const factsPayload = buildIncrementalFactsPayload({
      boardContext: allTools,
      toolId,
      toolName,
      toolDescription,
      focusQuestion: focusQuestion || {},
      preferredLanguage: String(preferredLanguage || ""),
      dominantLanguageOverride: dominantLanguage || "EN",
    });
    logger.info("Suggestion request is using direct language-locked generation.", {
      sections: [
        { label: "Current Tool", value: `${toolName} (#${toolId})` },
        { label: "Target Question", value: focusQuestion?.label || "(empty)" },
        {
          label: "Authoritative User-Language Source",
          value:
            factsPayload.latestStickyFacts.length > 0
              ? factsPayload.latestStickyFacts
              : "(empty -> English default)",
          format: Array.isArray(factsPayload.latestStickyFacts) ? "json" : undefined,
        },
        {
          label: "New Facts",
          value: shouldLog("debug") ? factsPayload : summarizeFactsPayload(factsPayload),
          format: "json",
        },
      ],
    });

    const { rawReply, parsed, targetLanguage } = await generateDirectSuggestions({
      factsPayload,
      toolName,
      toolDescription,
    });

    logger.info("GPT returned targeted suggestions with explicit user-language locking.", {
      sections: [
        {
          label: "Reply Language",
          value: `${getLanguageLabel(targetLanguage)} (${targetLanguage})`,
        },
        {
          label: "Assistant Suggestions",
          value: parsed?.suggestions
            ? formatSuggestionsList(parsed.suggestions)
            : rawReply,
        },
        ...(shouldLog("debug")
          ? [{ label: "Raw Assistant Reply", value: rawReply }]
          : []),
      ],
    });

    if (!parsed) {
      logger.error("Failed to parse assistant suggestion response.", {
        sections: [{ label: "Raw Assistant Reply", value: rawReply }],
      });
      return res.json({
        suggestions: [{ id: "s1", title: "Response", content: rawReply }],
        ragStatus: "online",
        threadId: null,
      });
    }

    res.json({
      ...parsed,
      ragStatus: "online",
      threadId: null,
    });
  } catch (error) {
    logger.error("Suggestion request failed.", { error });
    res.status(500).json({
      error: error.message,
      suggestions: [],
      ragStatus: "offline",
    });
  }
});

app.post("/api/refine", async (req, res) => {
  try {
    const rateLimit = checkRateLimit(req);
    if (!rateLimit.allowed) {
      res.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return res.status(429).json({
        error: `Rate limit exceeded. Please retry in ${rateLimit.retryAfterSeconds} second(s).`,
      });
    }

    const text = String(req.body?.text || "");
    const requestedLang = String(req.body?.lang || "");
    const context = req.body?.context && typeof req.body.context === "object" ? req.body.context : {};
    const boardContext = Array.isArray(req.body?.boardContext) ? req.body.boardContext : [];
    const resolvedLang = await detectLanguageWithModel(text, requestedLang || "EN");
    const audit = analyzeFormality(text, resolvedLang);
    const fallbackCurrentContext =
      boardContext.length > 0 ? buildCurrentContextFromBoard(boardContext, context) : null;
    const effectiveCurrentContext =
      context.currentContext && typeof context.currentContext === "object"
        ? context.currentContext
        : fallbackCurrentContext || {
            toolContext: [],
            projectContext: [],
            targetQuestion: {
              questionId: context.questionId || context.frameTitle || "",
              questionText: context.questionDescription || "",
              toolName: context.toolTitle || context.toolName || "",
            },
          };

    if (audit.tooShort) {
      return res.json({
        lang: audit.lang,
        rewrittenText: "",
        context: {
          ...buildRefinementContext(context),
          currentContext: effectiveCurrentContext,
        },
        message: audit.message,
        needsRefinement: false,
        tooShort: true,
        metrics: {
          formalityScore: audit.formalityScore,
          lexicalDensity: audit.lexicalDensity,
          syntacticComplexity: audit.syntacticComplexity,
          overallScore: audit.overallScore,
        },
      });
    }

      const rewritten = await rewriteFormalTextWithGlobalContext(
        text,
        resolvedLang,
        {
          ...context,
          currentContext: effectiveCurrentContext,
        }
      );
      rememberGeneratedText(rewritten.rewrittenText);
      const rewrittenAudit = analyzeFormality(rewritten.rewrittenText, resolvedLang, {
        isSystemRefined: true,
        isVerified: true,
        isSystemGenerated: true,
      });

      res.json({
        lang: resolvedLang,
        rewrittenText: rewritten.rewrittenText,
      context: {
        ...buildRefinementContext(context),
        currentContext: effectiveCurrentContext,
      },
        message: getLocalizedRefinementHint(resolvedLang),
      needsRefinement: audit.needsRefinement,
      tooShort: false,
      metrics: {
        before: {
          formalityScore: audit.formalityScore,
          lexicalDensity: audit.lexicalDensity,
          syntacticComplexity: audit.syntacticComplexity,
          overallScore: audit.overallScore,
        },
        after: {
          formalityScore: rewrittenAudit.formalityScore,
          lexicalDensity: rewrittenAudit.lexicalDensity,
          syntacticComplexity: rewrittenAudit.syntacticComplexity,
          overallScore: rewrittenAudit.overallScore,
        },
      },
    });
  } catch (error) {
    logger.error("Refinement request failed.", { error });
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/diagnose", async (req, res) => {
  try {
    const rateLimit = checkRateLimit(req);
    if (!rateLimit.allowed) {
      res.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return res.status(429).json({
        ...EMPTY_DIAGNOSIS,
        coachMessage: `Rate limit exceeded. Please retry in ${rateLimit.retryAfterSeconds} second(s).`,
        ragStatus: "online",
      });
    }

    const boardContext = Array.isArray(req.body?.boardContext)
      ? req.body.boardContext
      : [];
    const lang = await detectBoardLanguageWithModel(boardContext);
    const copy = localizeDiagnosisCopy(lang);
    const summary = summarizeBoardContext(boardContext);
    const defaultFocus =
      findFirstWeakFrame(boardContext, lang) ?? {
        toolId: summary.toolStats[0]?.toolId ?? null,
        toolName: summary.toolStats[0]?.toolName ?? "",
        frameTitle: firstAvailableFrame(boardContext),
        reason: copy.followOrder,
      };

    if (summary.filledFrames === 0) {
      return res.json({
        ...EMPTY_DIAGNOSIS,
        score: summary.completionScore,
        progress: {
          filledFrames: summary.filledFrames,
          totalFrames: summary.totalFrames,
          toolStats: summary.toolStats,
        },
        recommendedFocus: defaultFocus,
        coachMessage: copy.emptyBoard,
        lang,
        ragStatus: "online",
      });
    }

    const deterministicDiagnosis = buildDeterministicDiagnosis(boardContext, summary, lang);
    const auditResult = await generateLogicAuditSuggestionsLocalized(
      boardContext,
      summary,
      "online",
      lang
    );
    const cardAnalyses = await buildCardQualityAnalyses(boardContext);
    const qualityAlert =
      buildQualityAlertFromCardAnalyses(cardAnalyses) ||
      (await buildQualityAlert(boardContext));
    const ragStatus = auditResult.ragStatus;

    logger.info("Diagnosis completed with board facts prioritized over RAG context.", {
      sections: [
        {
          label: "Summary",
          value: {
            totalFrames: summary.totalFrames,
            filledFrames: summary.filledFrames,
            completionScore: summary.completionScore,
            recommendedFocus: deterministicDiagnosis.recommendedFocus.frameTitle,
            isIntervention: deterministicDiagnosis.isIntervention,
            ragStatus,
          },
          format: "json",
        },
      ],
    });

    res.json({
      score: summary.completionScore,
      progress: {
        filledFrames: summary.filledFrames,
        totalFrames: summary.totalFrames,
        toolStats: summary.toolStats.map((tool) => ({
          ...tool,
          completionPercent:
            tool.total > 0 ? Math.round((tool.filled / tool.total) * 100) : 0,
        })),
      },
      logicAuditSuggestions: auditResult.logicAuditSuggestions,
      recommendedFocus: deterministicDiagnosis.recommendedFocus,
      coachMessage: deterministicDiagnosis.coachMessage,
      isIntervention: deterministicDiagnosis.isIntervention,
      qualityAlert,
      cardAnalyses,
      lang,
      ragStatus,
    });
  } catch (error) {
    logger.error("Diagnosis request failed.", { error });
    res.status(500).json({
      ...EMPTY_DIAGNOSIS,
      coachMessage: error.message,
      ragStatus: "offline",
    });
  }
});

app.listen(PORT, () => {
  logger.info("Toolboard GPT server is running.", {
    sections: [{ label: "URL", value: `http://localhost:${PORT}` }],
  });
});
