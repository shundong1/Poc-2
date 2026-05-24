import "./assets/style.css";
import { QUESTION_BANK } from "./questions.js";

miro.board.ui.on("icon:click", async () => {
  await miro.board.ui.openPanel({ url: "/app.html" });
});

const BACKEND_URL = "http://localhost:8787";
const STATUS_COLORS = {
  neutral: "#666",
  success: "#0a7f3f",
  warning: "#a15c00",
  error: "#c62828",
};
const RAG_STATUS_COLORS = {
  online: "#1d9d57",
  offline: "#9e9e9e",
};
const refinedNoteIds = new Set();
const verifiedNoteIds = new Set();
const systemGeneratedNoteIds = new Set();
const userVerifiedNoteIds = new Set();
let showWelcome = true;
let viewMode = "none";
let cachedBoardId = null;
let userVerifiedStateLoadedForBoardId = null;
let isLoading = false;

function normalizeTitle(value = "") {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

async function getCurrentBoardId() {
  if (cachedBoardId) {
    return cachedBoardId;
  }

  try {
    const boardInfo = await miro.board.getInfo();
    cachedBoardId =
      boardInfo?.id || boardInfo?.boardId || boardInfo?.board_id || "default-board";
  } catch (error) {
    console.warn("Failed to resolve board id, falling back to default-board.", error);
    cachedBoardId = "default-board";
  }

  return cachedBoardId;
}

function getUserVerifiedStorageKey(boardId) {
  return `toolboard-user-verified:${boardId || "default-board"}`;
}

function loadUserVerifiedNoteIds(boardId) {
  try {
    const raw = window.localStorage.getItem(getUserVerifiedStorageKey(boardId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (error) {
    console.warn("Failed to load user-verified note ids.", error);
    return [];
  }
}

function persistUserVerifiedNoteIds(boardId) {
  try {
    window.localStorage.setItem(
      getUserVerifiedStorageKey(boardId),
      JSON.stringify([...userVerifiedNoteIds])
    );
  } catch (error) {
    console.warn("Failed to persist user-verified note ids.", error);
  }
}

async function ensureUserVerifiedStateLoaded() {
  const boardId = await getCurrentBoardId();
  if (userVerifiedStateLoadedForBoardId === boardId) {
    return boardId;
  }

  userVerifiedNoteIds.clear();
  for (const noteId of loadUserVerifiedNoteIds(boardId)) {
    userVerifiedNoteIds.add(noteId);
    verifiedNoteIds.add(noteId);
  }
  userVerifiedStateLoadedForBoardId = boardId;
  return boardId;
}

async function markNoteAsUserVerified(noteId) {
  if (!noteId) return;
  const boardId = await ensureUserVerifiedStateLoaded();
  userVerifiedNoteIds.add(noteId);
  verifiedNoteIds.add(noteId);
  persistUserVerifiedNoteIds(boardId);
}

function extractPlainText(item) {
  const raw = (item.content || item.text || "").toString().trim();
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&#xff0c;/gi, ",")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isTrivialArtifactText(text) {
  const normalized = (text || "").trim();
  if (!normalized) return true;

  const compact = normalized.replace(/\s+/g, "");
  if (compact.length === 1 && /^[A-Za-z0-9]$/.test(compact)) {
    return true;
  }

  if (compact.length <= 2 && /^[0-9O銆囬浂鈼嬧€⒙穃-鈥撯€?,:;()]+$/i.test(compact)) {
    return true;
  }

  return false;
}

function buildMeaningfulNoteDetails(items, frameTitle) {
  return items
    .map((item) => ({
      id: item.id,
      text: extractPlainText(item),
      widgetType: item.type || "sticky_note",
      refinedByAgent: refinedNoteIds.has(item.id),
      verified: verifiedNoteIds.has(item.id),
      isUserVerified: userVerifiedNoteIds.has(item.id),
      isSystemGenerated: systemGeneratedNoteIds.has(item.id),
    }))
    .filter((entry) => {
      if (!entry.text) {
        return false;
      }

      if (isTrivialArtifactText(entry.text)) {
        console.log("Ignoring trivial board artifact", {
          frameTitle,
          noteId: entry.id,
          widgetType: entry.widgetType,
          text: entry.text,
        });
        return false;
      }

      return true;
    });
}

function isItemInsideFrame(item, frame) {
  if (
    typeof item.x !== "number" ||
    typeof item.y !== "number" ||
    typeof frame.x !== "number" ||
    typeof frame.y !== "number" ||
    typeof frame.width !== "number" ||
    typeof frame.height !== "number"
  ) {
    return false;
  }

  const left = frame.x - frame.width / 2;
  const right = frame.x + frame.width / 2;
  const top = frame.y - frame.height / 2;
  const bottom = frame.y + frame.height / 2;

  return item.x >= left && item.x <= right && item.y >= top && item.y <= bottom;
}

function setStatus(message, tone = "neutral") {
  const status = document.getElementById("status");
  status.textContent = message;
  status.style.color = STATUS_COLORS[tone] ?? STATUS_COLORS.neutral;
}

function setErrorMessage(message) {
  setStatus(message || "An unexpected error occurred.", "error");
}

function setLoadingState(nextValue) {
  isLoading = nextValue === true;
  ["btnPreview", "btnAnalyse", "btnDiagnose"].forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.style.opacity = isLoading ? "0.72" : "1";
    button.style.cursor = isLoading ? "progress" : "pointer";
  });
  console.log(`[Toolboard GPT] Loading state changed: ${isLoading ? "busy" : "idle"}`);
}

function resetActionUiState(nextMode = "none") {
  setViewMode(nextMode);
  hideDiagnosisPanel();
  const suggestions = document.getElementById("suggestions");
  if (suggestions) {
    suggestions.innerHTML = "";
  }
  const previewContent = document.getElementById("boardPreviewContent");
  if (previewContent) {
    previewContent.textContent = "";
  }
  setStatus("", "neutral");
}

function setViewMode(nextMode = "none") {
  viewMode = nextMode;
  renderActiveView();
}

function renderActiveView() {
  const contentView = document.getElementById("contentView");
  const status = document.getElementById("status");
  const preview = document.getElementById("boardPreview");
  const suggestionSection = document.getElementById("suggestionSection");

  if (!contentView || !status || !preview || !suggestionSection) {
    return;
  }

  if (!contentView.contains(status)) {
    contentView.appendChild(status);
  }
  if (!contentView.contains(preview)) {
    contentView.appendChild(preview);
  }
  if (!contentView.contains(suggestionSection)) {
    contentView.appendChild(suggestionSection);
  }

  preview.style.display = "none";
  suggestionSection.style.display = "none";
  status.style.display = "none";

  switch (viewMode) {
    case "preview":
      status.style.display = "block";
      preview.style.display = "block";
      break;
    case "analysis":
      suggestionSection.style.display = "block";
      status.style.display = "block";
      break;
    case "none":
    default:
      status.style.display = "block";
      break;
  }
}

function updateSystemStatus(ragStatus = "online") {
  const normalized = ragStatus === "offline" ? "offline" : "online";
  const dot = document.getElementById("ragStatusDot");
  const text = document.getElementById("ragStatusText");
  dot.style.background = RAG_STATUS_COLORS[normalized];
  text.textContent = normalized === "online" ? "RAG online" : "RAG offline";
}

function createElement(tag, options = {}) {
  const element = document.createElement(tag);
  if (options.id) element.id = options.id;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.html !== undefined) element.innerHTML = options.html;
  if (options.style) element.style.cssText = options.style;
  if (options.title) element.title = options.title;
  if (options.value !== undefined) element.value = options.value;
  return element;
}

function getQualityTitle(lang = "EN") {
  if (lang === "ZH") return "閫昏緫璐ㄩ噺棰勮";
  if (lang === "ES") return "Alerta de calidad logica";
  return "Logic quality alert";
}

function getApplyLabel(lang = "EN") {
  if (lang === "ZH") return "搴旂敤鏀瑰啓";
  if (lang === "ES") return "Aplicar reescritura";
  return "Apply rewrite";
}

function getOptimizeCardLabel(lang = "EN") {
  if (lang === "ZH") return "Optimize this card";
  if (lang === "ES") return "Optimizar esta tarjeta";
  return "Optimize this card";
}

function getDiagnosticsUiCopy(lang = "EN") {
  if (lang === "ZH") {
    return {
      alertTitle: "逻辑质量提醒",
      problemLabel: "问题",
      whyLabel: "原因",
      originalTextLabel: "原始内容",
      optimizedLabel: "建议优化",
      progressLabel: "当前进度",
      filledFramesLabel: "已填写",
      framesSuffix: "个 Frame",
      prioritizePathLabel: "建议优先调整路径",
      prioritizeLogicLabel: "建议优先检查逻辑一致性",
      nextStepButtonPrefix: "建议完善：",
      nextStepSentencePrefix: "建议你下一步先处理",
      logicAuditHeading: "逻辑一致性建议",
      ignoreLabel: "忽略",
      ignoreTitle: "内容已确认，不再提醒",
    };
  }

  if (lang === "ES") {
    return {
      alertTitle: "Alerta de calidad logica",
      problemLabel: "Problema",
      whyLabel: "Motivo",
      originalTextLabel: "Texto original",
      optimizedLabel: "Optimizacion sugerida",
      progressLabel: "Progreso actual",
      filledFramesLabel: "Completados",
      framesSuffix: "Frame",
      prioritizePathLabel: "Conviene ajustar primero la ruta",
      prioritizeLogicLabel: "Conviene revisar primero la coherencia logica",
      nextStepButtonPrefix: "Conviene reforzar: ",
      nextStepSentencePrefix: "Conviene trabajar ahora en",
      logicAuditHeading: "Sugerencias de coherencia logica",
      ignoreLabel: "Ignorar",
      ignoreTitle: "Contenido confirmado; no volver a recordarlo",
    };
  }

  if (lang === "CA") {
    return {
      alertTitle: "Alerta de qualitat logica",
      problemLabel: "Problema",
      whyLabel: "Motiu",
      originalTextLabel: "Text original",
      optimizedLabel: "Optimitzacio suggerida",
      progressLabel: "Progrés actual",
      filledFramesLabel: "Omplerts",
      framesSuffix: "frames",
      prioritizePathLabel: "Convé ajustar primer el cami",
      prioritizeLogicLabel: "Convé revisar primer la coherencia logica",
      nextStepButtonPrefix: "Convé reforçar: ",
      nextStepSentencePrefix: "Convé treballar ara en",
      logicAuditHeading: "Suggeriments de coherencia logica",
      ignoreLabel: "Ignora",
      ignoreTitle: "Contingut confirmat; no cal recordar-ho de nou",
    };
  }

  return {
    alertTitle: "Logic quality alert",
    problemLabel: "Problem",
    whyLabel: "Why",
    originalTextLabel: "Original text",
    optimizedLabel: "Suggested optimization",
    progressLabel: "Current progress",
    filledFramesLabel: "Filled",
    framesSuffix: "frames",
    prioritizePathLabel: "It is best to adjust the path first",
    prioritizeLogicLabel: "It is best to check logical alignment first",
    nextStepButtonPrefix: "Recommended focus: ",
    nextStepSentencePrefix: "It is best to work next on",
    logicAuditHeading: "Logical alignment suggestions",
    ignoreLabel: "Ignore",
    ignoreTitle: "Content confirmed; do not remind again",
  };
}

function getPreviewUiCopy(lang = "EN") {
  if (lang === "ZH") {
    return {
      title: "Board Preview",
      tip: "💡 提示：如果这里缺少某些便签，请确认它们被直接放置在对应的问题区域内。位于指定 Frame 边界之外的便签无法被系统识别。",
    };
  }

  if (lang === "ES") {
    return {
      title: "Vista previa del tablero",
      tip: "💡 Consejo: si aqui faltan algunas notas adhesivas, asegurese de colocarlas directamente dentro del area correspondiente a la pregunta. Las notas fuera de los limites del frame designado no pueden ser detectadas por el sistema.",
    };
  }

  if (lang === "CA") {
    return {
      title: "Vista previa del tauler",
      tip: "💡 Consell: si aqui falten algunes notes adhesives, assegureu-vos que estiguin col·locades directament dins de l'area corresponent a la pregunta. Les notes situades fora dels limits del frame assignat no poden ser detectades pel sistema.",
    };
  }

  return {
    title: "Board Preview",
    tip: "💡 Tip: If some sticky notes are missing here, please ensure they are placed directly inside the corresponding question area. Stickers outside the designated frame boundaries cannot be detected by the system.",
  };
}

function updatePreviewCopy(lang = "EN") {
  const uiCopy = getPreviewUiCopy(lang);
  const title = document.getElementById("boardPreviewTitle");
  const tip = document.getElementById("boardPreviewTip");
  if (title) title.textContent = uiCopy.title;
  if (tip) tip.textContent = uiCopy.tip;
}

function getNoIssueLabel(lang = "EN") {
  if (lang === "ZH") return "逻辑严密，建议直接分析。";
  if (lang === "ES") return "No se detecto ningun problema importante.";
  return "No major issue detected.";
}

function getRefineButtonLabel(lang = "EN") {
  if (lang === "ZH") return "✨ 一键专业化重构";
  if (lang === "ES") return "✨ Reescritura profesional";
  return "✨ Professional rewrite";
}

function getCardStatusPresentation(analysis) {
  if (analysis.lang === "ZH") {
    if (analysis.level === "formal") {
      return { icon: "✅", text: "逻辑严密，建议直接分析。", color: "#2f6b2f" };
    }
    if (analysis.level === "semi-formal") {
      return { icon: "⚠️", text: "表达尚可，但建议加入更多事实支撑。", color: "#a15c00" };
    }
    return {
      icon: "❌",
      text: "建议：为了确保后续机会分析和商业洞察的生成质量，建议将该描述提升至更具正式性和信息密度的表达方式。",
      color: "#c62828",
    };
  }

  if (analysis.lang === "ES") {
    if (analysis.level === "formal") {
      return {
        icon: "✅",
        text: "La logica es solida; puede pasar directamente al analisis.",
        color: "#2f6b2f",
      };
    }
    if (analysis.level === "semi-formal") {
      return {
        icon: "⚠️",
        text: "La expresion es aceptable, pero conviene sumar mas hechos de apoyo.",
        color: "#a15c00",
      };
    }
    return {
      icon: "❌",
      text: "Sugerencia: conviene profesionalizar esta redaccion antes del siguiente analisis.",
      color: "#c62828",
    };
  }

  if (analysis.level === "formal") {
    return {
      icon: "✅",
      text: "Logic is rigorous. Ready for direct analysis.",
      color: "#2f6b2f",
    };
  }
  if (analysis.level === "semi-formal") {
    return {
      icon: "⚠️",
      text: "Expression is acceptable, but more factual support is recommended.",
      color: "#a15c00",
    };
  }
  return {
    icon: "❌",
    text: "Suggestion: this card should be rewritten in a more formal and information-dense style before further analysis.",
    color: "#c62828",
  };
}

function createWelcomeIllustration() {
  const tiles = [
    { letter: "T", background: "#ef9358" },
    { letter: "O", background: "#ef7b6e" },
    { letter: "O", background: "#e78cb2" },
    { letter: "L", background: "#b6a4ea" },
    { letter: "B", background: "#86a5e8" },
    { letter: "O", background: "#90dde5" },
    { letter: "A", background: "#8de37d" },
    { letter: "R", background: "#f2dc66" },
    { letter: "D", background: "#f5f5f5" },
  ];

  const illustration = createElement("div", {
    style:
      "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;width:min(100%,260px);max-width:260px;margin:0 auto 22px auto;",
  });

  for (const tile of tiles) {
    illustration.appendChild(
      createElement("div", {
        text: tile.letter,
        style:
          `height:74px;border-radius:14px;border:2px solid rgba(100,100,100,0.28);background:${tile.background};display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:800;color:${tile.letter === "D" ? "#8e8e8e" : "#ffffff"};letter-spacing:1px;box-shadow:0 4px 12px rgba(0,0,0,0.06);`,
      })
    );
  }

  return illustration;
}

function renderWelcomeState() {
  const welcomeView = document.getElementById("welcomeView");
  const mainView = document.getElementById("mainView");
  if (!welcomeView || !mainView) return;

  welcomeView.style.display = showWelcome ? "flex" : "none";
  mainView.style.display = showWelcome ? "none" : "block";
}

function ensureUI() {
  if (document.getElementById("tb-root")) return;

  const root = createElement("div", {
    id: "tb-root",
    style:
      "padding:12px;font-family:Arial,sans-serif;box-sizing:border-box;height:100vh;overflow-y:auto;background:linear-gradient(180deg,#ffffff 0%,#f7f9fc 100%);",
  });

  const welcomeView = createElement("div", {
    id: "welcomeView",
    style:
      "min-height:calc(100vh - 24px);display:flex;flex-direction:column;justify-content:center;padding:18px 0 24px 0;width:100%;",
  });

  const welcomeCard = createElement("div", {
    style:
      "width:100%;max-width:100%;background:#ffffff;border:1px solid #e8edf5;border-radius:24px;padding:24px 20px;box-shadow:0 16px 40px rgba(16,42,67,0.08);box-sizing:border-box;",
  });

  const welcomeTitle = createElement("h2", {
    text: "Welcome to Toolboard GPT",
    style:
      "margin:0 0 18px 0;font-size:24px;line-height:1.2;text-align:center;color:#102a43;font-weight:800;",
  });

  const instructionTitle = createElement("div", {
    text: "How to use:",
    style: "font-size:13px;font-weight:700;color:#334e68;margin-bottom:10px;",
  });

  const instructionList = createElement("div", {
    style: "display:flex;flex-direction:column;gap:10px;margin-bottom:22px;",
  });

  const instructionItems = [
    {
      title: "Select:",
      text: "Choose a Tool and the specific question you want to work on.",
    },
    {
      title: "Preview:",
      text: "Use 'Preview' to review the current board content without generating suggestions.",
    },
    {
      title: "Analyse:",
      text: "Click 'Analyse' to generate suggested answers for the selected question, and insert them as sticky notes if needed.",
    },
    {
      title: "Project Review:",
      text: "Run Project Review to check project progress, logic gaps, and the next recommended step. It also includes a 'Professional Refinement' feature to improve any sticky note that is not clear or specific enough based on your project context.",
    },
  ];

  for (const item of instructionItems) {
    instructionList.appendChild(
      createElement("div", {
        html: `<span style="font-weight:700;color:#102a43;">${item.title}</span> <span style="color:#486581;">${item.text}</span>`,
        style: "font-size:12px;line-height:1.6;",
      })
    );
  }

  const getStartedButton = createElement("button", {
    id: "btnGetStarted",
    text: "Get Started",
    style:
      "width:100%;padding:14px 18px;cursor:pointer;background:#4262ff;color:#fff;border:none;border-radius:14px;font-size:15px;font-weight:700;box-shadow:0 12px 24px rgba(66,98,255,0.24);transition:transform 0.18s ease, box-shadow 0.18s ease;",
  });
  getStartedButton.addEventListener("mouseenter", () => {
    getStartedButton.style.transform = "scale(1.03)";
    getStartedButton.style.boxShadow = "0 16px 28px rgba(66,98,255,0.30)";
  });
  getStartedButton.addEventListener("mouseleave", () => {
    getStartedButton.style.transform = "scale(1)";
    getStartedButton.style.boxShadow = "0 12px 24px rgba(66,98,255,0.24)";
  });
  getStartedButton.addEventListener("click", () => {
    showWelcome = false;
    renderWelcomeState();
  });

  welcomeCard.append(
    welcomeTitle,
    createWelcomeIllustration(),
    instructionTitle,
    instructionList,
    getStartedButton
  );
  welcomeView.appendChild(welcomeCard);

  const mainView = createElement("div", {
    id: "mainView",
    style: "display:none;",
  });

  const header = createElement("h3", {
    text: "Toolboard GPT",
    style: "margin:0 0 8px 0;font-size:14px;",
  });

  const systemBar = createElement("div", {
    style:
      "display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding:8px 10px;border:1px solid #e6e6e6;border-radius:10px;background:#fafafa;",
  });
  const systemLabel = createElement("div", {
    text: "System status",
    style: "font-size:11px;color:#666;font-weight:bold;",
  });
  const indicator = createElement("div", {
    style: "display:flex;align-items:center;gap:6px;font-size:11px;color:#444;",
  });
  indicator.append(
    createElement("span", {
      id: "ragStatusDot",
      style:
        "width:10px;height:10px;border-radius:999px;display:inline-block;background:#1d9d57;",
    }),
    createElement("span", {
      id: "ragStatusText",
      text: "RAG online",
    })
  );
  systemBar.append(systemLabel, indicator);

  const diagnoseButton = createElement("button", {
    id: "btnDiagnose",
    text: "鍏ㄥ眬杩涘害璇婃柇",
    style:
      "width:100%;padding:10px 12px;margin-bottom:10px;cursor:pointer;background:#102a43;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:bold;",
  });

  diagnoseButton.textContent = "Project Review";

  const toolBlock = createElement("div", { style: "margin-bottom:6px;" });
  toolBlock.append(
    createElement("div", {
      text: "Tool",
      style: "font-size:11px;color:#666;margin-bottom:2px;",
    }),
    createElement("select", {
      id: "toolSelect",
      style: "width:100%;padding:4px;font-size:12px;",
    })
  );

  const questionBlock = createElement("div", { style: "margin-bottom:8px;" });
  questionBlock.append(
    createElement("div", {
      text: "Focus Question",
      style: "font-size:11px;color:#666;margin-bottom:2px;",
    }),
    createElement("select", {
      id: "qSelect",
      style: "width:100%;padding:4px;font-size:12px;",
    })
  );

  const buttonRow = createElement("div", {
    style: "display:flex;gap:6px;margin-bottom:6px;",
  });
  buttonRow.append(
    createElement("button", {
      id: "btnAnalyse",
      text: "Analyse",
      style:
        "flex:1;padding:7px;cursor:pointer;background:#4262ff;color:#fff;border:none;border-radius:8px;font-size:13px;",
    }),
    createElement("button", {
      id: "btnPreview",
      text: "Preview",
      style:
        "padding:7px;cursor:pointer;background:#f0f0f0;border:none;border-radius:8px;font-size:11px;",
    })
  );

  const status = createElement("div", {
    id: "status",
    style: "font-size:11px;color:#888;margin-bottom:6px;min-height:16px;",
  });

  const previewWrap = createElement("div", {
    id: "boardPreview",
    style: "display:none;margin-bottom:8px;",
  });
  previewWrap.append(
    createElement("div", {
      id: "boardPreviewTitle",
      text: "Board Preview",
      style: "font-size:11px;font-weight:bold;margin-bottom:2px;",
    }),
    createElement("div", {
      id: "boardPreviewTip",
      text: "💡 Tip: If some sticky notes are missing here, please ensure they are placed directly inside the corresponding question area. Stickers outside the designated frame boundaries cannot be detected by the system.",
      style:
        "font-size:12px;line-height:1.5;color:#666666;margin:8px 0;padding:8px 10px;border:1px solid #d9e8ff;border-radius:10px;background:#f5f9ff;",
    }),
    createElement("pre", {
      id: "boardPreviewContent",
      style:
        "font-size:10px;background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:6px;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;",
    })
  );

  const suggestionSection = createElement("div", {
    id: "suggestionSection",
    style: "border:1px solid #ddd;border-radius:8px;padding:8px;",
  });
  suggestionSection.append(
    createElement("b", {
      text: "Suggestions",
      style: "font-size:12px;",
    }),
    createElement("div", {
      id: "diagnosisPanel",
      style:
        "display:none;margin-top:8px;margin-bottom:8px;padding:10px;border:1px solid #d6b36a;border-radius:10px;background:#fff8e8;max-height:350px;overflow-y:auto;",
    }),
    createElement("div", {
      id: "suggestions",
      style:
        "margin-top:6px;max-height:calc(100vh - 360px);overflow-y:auto;padding-right:4px;padding-bottom:20px;",
    })
  );

  const contentView = createElement("div", {
    id: "contentView",
    style: "margin-top:4px;",
  });
  contentView.append(status, previewWrap, suggestionSection);

  mainView.append(
    header,
    systemBar,
    diagnoseButton,
    toolBlock,
    questionBlock,
    buttonRow,
    contentView
  );

  root.append(welcomeView, mainView);
  document.body.appendChild(root);
  renderWelcomeState();
  renderActiveView();
}

function populateToolOptions() {
  const toolSelect = document.getElementById("toolSelect");
  toolSelect.innerHTML = "";
  for (const tool of QUESTION_BANK) {
    toolSelect.appendChild(
      createElement("option", {
        value: String(tool.toolId),
        text: tool.toolName,
      })
    );
  }
}

function populateQuestionOptions(toolId) {
  const questionSelect = document.getElementById("qSelect");
  questionSelect.innerHTML = "";
  const tool = QUESTION_BANK.find((entry) => entry.toolId === toolId);

  for (const question of tool?.questions ?? []) {
    questionSelect.appendChild(
      createElement("option", {
        value: question.qId,
        text:
          question.label.length > 80
            ? `${question.label.slice(0, 80)}...`
            : question.label,
        title: question.label,
      })
    );
  }
}

function inspectFrameRead(frameTitle, frames, items) {
  const exactMatches = frames.filter((entry) => entry.title === frameTitle);
  const normalizedMatches = frames.filter(
    (entry) => normalizeTitle(entry.title || "") === normalizeTitle(frameTitle)
  );
  const similarTitles = frames
    .filter(
      (entry) =>
        entry.title &&
        entry.title !== frameTitle &&
        normalizeTitle(entry.title).includes(normalizeTitle(frameTitle))
    )
    .map((entry) => entry.title)
    .slice(0, 3);

  const frame = exactMatches[0] ?? normalizedMatches[0] ?? null;
  if (!frame) {
    return {
      notes: [],
      noteDetails: [],
      found: false,
      matchedBy: "missing",
      duplicateCount: 0,
      parentedCount: 0,
      insideButUnparentedCount: 0,
      similarTitles,
      frameId: null,
      readMode: "missing",
    };
  }

  const parentedItems = items.filter((item) => item.parentId === frame.id);
  const insideButUnparentedItems = items.filter(
    (item) => item.parentId !== frame.id && isItemInsideFrame(item, frame)
  );
  const parentedNoteDetails = buildMeaningfulNoteDetails(parentedItems, frameTitle);
  const fallbackNoteDetails = buildMeaningfulNoteDetails(
    insideButUnparentedItems,
    frameTitle
  );
  const noteDetails =
    parentedNoteDetails.length > 0 ? parentedNoteDetails : fallbackNoteDetails;
  const readMode =
    parentedNoteDetails.length > 0
      ? "parentId"
      : fallbackNoteDetails.length > 0
      ? "geometry-fallback"
      : "empty";

  return {
    notes: noteDetails.map((entry) => entry.text),
    noteDetails,
    found: true,
    matchedBy: exactMatches.length > 0 ? "exact" : "normalized",
    duplicateCount: exactMatches.length,
    parentedCount: parentedItems.length,
    insideButUnparentedCount: insideButUnparentedItems.length,
    similarTitles,
    frameId: frame.id,
    readMode,
  };
}

async function readFullBoard() {
  await ensureUserVerifiedStateLoaded();
  const frames = await miro.board.get({ type: "frame" });
  const items = await miro.board.get({ type: ["sticky_note", "text"] });
  const results = [];

  for (const tool of QUESTION_BANK) {
    const toolResult = {
      toolId: tool.toolId,
      toolName: tool.toolName,
      toolDescription: tool.toolDescription,
      questions: [],
    };

    for (const question of tool.questions) {
      const frameData = inspectFrameRead(question.anchorFrameTitle, frames, items);
      toolResult.questions.push({
        qId: question.qId,
        label: question.label,
        anchorFrameTitle: question.anchorFrameTitle,
        notes: frameData.notes,
        noteDetails: frameData.noteDetails,
        found: frameData.found,
        matchedBy: frameData.matchedBy,
        duplicateCount: frameData.duplicateCount,
        parentedCount: frameData.parentedCount,
        insideButUnparentedCount: frameData.insideButUnparentedCount,
        similarTitles: frameData.similarTitles,
        frameId: frameData.frameId,
        readMode: frameData.readMode,
      });
    }

    results.push(toolResult);
  }

  return results;
}

async function runBoardReadAudit() {
  const boardData = await readFullBoard();
  const report = [];

  for (const tool of boardData) {
    for (const question of tool.questions) {
      const issue =
        !question.found
          ? "missing-frame"
          : question.duplicateCount > 1
          ? "duplicate-frame-title"
          : question.readMode === "geometry-fallback"
          ? "items-inside-but-unparented"
          : question.matchedBy === "normalized"
          ? "normalized-title-match"
          : "ok";

      report.push({
        toolName: tool.toolName,
        frameTitle: question.anchorFrameTitle,
        issue,
        matchedBy: question.matchedBy,
        readMode: question.readMode,
        noteCount: question.notes.length,
        duplicateCount: question.duplicateCount,
        parentedCount: question.parentedCount,
        insideButUnparentedCount: question.insideButUnparentedCount,
        similarTitles: question.similarTitles,
      });
    }
  }

  console.group("Board read audit");
  console.table(report);
  console.groupEnd();
  return report;
}

function formatBoardPreview(boardData) {
  return boardData
    .map((tool) => {
      const lines = tool.questions
        .map((question) => {
          const header = question.found
            ? `  [${question.anchorFrameTitle}]`
            : `  [${question.anchorFrameTitle}] (missing frame)`;
          const notesText =
            question.notes.length > 0
              ? question.notes.map((note) => `    - ${note}`).join("\n")
              : question.found
              ? "    (empty)"
              : "    Create a frame with this exact title to use this question.";

          return `${header}\n${notesText}`;
        })
        .join("\n");

      return `=== ${tool.toolName} ===\n${lines}`;
    })
    .join("\n\n");
}

function collectMissingFrames(boardData) {
  return boardData.flatMap((tool) =>
    tool.questions
      .filter((question) => !question.found)
      .map((question) => ({
        toolName: tool.toolName,
        anchorFrameTitle: question.anchorFrameTitle,
      }))
  );
}

function setSuggestionsVisible(visible) {
  const suggestionSection = document.getElementById("suggestionSection");
  if (!suggestionSection) return;
  suggestionSection.style.display = visible ? "block" : "none";
}

function hideDiagnosisPanel() {
  const panel = document.getElementById("diagnosisPanel");
  panel.style.display = "none";
  panel.innerHTML = "";
}

function renderFrameWarning(frameTitle) {
  hideDiagnosisPanel();
  document.getElementById("suggestions").innerHTML = `
    <div style="border:1px solid #f5c26b;border-radius:10px;padding:10px;background:#fff6e5;color:#7a4b00;font-size:12px;line-height:1.5;">
      <div style="font-weight:bold;margin-bottom:6px;">Frame not found</div>
      <div>Create a Miro frame named <code>${frameTitle}</code> and run Analyse again.</div>
    </div>
  `;
}

function renderAuditReport(report) {
  hideDiagnosisPanel();
  const suggestions = document.getElementById("suggestions");
  const flagged = report.filter((entry) => entry.issue !== "ok");

  if (flagged.length === 0) {
    suggestions.innerHTML = `
      <div style="border:1px solid #cfe8d4;border-radius:10px;padding:10px;background:#eef9f1;color:#1b5e20;font-size:12px;line-height:1.5;">
        <div style="font-weight:bold;margin-bottom:6px;">Read test passed</div>
        <div>All expected frames were matched without obvious read issues. Check the console for the full audit table.</div>
      </div>
    `;
    return;
  }

  suggestions.innerHTML = `
    <div style="border:1px solid #f5c26b;border-radius:10px;padding:10px;background:#fff6e5;color:#7a4b00;font-size:12px;line-height:1.5;margin-bottom:8px;">
      <div style="font-weight:bold;margin-bottom:6px;">Read test found ${flagged.length} potential issue(s)</div>
      <div>Common causes: duplicate frame titles, exact title mismatch, or notes visually inside a frame but not attached via <code>parentId</code>.</div>
    </div>
  `;

  for (const entry of flagged.slice(0, 20)) {
    const card = createElement("div", {
      style:
        "border:1px solid #eee;border-radius:10px;padding:10px;margin-bottom:8px;background:#fafafa;",
    });
    card.append(
      createElement("div", {
        text: `${entry.frameTitle} (${entry.issue})`,
        style: "font-weight:bold;font-size:12px;margin-bottom:6px;color:#333;",
      }),
      createElement("div", {
        text:
          `Tool: ${entry.toolName} | matchedBy: ${entry.matchedBy} | readMode: ${entry.readMode} | noteCount: ${entry.noteCount} | duplicates: ${entry.duplicateCount} | parented: ${entry.parentedCount} | inside-but-unparented: ${entry.insideButUnparentedCount}` +
          (entry.similarTitles?.length
            ? ` | similarTitles: ${entry.similarTitles.join(", ")}`
            : ""),
        style:
          "font-size:11px;color:#444;line-height:1.5;white-space:pre-wrap;word-break:break-word;",
      })
    );
    suggestions.appendChild(card);
  }
}

async function zoomToFrame(frameTitle) {
  if (!frameTitle) return;
  const frames = await miro.board.get({ type: "frame" });
  const frame = frames.find((entry) => entry.title === frameTitle);

  if (!frame) {
    setStatus(`Frame "${frameTitle}" was not found on the board.`, "warning");
    return;
  }

  await miro.board.viewport.zoomTo(frame);
  setStatus(`Moved to ${frameTitle}.`, "success");
}

async function resolveTargetFrame(frameTitle) {
  const frames = await miro.board.get({ type: "frame" });
  const exactMatches = frames.filter((entry) => entry.title === frameTitle);
  const normalizedMatches = frames.filter(
    (entry) => normalizeTitle(entry.title || "") === normalizeTitle(frameTitle)
  );

  const matches = exactMatches.length > 0 ? exactMatches : normalizedMatches;
  const frame = matches[0] ?? null;

  if (matches.length > 1) {
    console.warn(
      `[Toolboard GPT] Multiple frames matched "${frameTitle}". Using the first match: ${matches[0]?.id || "(unknown)"}`
    );
  }

  return {
    frame,
    matchCount: matches.length,
    matchedBy: exactMatches.length > 0 ? "exact" : normalizedMatches.length > 0 ? "normalized" : "missing",
  };
}

async function fetchJson(path, payload) {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  updateSystemStatus(data?.ragStatus);

  if (!response.ok) {
    throw new Error(
      data?.error || data?.coachMessage || `Request failed with status ${response.status}`
    );
  }

  return data;
}

async function applyRefinementToSticky(noteId, rewrittenText) {
  if (!noteId || !rewrittenText) {
    return;
  }

  if (miro.board.widgets?.update) {
    await miro.board.widgets.update({
      id: noteId,
      text: rewrittenText,
    });
    return;
  }

  const stickyNotes = await miro.board.get({ type: "sticky_note" });
  const sticky = stickyNotes.find((entry) => entry.id === noteId);
  if (!sticky) {
    throw new Error("Target sticky note not found.");
  }

  sticky.content = rewrittenText;

  if (typeof sticky.sync === "function") {
    await sticky.sync();
    return;
  }

  throw new Error("This Miro SDK version does not support sticky updates in the current code path.");
}

async function refreshDiagnosisPanel() {
  const boardId = await getCurrentBoardId();
  const boardData = await readFullBoard();
  const phase1 = await fetchJson("/api/diagnose", { boardId, boardContext: boardData });
  renderDiagnosis(phase1);
  const phase2 = await fetchJson("/api/diagnose/details", {
    boardId,
    boardContext: boardData,
    lang: phase1.lang,
  });
  updateDiagnosisAiContent(phase2);
  return { ...phase1, ...phase2 };
}

function buildRefinementContextPayload(analysis) {
  return {
    toolId: analysis.toolId ?? null,
    toolTitle: analysis.toolName || "",
    questionId: analysis.questionId || analysis.frameTitle || "",
    questionDescription: analysis.questionDescription || "",
    methodologyGoal: analysis.methodologyGoal || "",
    toolSpecificFocus: analysis.toolSpecificFocus || "",
    frameTitle: analysis.frameTitle || "",
  };
}

function extractQuestionNotes(question = {}) {
  const noteDetails = Array.isArray(question.noteDetails)
    ? question.noteDetails
    : (question.notes ?? []).map((text) => ({ text }));

  return noteDetails
    .map((note) => String(note?.text || "").trim())
    .filter(Boolean);
}

function detectPreferredQuestionLanguage(boardData = [], toolId = null, qId = "") {
  const detectFromText = (text = "") => {
    const normalized = String(text || "").trim();
    const lower = ` ${normalized.toLowerCase()} `;
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

    if (/[\u4E00-\u9FFF]/.test(normalized)) return "ZH";
    if (/[àèéíïòóúüç]/i.test(normalized) || countHints(lower, catalanHints) >= 2) return "CA";
    if (/[áéíóúñü¿¡]/i.test(normalized) || countHints(lower, spanishHints) >= 2) return "ES";
    return /[A-Za-z]/.test(normalized) ? "EN" : "";
  };

  const currentTool = boardData.find((entry) => entry.toolId === toolId);
  const currentQuestion = (currentTool?.questions ?? []).find(
    (entry) => entry.qId === qId
  );
  const currentQuestionText = extractQuestionNotes(currentQuestion).join(" ").trim();

  const currentQuestionLang = detectFromText(currentQuestionText);
  if (currentQuestionLang) return currentQuestionLang;

  const currentToolText = (currentTool?.questions ?? [])
    .flatMap((question) => extractQuestionNotes(question))
    .join(" ")
    .trim();

  const currentToolLang = detectFromText(currentToolText);
  if (currentToolLang) return currentToolLang;

  const boardText = boardData
    .flatMap((tool) => (tool.questions ?? []).flatMap((question) => extractQuestionNotes(question)))
    .join(" ")
    .trim();

  const boardLang = detectFromText(boardText);
  if (boardLang) return boardLang;
  return "EN";
}

function buildCurrentContextPayload(boardData, analysis) {
  const currentTool = (boardData || []).find((tool) => tool.toolId === analysis.toolId);
  const toolContext = (currentTool?.questions ?? [])
    .filter((question) => question.qId !== (analysis.questionId || analysis.frameTitle))
    .map((question) => ({
      questionId: question.qId,
      questionText: question.label || "",
      notes: extractQuestionNotes(question),
    }))
    .filter((entry) => entry.notes.length > 0);

  const projectContext = (boardData || [])
    .filter(
      (tool) =>
        typeof tool.toolId === "number" &&
        typeof analysis.toolId === "number" &&
        tool.toolId < analysis.toolId
    )
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
      questionId: analysis.questionId || analysis.frameTitle || "",
      questionText: analysis.questionDescription || "",
      toolName: analysis.toolName || "",
    },
  };
}

