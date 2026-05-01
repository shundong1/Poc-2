import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { retrieveRelevantContext } from "./rag/retriever.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8787;
const OPENAI_MAX_RETRIES = Number(process.env.OPENAI_MAX_RETRIES || 3);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 10);
const TOTAL_FRAME_COUNT = 41;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const rateLimitBuckets = new Map();

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
const ZH_INTERJECTIONS = ["啊", "呀", "哦", "嗯", "唉", "哎"];
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
  "又",
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      return await openai.chat.completions.create(payload);
    } catch (error) {
      if (!isRetryableOpenAIError(error) || attempt >= OPENAI_MAX_RETRIES) {
        throw error;
      }

      const retryDelayMs =
        getRetryAfterMs(error) ?? Math.min(1000 * 2 ** attempt, 8000);

      console.warn(
        `OpenAI request failed with status ${error?.status}. Retrying in ${retryDelayMs}ms (attempt ${attempt + 1}/${OPENAI_MAX_RETRIES}).`
      );

      await sleep(retryDelayMs);
      attempt += 1;
    }
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
    if (["ZH", "EN", "ES"].includes(normalized)) {
      return normalized;
    }
  }

  if (/[\u4E00-\u9FFF]/.test(text)) {
    return "ZH";
  }

  if (/[áéíóúüñ¿¡]/i.test(text)) {
    return "ES";
  }

  const lower = text.toLowerCase();
  const spanishHints = [
    " el ",
    " la ",
    " de ",
    " para ",
    " con ",
    " mercado ",
    " cliente ",
    " propuesta ",
  ];
  if (spanishHints.some((hint) => lower.includes(hint))) {
    return "ES";
  }

  return "EN";
}

function splitSentences(text = "", lang = "EN") {
  const pattern = lang === "ZH" ? /[。！？；\n]+/ : /[.!?;\n]+/;
  return text
    .split(pattern)
    .map((part) => part.trim())
    .filter(Boolean);
}

