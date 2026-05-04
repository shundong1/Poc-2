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
const recentGeneratedContentHashes = new Set();

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
      console.log("=== OpenAI Chat Completion Payload ===");
      console.log(JSON.stringify(payload, null, 2));
      console.log("=== End OpenAI Payload ===");
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

  console.log("analyzeFormality.input", {
    detectedLang,
    rawText: normalizedText,
    totalTokens,
    effectiveTokenCount,
    cjkCharCount,
    sentenceCount: sentences.length,
    shortTextPenaltyFactor,
    isTrustedContent,
    trustedByHash,
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
  if (detectedLang === "ZH" && /我|觉得/.test(normalizedText)) {
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
    overallScore,
    avgSentenceLength,
    level,
    shortTextPenaltyFactor,
    professionalTermCount,
    nounRatio,
    isSystemRefined,
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
          "You are a professional entrepreneurship mentor. Your task is to optimize a beginner-level idea written on a Miro sticky note.\n\nCurrent context:\n- The user is working in [{{toolTitle}}] during [{{questionDescription}}].\n- The core goal of this step is [{{methodologyGoal}}].\n- For this tool, the rewrite should especially [{{toolSpecificFocus}}].\n\nRewrite rules:\n- Reject superficial polishing. If the source text is sparse, do not merely swap synonyms.\n- Use logical placeholder guidance. Rewrite the note into a professional, structured statement.\n- When critical information is missing for this step, insert bracketed placeholders such as [target user segment], [evidence to validate], or [delivery constraint] so the user knows what to complete next.\n- Preserve the user's intent and keep the rewritten text relatively close in length.\n- Remove subjective fillers such as 我觉得, 感觉, 好像, creo que, pienso que, I think, or I feel.\n- Return only the rewritten text in the same language as the source, with no preamble or explanation.",
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
    const context = req.body?.context && typeof req.body.context === "object" ? req.body.context : {};
    const boardContext = Array.isArray(req.body?.boardContext) ? req.body.boardContext : [];
    const audit = analyzeFormality(text, lang);
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
      audit.lang,
      {
        ...context,
        currentContext: effectiveCurrentContext,
      }
    );
    rememberGeneratedText(rewritten.rewrittenText);
    const rewrittenAudit = analyzeFormality(rewritten.rewrittenText, audit.lang, {
      isSystemRefined: true,
      isVerified: true,
      isSystemGenerated: true,
    });

    res.json({
      lang: audit.lang,
      rewrittenText: rewritten.rewrittenText,
      context: {
        ...buildRefinementContext(context),
        currentContext: effectiveCurrentContext,
      },
      message: getLocalizedRefinementHint(audit.lang),
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