async function applyRefinement(refinementTarget) {
  if (!refinementTarget?.canApply && !refinementTarget?.canOptimize) {
    return;
  }

  const boardData = await readFullBoard();
  const currentContext = buildCurrentContextPayload(boardData, refinementTarget);

  const refineResponse = await fetchJson("/api/refine", {
    text: refinementTarget.originalText || refinementTarget.sourceText || "",
    lang: refinementTarget.lang || "",
    context: {
      ...buildRefinementContextPayload(refinementTarget),
      currentContext,
    },
    boardContext: boardData,
  });

  await applyRefinementToSticky(
    refinementTarget.noteId,
    refineResponse.rewrittenText ||
      refinementTarget.rewrittenText ||
      refinementTarget.optimizedText
  );
  if (refinementTarget.noteId) {
    refinedNoteIds.add(refinementTarget.noteId);
    verifiedNoteIds.add(refinementTarget.noteId);
    systemGeneratedNoteIds.add(refinementTarget.noteId);
  }
  await refreshDiagnosisPanel();
  setStatus("Refinement applied and the review has been refreshed.", "success");
}

async function ignoreCardAnalysis(analysis, cardElement) {
  if (!analysis?.noteId) {
    return;
  }

  await markNoteAsUserVerified(analysis.noteId);

  if (cardElement) {
    cardElement.style.transition = "opacity 180ms ease, background 180ms ease";
    cardElement.style.background = "#eef8ef";
    cardElement.style.borderColor = "#9ccc9c";
    cardElement.style.opacity = "0.55";
  }

  setStatus("Confirmed. This item will not trigger reminders again.", "success");
  await refreshDiagnosisPanel();
}