function tokenizeWestern(text = "") {
  return (text.toLowerCase().match(/[a-záéíóúüñ']+/gi) || []).map((token) =>
    token.toLowerCase()
  );
}

function tokenizeChinese(text = "") {
  const matches = text.match(/[\u4E00-\u9FFF]+|[a-z0-9]+/gi) || [];
  const tokens = [];

  for (const match of matches) {
    if (/^[a-z0-9]+$/i.test(match)) {
      tokens.push(match.toLowerCase());
      continue;
    }

    let index = 0;
    while (index < match.length) {
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
  if (token.endsWith("ly")) return "adv";
  if (EN_AUXILIARIES.has(token)) return "verb";
  if (/(ing|ed|en|ize|ise)$/.test(token)) return "verb";
  if (/(ous|ful|ive|less|able|ible|al|ic)$/.test(token)) return "adj";
  if (/(tion|ment|ness|ity|ship|ence|ance|er|or)$/.test(token)) return "noun";
  return "noun";
}

function tagSpanishToken(token) {
  if (ES_INTERJECTIONS.has(token)) return "interj";
  if (ES_ARTICLES.has(token)) return "art";
  if (ES_PREPOSITIONS.has(token)) return "prep";
  if (ES_PRONOUNS.has(token)) return "pron";
  if (token.endsWith("mente")) return "adv";
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
  return "noun";
}

function tagChineseToken(token) {
  if (ZH_INTERJECTIONS.some((entry) => token.includes(entry))) return "interj";
  if (ZH_PRONOUNS.some((entry) => token === entry)) return "pron";
  if (ZH_PREPOSITIONS.some((entry) => token.includes(entry))) return "prep";
  if (ZH_ADVERBS.some((entry) => token.includes(entry))) return "adv";
  if (ZH_ADJECTIVES.some((entry) => token.includes(entry))) return "adj";
  if (ZH_VERBS.some((entry) => token.includes(entry))) return "verb";
  return "noun";
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

export function analyzeFormality(text, lang = "") {
  const normalizedText = (text || "").trim();
  const detectedLang = detectLanguageCode(normalizedText, lang);
  const taggedTokens = tokenizeAndTag(normalizedText, detectedLang);
  const sentences = splitSentences(normalizedText, detectedLang);
  const totalTokens = taggedTokens.length;
  const cjkCharCount = (normalizedText.match(/[\u4E00-\u9FFF]/g) || []).length;
  const effectiveTokenCount =
    detectedLang === "ZH"
      ? Math.max(totalTokens, Math.ceil(cjkCharCount / 2))
      : totalTokens;
  const tooShort =
    detectedLang === "ZH"
      ? cjkCharCount < 8 && effectiveTokenCount <= 3
      : totalTokens <= 3;

  console.log("analyzeFormality.input", {
    detectedLang,
    rawText: normalizedText,
    totalTokens,
    effectiveTokenCount,
    cjkCharCount,
    sentenceCount: sentences.length,
  });

  if (tooShort) {
    console.log("analyzeFormality.tooShort", {
      detectedLang,
      rawText: normalizedText,
      totalTokens,
      effectiveTokenCount,
      cjkCharCount,
    });
    return {
      lang: detectedLang,
      tooShort: true,
      message: getLocalizedShortMessage(detectedLang),
      formalityScore: 0,
      lexicalDensity: 0,
      syntacticComplexity: 0,
      avgSentenceLength: totalTokens,
      level: "too-short",
      needsRefinement: false,
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
  };

  for (const token of taggedTokens) {
    weightedCounts[token.pos] += token.weight;
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

  // Chinese lacks articles and often compresses compound nouns. This offsets that bias.
  if (detectedLang === "ZH") {
    nounPercent += 6;
  }

  const rawFScore =
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
  const formalityScore = Math.max(0, Math.min(100, Math.round(rawFScore)));

  const lexicalDensity = Math.round(
    ((weightedCounts.noun +
      weightedCounts.adj +
      weightedCounts.verb +
      weightedCounts.adv) /
      denominator) *
      100
  );

  const avgSentenceLength = Number(
    (effectiveTokenCount / Math.max(1, sentences.length)).toFixed(1)
  );
  const syntacticComplexity = Math.max(
    0,
    Math.min(100, Math.round(avgSentenceLength * 6))
  );

  let level = "informal";
  if (formalityScore >= 70) {
    level = "formal";
  } else if (formalityScore >= 40) {
    level = "semi-formal";
  }

  console.log("analyzeFormality.metrics", {
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
    avgSentenceLength,
    level,
  });

  return {
    lang: detectedLang,
    tooShort: false,
    message:
      level === "formal"
        ? ""
        : getLocalizedRefinementHint(detectedLang),
    formalityScore,
    lexicalDensity,
    syntacticComplexity,
    avgSentenceLength,
    level,
    needsRefinement: level === "informal",
    nextStepHint:
      level === "semi-formal" ? getLocalizedRefinementHint(detectedLang) : "",
    counts: weightedCounts,
    tokens: taggedTokens,
  };
}

async function rewriteFormalText(text, lang = "") {
  const detectedLang = detectLanguageCode(text, lang);
  const promptLanguage =
    detectedLang === "ZH" ? "中文" : detectedLang === "ES" ? "西班牙语" : "English";

  const completion = await createChatCompletionWithRetry({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "你是一名资深商业顾问。请将以下 [Lang] 文本重写为具备高 F-score、高词汇密度和严密句法结构的正式商业表述。保留核心事实，去除口语虚词（如：觉得、好像、creo que, I think, 呢/吧）。只返回改写后的文本。",
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
          frameTitle: question.anchorFrameTitle,
          noteId: note.id ?? null,
          text: note.text.trim(),
          widgetType: note.widgetType ?? "sticky_note",
        });
      }
    }
  }

  return notes;
}

async function buildQualityAlert(boardContext = []) {
  const notes = flattenNotes(boardContext);
  if (notes.length === 0) {
    return null;
  }

  const scoredNotes = notes
    .map((note) => ({
      ...note,
      audit: analyzeFormality(note.text),
    }))
    .sort((left, right) => left.audit.formalityScore - right.audit.formalityScore);

  const substantiveNotes = scoredNotes.filter((entry) => !entry.audit.tooShort);
  const shortNotes = scoredNotes.filter((entry) => entry.audit.tooShort);
  const candidate =
    substantiveNotes.find((entry) => entry.audit.needsRefinement) ||
    substantiveNotes.find((entry) => entry.audit.level === "semi-formal") ||
    (substantiveNotes.length === 0 ? shortNotes[0] : null);

  console.log("buildQualityAlert.selection", {
    totalNotes: notes.length,
    substantiveNotes: substantiveNotes.length,
    shortNotes: shortNotes.length,
    selectedText: candidate?.text || null,
    selectedLevel: candidate?.audit?.level || null,
    selectedTooShort: candidate?.audit?.tooShort || false,
  });

  if (!candidate) {
    return null;
  }

  if (candidate.audit.tooShort) {
    return {
      noteId: candidate.noteId,
      frameTitle: candidate.frameTitle,
      toolName: candidate.toolName,
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
      },
    };
  }

  if (!candidate.audit.needsRefinement) {
    return {
      noteId: candidate.noteId,
      frameTitle: candidate.frameTitle,
      toolName: candidate.toolName,
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
      },
    };
  }

  const rewritten = await rewriteFormalText(candidate.text, candidate.audit.lang);
  return {
    noteId: candidate.noteId,
    frameTitle: candidate.frameTitle,
    toolName: candidate.toolName,
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
          ? "This card is too brief to support a reliable writing-quality review."
          : lang === "ES"
          ? "Esta tarjeta es demasiado breve para sostener una revision fiable de calidad de escritura."
          : "This card is too brief to support a reliable writing-quality review.",
      reason:
        lang === "ZH"
          ? "The text does not yet contain enough concrete information to evaluate formality, lexical density, or syntactic structure with confidence."
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
          ? "This card lacks sufficient information density and formal expression."
          : lang === "ES"
          ? "Esta tarjeta carece de suficiente densidad informativa y expresion formal."
          : "This card lacks sufficient information density and formal expression.",
      reason:
        lang === "ZH"
          ? "The text uses broad or conversational phrasing and does not yet provide enough analytical detail for a strong business interpretation."
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
          ? "This card is understandable, but its business tone can be strengthened."
          : lang === "ES"
          ? "Esta tarjeta es comprensible, pero su tono empresarial puede reforzarse."
          : "This card is understandable, but its business tone can be strengthened.",
      reason:
        lang === "ZH"
          ? "The text contains useful facts, but the wording can become more formal and analytically precise."
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
    const audit = analyzeFormality(note.text);
    const alert = buildCardAlert(audit, audit.lang);
    let optimizedText = "";

    if (alert && !audit.tooShort) {
      const rewritten = await rewriteFormalText(note.text, audit.lang);
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
      widgetType: note.widgetType,
      lang: audit.lang,
      originalText: note.text,
      scores: {
        fScore: audit.formalityScore,
        lexicalDensity: audit.lexicalDensity,
        syntacticComplexity: audit.syntacticComplexity,
      },
      alerts: alert ? [alert] : [],
      optimizedText,
      canOptimize: Boolean(note.noteId && optimizedText),
      isTooShort: audit.tooShort,
      level: audit.level,
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

function findFirstWeakFrame(boardContext = []) {
  for (const tool of boardContext) {
    for (const question of tool.questions ?? []) {
      if ((question.notes ?? []).length === 0) {
        return {
          toolId: tool.toolId,
          toolName: tool.toolName,
          frameTitle: question.anchorFrameTitle,
          reason:
            "这个环节仍然缺少内容，建议你优先补齐它，让后续路径保持连贯。",
        };
      }
    }
  }

  return null;
}

function findFirstFrameForTool(boardContext = [], toolId) {
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
    reason: "建议你先完善这个关键节点，再继续后续内容。",
  };
}

function buildDeterministicDiagnosis(boardContext, summary) {
  const tool3Completion = getToolCompletionPercent(summary, 3);
  const tool5Completion = getToolCompletionPercent(summary, 5);
  const startedTool4Plus = hasStartedToolRange(summary, 4, 9);
  const startedTool7To9 = hasStartedToolRange(summary, 7, 9);

  if (startedTool4Plus && tool3Completion < 30) {
    return {
      recommendedFocus:
        findFirstFrameForTool(boardContext, 3) ?? findFirstWeakFrame(boardContext),
      isIntervention: true,
      coachMessage:
        "建议你：现在可以继续当前内容，不过如果稍微回看 Tool 3，把客户、需求和机会说清楚，后面的方案会更稳。",
    };
  }

  if (startedTool7To9 && tool5Completion < 30) {
    return {
      recommendedFocus:
        findFirstFrameForTool(boardContext, 5) ?? findFirstWeakFrame(boardContext),
      isIntervention: true,
      coachMessage:
        "建议你：在规划验证和财务之前，如果能回访 Tool 5 补充价值主张和收入逻辑，整个商业模式会更闭环。",
    };
  }

  return {
    recommendedFocus:
      findFirstWeakFrame(boardContext) ?? {
        toolId: summary.toolStats[0]?.toolId ?? null,
        toolName: summary.toolStats[0]?.toolName ?? "",
        frameTitle: firstAvailableFrame(boardContext),
        reason: "建议你继续按当前顺序推进，并优先补齐最早出现的薄弱环节。",
      },
    isIntervention: false,
    coachMessage: "建议你继续按当前顺序推进，并优先补齐最早出现的薄弱环节。",
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
    console.warn("RAG unavailable:", error.message);
    return { text: "", ragStatus: "offline" };
  }
}

async function generateLogicAuditSuggestions(boardContext, summary, ragStatus) {
  const auditPairs = collectAuditPairs(boardContext);
  const fallbackSuggestions = [];

  if (auditPairs.tool1 && auditPairs.tool4) {
    fallbackSuggestions.push(
      `建议你检查逻辑一致性：你在 Tool 1 提到的“${auditPairs.tool1.slice(
        0,
        60
      )}”与 Tool 4 的“${auditPairs.tool4.slice(0, 60)}”似乎可以更紧密地对齐。`
    );
  }

  if (auditPairs.tool3 && auditPairs.tool5) {
    fallbackSuggestions.push(
      `建议你检查逻辑一致性：你在 Tool 3 提到的“${auditPairs.tool3.slice(
        0,
        60
      )}”与 Tool 5 的“${auditPairs.tool5.slice(0, 60)}”似乎可以更紧密地对齐。`
    );
  }

  if (auditPairs.tool5 && auditPairs.tool4) {
    fallbackSuggestions.push(
      `建议你检查逻辑一致性：你在 Tool 5 提到的“${auditPairs.tool5.slice(
        0,
        60
      )}”与 Tool 4 的“${auditPairs.tool4.slice(0, 60)}”似乎可以更紧密地对齐。`
    );
  }

  const backgroundRag = await getRagContext(
    "Toolboard semantic alignment audit entrepreneurship",
    BACKGROUND_FILES
  );
  const effectiveRagStatus =
    backgroundRag.ragStatus === "offline" ? "offline" : ragStatus;

  const systemPrompt = `你需要做 ToolBoard 语义对齐审计。

检查三组关系：
1. T1 与 T4：解决方案是否回应了定义的痛点。
2. T3 与 T5：价值主张是否匹配识别出的市场机会。
3. T5 与 T4：收费逻辑是否与产品功能或成本结构匹配。

输出要求：
- 只返回 JSON
- 格式必须是 { "logicAuditSuggestions": string[] }
- 如果没有明显漂移，返回空数组
- 必须使用“建议你检查逻辑一致性：”开头
- 严禁使用“错误”“警告”
- 必须引用你看到的具体内容片段`;

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

请只输出 logicAuditSuggestions。`;

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
    console.warn("Logic audit generation failed:", error.message);
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

    const { toolId, toolName, toolDescription, focusQuestion, boardContext } =
      req.body;

    const allTools = Array.isArray(boardContext)
      ? boardContext
      : boardContext?.questions
      ? [{ toolId, toolName, questions: boardContext.questions }]
      : [];

    const allNotes = allTools
      .flatMap((tool) =>
        (tool.questions ?? []).flatMap((question) => question.notes ?? [])
      )
      .filter(Boolean)
      .join(" ");

    const detectedLanguage = detectLanguageCode(allNotes);
    const responseLanguage =
      detectedLanguage === "ZH"
        ? "Chinese"
        : detectedLanguage === "ES"
        ? "Spanish"
        : "English";
    const { prompt: fullContext, ragStatus } = await buildSuggestionPrompt(
      allTools,
      toolId,
      focusQuestion
    );

    console.log("Suggest route prioritizing board facts before RAG context.", {
      toolId,
      filledFrames: summarizeBoardContext(allTools).filledFrames,
      ragStatus,
    });

    const systemPrompt = `You are an expert Toolboard GPT assistant specializing in entrepreneurship, innovation, and design thinking.

You will receive:
1. Methodology knowledge paired with the user's sticky-note content for each Toolboard tool.
2. A focus question that the user needs help with.

Your job is to:
- Understand the user's progress across all tools.
- Use both the knowledge base and the user's answers to generate suggestions.
- Return 3 specific, actionable suggestions for the focus question.

Language rule:
- Detect the user's dominant language from the sticky notes.
- Respond entirely in that same language.

Return only valid JSON in this exact structure:
{
  "suggestions": [
    { "id": "s1", "title": "...", "content": "..." },
    { "id": "s2", "title": "...", "content": "..." },
    { "id": "s3", "title": "...", "content": "..." }
  ]
}`;

    const userPrompt = `Here is the complete Toolboard context:

${fullContext}

Focus question:
- tool: ${toolName ?? ""}
- question: ${focusQuestion?.label ?? ""}
- frame: ${focusQuestion?.anchorFrameTitle ?? ""}
${toolDescription ? `- toolDescription: ${toolDescription}` : ""}

Respond entirely in ${responseLanguage}.
Generate 3 concrete suggestions grounded in Toolboard methodology and in the user's existing board content.`;

    const completion = await createChatCompletionWithRetry({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 1500,
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = parseJsonResponse(raw, null);

    if (!parsed) {
      console.error("Failed to parse suggest response:", raw);
      return res.json({
        suggestions: [{ id: "s1", title: "Response", content: raw }],
        ragStatus,
      });
    }

    res.json({
      ...parsed,
      ragStatus,
    });
  } catch (error) {
    console.error("Error in /api/suggest:", error);
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
    const lang = String(req.body?.lang || "");
    const audit = analyzeFormality(text, lang);

    if (audit.tooShort) {
      return res.json({
        lang: audit.lang,
        rewrittenText: "",
        message: audit.message,
        needsRefinement: false,
        tooShort: true,
        metrics: {
          formalityScore: audit.formalityScore,
          lexicalDensity: audit.lexicalDensity,
          syntacticComplexity: audit.syntacticComplexity,
        },
      });
    }

    const rewritten = await rewriteFormalText(text, audit.lang);
    const rewrittenAudit = analyzeFormality(rewritten.rewrittenText, audit.lang);

    res.json({
      lang: audit.lang,
      rewrittenText: rewritten.rewrittenText,
      message: getLocalizedRefinementHint(audit.lang),
      needsRefinement: audit.needsRefinement,
      tooShort: false,
      metrics: {
        before: {
          formalityScore: audit.formalityScore,
          lexicalDensity: audit.lexicalDensity,
          syntacticComplexity: audit.syntacticComplexity,
        },
        after: {
          formalityScore: rewrittenAudit.formalityScore,
          lexicalDensity: rewrittenAudit.lexicalDensity,
          syntacticComplexity: rewrittenAudit.syntacticComplexity,
        },
      },
    });
  } catch (error) {
    console.error("Error in /api/refine:", error);
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
    const summary = summarizeBoardContext(boardContext);
    const defaultFocus =
      findFirstWeakFrame(boardContext) ?? {
        toolId: summary.toolStats[0]?.toolId ?? null,
        toolName: summary.toolStats[0]?.toolName ?? "",
        frameTitle: firstAvailableFrame(boardContext),
        reason: "建议你继续按照 ToolBoard 顺序补齐下一步内容。",
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
        coachMessage: "建议你先在白板上创建 Frame 并填写内容，再进行全局诊断。",
        ragStatus: "online",
      });
    }

    const deterministicDiagnosis = buildDeterministicDiagnosis(boardContext, summary);
    const auditResult = await generateLogicAuditSuggestions(
      boardContext,
      summary,
      "online"
    );
    const cardAnalyses = await buildCardQualityAnalyses(boardContext);
    const qualityAlert =
      buildQualityAlertFromCardAnalyses(cardAnalyses) ||
      (await buildQualityAlert(boardContext));
    const ragStatus = auditResult.ragStatus;

    console.log("Diagnosis facts take priority over RAG context.", {
      totalFrames: summary.totalFrames,
      filledFrames: summary.filledFrames,
      completionScore: summary.completionScore,
      recommendedFocus: deterministicDiagnosis.recommendedFocus.frameTitle,
      isIntervention: deterministicDiagnosis.isIntervention,
      ragStatus,
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
      ragStatus,
    });
  } catch (error) {
    console.error("Error in /api/diagnose:", error);
    res.status(500).json({
      ...EMPTY_DIAGNOSIS,
      coachMessage: error.message,
      ragStatus: "offline",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Toolboard GPT Server running at http://localhost:${PORT}`);
});