function renderSuggestions(suggestions, targetFrameTitle) {
  const wrap = document.getElementById("suggestions");
  wrap.innerHTML = "";

  if (!suggestions || suggestions.length === 0) {
    wrap.innerHTML =
      '<div style="color:#999;font-size:13px;padding:8px 0;">(No suggestions returned)</div>';
    return;
  }

  for (const suggestion of suggestions) {
    const card = createElement("div", {
      style:
        "border:1px solid #eee;border-radius:10px;padding:10px;margin-bottom:8px;background:#fafafa;",
    });
    const button = createElement("button", {
      text: "Insert as Sticky Note",
      style:
        "padding:6px 10px;cursor:pointer;background:#4262ff;color:#fff;border:none;border-radius:6px;font-size:12px;",
    });

    button.addEventListener("click", async () => {
      await insertStickyNote(
        suggestion.content || suggestion.text || "",
        targetFrameTitle
      );
    });

    card.append(
      createElement("div", {
        text: suggestion.title || "Suggestion",
        style: "font-weight:bold;font-size:13px;margin-bottom:6px;color:#333;",
      }),
      createElement("div", {
        text: suggestion.content || suggestion.text || "",
        style:
          "font-size:12px;color:#444;margin-bottom:8px;line-height:1.5;white-space:pre-wrap;word-break:break-word;",
      }),
      button
    );
    wrap.appendChild(card);
  }
}

function renderSuggestionLoading(message = "Loading suggestions...") {
  const wrap = document.getElementById("suggestions");
  if (!wrap) return;
  wrap.innerHTML = `
    <div style="border:1px solid #d9e4ff;border-radius:10px;padding:10px;background:#f7f9ff;color:#335; font-size:12px;line-height:1.5;">
      ${message}
    </div>
  `;
}

function renderQualityAlert(panel, qualityAlert) {
  if (!qualityAlert) return;

  console.log("renderQualityAlert.payload", qualityAlert);

  const card = createElement("div", {
    style:
      "border:1px solid #9cd39c;border-radius:10px;padding:10px;margin-bottom:10px;background:#effaea;",
  });
  card.append(
    createElement("div", {
      text: getQualityTitle(qualityAlert.lang),
      style: "font-size:12px;font-weight:bold;color:#2f6b2f;margin-bottom:6px;",
    }),
    createElement("div", {
      text: qualityAlert.message,
      style: "font-size:12px;line-height:1.6;color:#335533;margin-bottom:8px;",
    })
  );

  if (qualityAlert.rewrittenText) {
    card.appendChild(
      createElement("div", {
        text: qualityAlert.rewrittenText,
        style:
          "font-size:12px;line-height:1.6;color:#234023;padding:8px;border-radius:8px;background:#fff;border:1px solid #d6ead6;margin-bottom:8px;white-space:pre-wrap;",
      })
    );
  }

  const metrics = qualityAlert.qualityMetrics || qualityAlert.metrics || null;
  if (qualityAlert.isTooShort === true) {
    card.appendChild(
      createElement("div", {
        text: qualityAlert.message,
        style: "font-size:11px;color:#4a664a;margin-bottom:8px;",
      })
    );
  } else if (metrics) {
    const metricsWrap = createElement("div", {
      style:
        "display:flex;flex-direction:column;gap:6px;margin-bottom:8px;",
    });
    metricsWrap.append(
      createElement("div", {
        text: `F-score: ${metrics.formalityScore ?? "-"}`,
        style:
          "font-size:11px;color:#4a664a;padding:6px 8px;border-radius:8px;background:#ffffff;border:1px solid #d6ead6;",
      }),
      createElement("div", {
        text: `Lexical Density: ${metrics.lexicalDensity ?? "-"}`,
        style:
          "font-size:11px;color:#4a664a;padding:6px 8px;border-radius:8px;background:#ffffff;border:1px solid #d6ead6;",
      }),
      createElement("div", {
        text: `Syntactic Complexity: ${metrics.syntacticComplexity ?? "-"}`,
        style:
          "font-size:11px;color:#4a664a;padding:6px 8px;border-radius:8px;background:#ffffff;border:1px solid #d6ead6;",
      }),
      createElement("div", {
        text: `Overall Score: ${metrics.overallScore ?? "-"}`,
        style:
          "font-size:11px;color:#4a664a;padding:6px 8px;border-radius:8px;background:#ffffff;border:1px solid #d6ead6;",
      })
    );
    card.appendChild(metricsWrap);
  }

  if (qualityAlert.canApply) {
    const applyButton = createElement("button", {
      text: getRefineButtonLabel(qualityAlert.lang),
      style:
        "padding:7px 10px;cursor:pointer;background:#2f8f46;color:#fff;border:none;border-radius:8px;font-size:12px;",
    });
    applyButton.addEventListener("click", async () => {
      try {
        await applyRefinement(qualityAlert);
      } catch (error) {
        console.error(error);
        setStatus(error?.message || "Failed to apply rewrite.", "error");
      }
    });
    card.appendChild(applyButton);
  }

  panel.appendChild(card);
}

function renderCardAnalyses(panel, cardAnalyses = []) {
  const actionableAnalyses = (Array.isArray(cardAnalyses) ? cardAnalyses : []).filter(
    (analysis) =>
      (analysis.scores?.overallScore ?? 0) < 60 &&
      analysis.isSystemGenerated !== true &&
      analysis.verified !== true
  );

  if (actionableAnalyses.length === 0) {
    return;
  }

  for (const analysis of actionableAnalyses) {
    const uiCopy = getDiagnosticsUiCopy(analysis.lang);
    const statusPresentation = getCardStatusPresentation(analysis);
    const hasIssue = Array.isArray(analysis.alerts) && analysis.alerts.length > 0;
    const primaryAlert = hasIssue ? analysis.alerts[0] : null;
    const card = createElement("div", {
      style:
        "border:1px solid #e57373;border-radius:10px;padding:10px;margin-bottom:10px;background:#fff5f5;",
    });

    card.append(
      createElement("div", {
        text: `${analysis.cardLabel}: ${statusPresentation.icon} ${uiCopy.alertTitle}`,
        style: `font-size:12px;font-weight:bold;margin-bottom:6px;color:${
          "#c62828"
        };`,
      }),
      createElement("div", {
        text: `${analysis.toolName} | ${analysis.frameTitle}`,
        style: "font-size:11px;color:#7a6a4d;margin-bottom:8px;word-break:break-word;",
      }),
      createElement("div", {
        text: statusPresentation.text,
        style: "font-size:12px;line-height:1.6;color:#c62828;margin-bottom:8px;",
      })
    );

    const scoreWrap = createElement("div", {
      style: "display:flex;flex-direction:column;gap:6px;margin-bottom:8px;",
    });
    scoreWrap.append(
      createElement("div", {
        text: `F-score: ${analysis.scores?.fScore ?? "-"}`,
        style:
          "font-size:11px;color:#5c4a20;padding:6px 8px;border-radius:8px;background:#fff;border:1px solid #eadfc4;",
      }),
      createElement("div", {
        text: `Lexical Density: ${analysis.scores?.lexicalDensity ?? "-"}`,
        style:
          "font-size:11px;color:#5c4a20;padding:6px 8px;border-radius:8px;background:#fff;border:1px solid #eadfc4;",
      }),
      createElement("div", {
        text: `Syntactic Complexity: ${analysis.scores?.syntacticComplexity ?? "-"}`,
        style:
          "font-size:11px;color:#5c4a20;padding:6px 8px;border-radius:8px;background:#fff;border:1px solid #eadfc4;",
      }),
      createElement("div", {
        text: `Overall Score: ${analysis.scores?.overallScore ?? "-"}`,
        style:
          "font-size:11px;color:#5c4a20;padding:6px 8px;border-radius:8px;background:#fff;border:1px solid #eadfc4;",
      })
    );
    card.appendChild(scoreWrap);

    if (primaryAlert) {
      card.append(
        createElement("div", {
          text: `${uiCopy.problemLabel}: ${primaryAlert.message}`,
          style: "font-size:12px;line-height:1.6;color:#5c3c00;margin-bottom:6px;",
        }),
        createElement("div", {
          text: `${uiCopy.whyLabel}: ${primaryAlert.reason}`,
          style: "font-size:11px;line-height:1.6;color:#6d5b36;margin-bottom:8px;",
        })
      );
    }

    card.append(
      createElement("div", {
        text: uiCopy.originalTextLabel,
        style: "font-size:11px;font-weight:bold;color:#7a4b00;margin-bottom:4px;",
      }),
      createElement("div", {
        text: analysis.originalText || "",
        style:
          "font-size:12px;line-height:1.6;color:#3d3426;padding:8px;border-radius:8px;background:#fff;border:1px solid #efe4c8;margin-bottom:8px;white-space:pre-wrap;word-break:break-word;",
      })
    );

    if (analysis.optimizedText) {
      card.append(
        createElement("div", {
          text: uiCopy.optimizedLabel,
          style: "font-size:11px;font-weight:bold;color:#2f6b2f;margin-bottom:4px;",
        }),
        createElement("div", {
          text: analysis.optimizedText,
          style:
            "font-size:12px;line-height:1.6;color:#234023;padding:8px;border-radius:8px;background:#f6fff6;border:1px solid #d6ead6;margin-bottom:8px;white-space:pre-wrap;word-break:break-word;",
        })
      );
    }

    if (analysis.canOptimize) {
      const actionRow = createElement("div", {
        style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;",
      });
      const optimizeButton = createElement("button", {
        text: getRefineButtonLabel(analysis.lang),
        style:
          "padding:7px 10px;cursor:pointer;background:#2f8f46;color:#fff;border:none;border-radius:8px;font-size:12px;",
      });
      optimizeButton.addEventListener("click", async () => {
        try {
          await applyRefinement(analysis);
        } catch (error) {
          console.error(error);
          setStatus(error?.message || "Failed to optimize this card.", "error");
        }
      });
      actionRow.appendChild(optimizeButton);

      const ignoreButton = createElement("button", {
        text: uiCopy.ignoreLabel,
        title: uiCopy.ignoreTitle,
        style:
          "padding:7px 10px;cursor:pointer;background:#eef6f0;color:#2f6b3e;border:1px solid #b7d7c0;border-radius:8px;font-size:12px;",
      });
      ignoreButton.addEventListener("click", async () => {
        try {
          await ignoreCardAnalysis(analysis, card);
        } catch (error) {
          console.error(error);
          setStatus(error?.message || "Failed to confirm this card.", "error");
        }
      });
      actionRow.appendChild(ignoreButton);
      card.appendChild(actionRow);
    } else {
      const actionRow = createElement("div", {
        style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;",
      });
      const ignoreButton = createElement("button", {
        text: uiCopy.ignoreLabel,
        title: uiCopy.ignoreTitle,
        style:
          "padding:7px 10px;cursor:pointer;background:#eef6f0;color:#2f6b3e;border:1px solid #b7d7c0;border-radius:8px;font-size:12px;",
      });
      ignoreButton.addEventListener("click", async () => {
        try {
          await ignoreCardAnalysis(analysis, card);
        } catch (error) {
          console.error(error);
          setStatus(error?.message || "Failed to confirm this card.", "error");
        }
      });
      actionRow.appendChild(ignoreButton);
      card.appendChild(actionRow);
    }

    panel.appendChild(card);
  }
}

function renderDiagnosis(result) {
  const uiCopy = getDiagnosticsUiCopy(result.lang || "EN");
  const panel = document.getElementById("diagnosisPanel");
  panel.style.display = "block";
  panel.innerHTML = "";

  const hasPriorityHighlight =
    result.isIntervention ||
    (Array.isArray(result.logicAuditSuggestions) &&
      result.logicAuditSuggestions.length > 0);

  if (hasPriorityHighlight) {
    const highlightCard = createElement("div", {
      style:
        "border:1px solid #f0c36d;border-radius:10px;padding:10px;margin-bottom:10px;background:#fff3d9;",
    });
    highlightCard.append(
      createElement("div", {
        text: result.isIntervention
          ? uiCopy.prioritizePathLabel
          : uiCopy.prioritizeLogicLabel,
        style: "font-size:12px;font-weight:bold;color:#7a4b00;margin-bottom:6px;",
      }),
      createElement("div", {
        text: result.coachMessage,
        style: "font-size:12px;line-height:1.6;color:#4a3a18;",
      })
    );
    panel.appendChild(highlightCard);
  }

  panel.append(
    createElement("div", {
      text: `${uiCopy.progressLabel}: ${result.score}%`,
      style: "font-size:16px;font-weight:bold;color:#7a4b00;margin-bottom:8px;",
    }),
    createElement("div", {
      text: `${uiCopy.filledFramesLabel} ${result.progress?.filledFrames ?? 0} / ${result.progress?.totalFrames ?? 41} ${uiCopy.framesSuffix}`,
      style: "font-size:11px;color:#6b5a2c;margin-bottom:8px;",
    }),
    createElement("div", {
      text: result.coachMessage,
      style: "font-size:12px;line-height:1.6;color:#4a3a18;margin-bottom:8px;",
    })
  );

  const nextStepButton = createElement("button", {
    text: `${uiCopy.nextStepButtonPrefix}${result.recommendedFocus?.toolName || ""}`,
    style:
      "padding:7px 10px;margin-top:15px;margin-bottom:8px;cursor:pointer;background:#7a4b00;color:#fff;border:none;border-radius:8px;font-size:12px;",
  });
  nextStepButton.addEventListener("click", async () => {
    await zoomToFrame(result.recommendedFocus?.frameTitle);
  });

  panel.append(
    nextStepButton,
    createElement("div", {
      text: `${uiCopy.nextStepSentencePrefix} ${result.recommendedFocus?.frameTitle || ""}: ${result.recommendedFocus?.reason || ""}`,
      style: "font-size:12px;line-height:1.6;color:#4a3a18;margin-bottom:8px;",
    })
  );

  // Phase 2 placeholders (filled by updateDiagnosisAiContent)
  const auditPlaceholder = createElement("div", { id: "diagnosisAuditPlaceholder" });
  auditPlaceholder.appendChild(
    createElement("div", {
      text: uiCopy.logicAuditHeading + " ...",
      style: "font-size:11px;color:#a08060;margin-top:8px;margin-bottom:4px;",
    })
  );
  panel.appendChild(auditPlaceholder);

  const cardPlaceholder = createElement("div", { id: "diagnosisCardPlaceholder" });
  cardPlaceholder.appendChild(
    createElement("div", {
      text: "Analyzing card quality...",
      style: "font-size:11px;color:#a08060;margin-top:8px;",
    })
  );
  panel.appendChild(cardPlaceholder);
}

function updateDiagnosisAiContent(phase2) {
  const uiCopy = getDiagnosticsUiCopy(phase2.lang || "EN");

  const auditPlaceholder = document.getElementById("diagnosisAuditPlaceholder");
  if (auditPlaceholder) {
    auditPlaceholder.innerHTML = "";
    const suggestions = Array.isArray(phase2.logicAuditSuggestions)
      ? phase2.logicAuditSuggestions
      : [];
    if (suggestions.length > 0) {
      auditPlaceholder.appendChild(
        createElement("div", {
          text: uiCopy.logicAuditHeading,
          style: "font-size:11px;font-weight:bold;color:#7a4b00;margin-bottom:6px;",
        })
      );
      const auditList = createElement("div", {
        style: "display:flex;flex-direction:column;gap:6px;",
      });
      for (const suggestion of suggestions) {
        auditList.appendChild(
          createElement("div", {
            text: suggestion,
            style: "font-size:11px;line-height:1.5;color:#5c4a20;",
          })
        );
      }
      auditPlaceholder.appendChild(auditList);
    }
  }

  const cardPlaceholder = document.getElementById("diagnosisCardPlaceholder");
  if (cardPlaceholder) {
    cardPlaceholder.innerHTML = "";
    renderCardAnalyses(cardPlaceholder, phase2.cardAnalyses ?? []);
  }
}

async function insertStickyNote(text, frameTitle) {
  console.log("Action Triggered: handleInsert");
  setStatus("Inserting sticky note...", "neutral");

  try {
    console.log(`[Toolboard GPT] Attempting to insert into frame: ${frameTitle || "(empty)"}`);

    if (!frameTitle) {
      setStatus("The target frame was not found on the board. Please check whether the frame title has been changed.", "warning");
      return;
    }

    const { frame, matchCount, matchedBy } = await resolveTargetFrame(frameTitle);
    if (!frame) {
      renderFrameWarning(frameTitle);
      setStatus("The target frame was not found on the board. Please check whether the frame title has been changed.", "warning");
      return;
    }

    console.log(
      `[Toolboard GPT] Frame match resolved. matchedBy=${matchedBy}, matchCount=${matchCount}, frameId=${frame.id}`
    );

    const items = await miro.board.get({ type: "sticky_note" });
    const inside = items.filter(
      (item) => item.parentId === frame.id || isItemInsideFrame(item, frame)
    );
    const stickyWidth = 220;
    const horizontalGap = 32;
    const verticalGap = 28;
    const stickyHeight = 120;
    const centerColumns = 3;
    const column = inside.length % centerColumns;
    const row = Math.floor(inside.length / centerColumns);
    const columnOffset = (column - 1) * (stickyWidth + horizontalGap);
    const rowOffset = row * (stickyHeight + verticalGap);
    const x = frame.x + columnOffset;
    const y = frame.y - 40 + rowOffset;

    console.log(
      `[Toolboard GPT] Creating sticky note at x=${x}, y=${y}, based on frame center x=${frame.x}, y=${frame.y}`
    );

    const sticky = await miro.board.createStickyNote({
      content: text,
      x,
      y,
      width: stickyWidth,
    });

    if (sticky) {
      try {
        if ("parentId" in sticky) {
          sticky.parentId = frame.id;
        }
        if (typeof sticky.sync === "function") {
          await sticky.sync();
        }
      } catch (attachError) {
        console.warn(
          `[Toolboard GPT] Sticky note was created but could not be attached to frame ${frame.id}. Falling back to geometric placement only.`,
          attachError
        );
      }
    }

    if (sticky?.id) {
      verifiedNoteIds.add(sticky.id);
      systemGeneratedNoteIds.add(sticky.id);
    }
    await miro.board.viewport.zoomTo(sticky);
    setStatus(`Inserted into ${frameTitle}`, "success");
  } catch (error) {
    console.error("[Toolboard GPT] Insert sticky note failed.", error);
    setErrorMessage(
      error?.message
        ? `Insert failed: ${error.message}`
        : "Insert failed. Please check the browser console.",
    );
  }
}

async function handlePreview() {
  console.log("Action Triggered: handlePreview");
  setLoadingState(false);
  const previewContent = document.getElementById("boardPreviewContent");

  resetActionUiState("preview");
  setLoadingState(true);
  setStatus("Loading preview...", "neutral");

  try {
    const toolSelect = document.getElementById("toolSelect");
    const qSelect = document.getElementById("qSelect");
    const boardData = await readFullBoard();
    const preferredLanguage = detectPreferredQuestionLanguage(
      boardData,
      Number(toolSelect?.value),
      qSelect?.value || ""
    );
    updatePreviewCopy(preferredLanguage || "EN");
    previewContent.textContent = formatBoardPreview(boardData);
    setStatus("Preview loaded.", "success");
  } catch (error) {
    console.error(error);
    setViewMode("none");
    setErrorMessage(error?.message || "Failed to read board.");
  } finally {
    setLoadingState(false);
  }
}

async function handleAnalyse() {
  console.log("Action Triggered: handleAnalyse");
  setLoadingState(false);
  resetActionUiState("analysis");
  setSuggestionsVisible(true);
  setLoadingState(true);
  setStatus("Preparing analysis...", "neutral");
  renderSuggestionLoading("Reading the board and preparing suggestions...");

  try {
    const toolSelect = document.getElementById("toolSelect");
    const qSelect = document.getElementById("qSelect");
    const toolId = Number(toolSelect.value);
    const qId = qSelect.value;
    const boardId = await getCurrentBoardId();
    const tool = QUESTION_BANK.find((entry) => entry.toolId === toolId);
    const question = tool?.questions.find((entry) => entry.qId === qId);
    const boardData = await readFullBoard();
    const missingFrames = collectMissingFrames(boardData);
    const selectedTool = boardData.find((entry) => entry.toolId === toolId);
    const selectedQuestion = selectedTool?.questions.find((entry) => entry.qId === qId);
    const preferredLanguage = detectPreferredQuestionLanguage(
      boardData,
      toolId,
      qId
    );

    if (!selectedQuestion?.found) {
      renderFrameWarning(question?.anchorFrameTitle ?? "");
      setStatus(
        `Frame "${question?.anchorFrameTitle ?? ""}" was not found. Create it before requesting suggestions.`,
        "warning"
      );
      return;
    }

    const payload = {
      boardId,
      mode: "single",
      toolId,
      toolName: tool?.toolName,
      toolDescription: tool?.toolDescription,
      focusQuestion: {
        qId,
        label: question?.label ?? "",
        anchorFrameTitle: question?.anchorFrameTitle ?? "",
      },
      preferredLanguage,
      boardContext: boardData,
    };

    setStatus("Requesting suggestions...", "neutral");
    console.log("Sending board context:", payload);
    const response = await fetchJson("/api/suggest", payload);
    renderSuggestions(response.suggestions ?? [], question?.anchorFrameTitle ?? "");
    setStatus(
      missingFrames.length > 0
        ? `${(response.suggestions ?? []).length} suggestion(s) generated. ${missingFrames.length} unrelated frame(s) are still missing from the board.`
        : `${(response.suggestions ?? []).length} suggestion(s) generated.`,
      missingFrames.length > 0 ? "warning" : "success"
    );
  } catch (error) {
    console.error(error);
    document.getElementById("suggestions").innerHTML = "";
    setErrorMessage(error?.message || "Analysis failed.");
  } finally {
    setLoadingState(false);
  }
}

async function handleProjectReview() {
  console.log("Action Triggered: handleProjectReview");
  setLoadingState(false);
  resetActionUiState("analysis");
  setSuggestionsVisible(true);
  setLoadingState(true);
  setStatus("Reading full board for diagnosis...", "neutral");

  let boardId, boardData;
  try {
    boardId = await getCurrentBoardId();
    boardData = await readFullBoard();
  } catch (error) {
    console.error(error);
    setErrorMessage(error?.message || "Failed to read board.");
    setLoadingState(false);
    return;
  }

  // Phase 1: fast (score, progress, recommended focus ~2s)
  let phase1;
  try {
    phase1 = await fetchJson("/api/diagnose", { boardId, boardContext: boardData });
    renderDiagnosis(phase1);
  } catch (error) {
    console.error(error);
    hideDiagnosisPanel();
    setErrorMessage(error?.message || "Diagnosis failed.");
    setLoadingState(false);
    return;
  }

  setLoadingState(false);
  setStatus("Analyzing board logic and card quality...", "neutral");

  // Phase 2: AI analysis (logic audit + card rewrites, ~8-10s)
  try {
    const phase2 = await fetchJson("/api/diagnose/details", {
      boardId,
      boardContext: boardData,
      lang: phase1.lang,
    });
    updateDiagnosisAiContent(phase2);
    setStatus(
      "Diagnosis complete.",
      phase2.ragStatus === "offline" ? "warning" : "success"
    );
  } catch (error) {
    console.error(error);
    updateDiagnosisAiContent({ logicAuditSuggestions: [], cardAnalyses: [], lang: phase1.lang });
    setStatus("AI analysis incomplete. Core diagnosis shown.", "warning");
  }
}

function bindUI() {
  const toolSelect = document.getElementById("toolSelect");
  toolSelect.addEventListener("change", () => {
    populateQuestionOptions(Number(toolSelect.value));
    resetActionUiState("none");
  });

  document.getElementById("qSelect").addEventListener("change", () => {
    resetActionUiState("none");
  });

  document.getElementById("btnPreview").addEventListener("click", handlePreview);
  document.getElementById("btnAnalyse").addEventListener("click", handleAnalyse);
  document.getElementById("btnDiagnose").addEventListener("click", handleProjectReview);
}

ensureUI();
populateToolOptions();
populateQuestionOptions(QUESTION_BANK[0].toolId);
updatePreviewCopy("EN");
updateSystemStatus("online");
bindUI();

