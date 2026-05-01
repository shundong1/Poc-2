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

function normalizeTitle(value = "") {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractPlainText(item) {
  const raw = (item.content || item.text || "").toString().trim();
  return raw.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
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
  if (lang === "ZH") return "逻辑质量预警";
  if (lang === "ES") return "Alerta de calidad logica";
  return "Logic quality alert";
}

function getApplyLabel(lang = "EN") {
  if (lang === "ZH") return "应用改写";
  if (lang === "ES") return "Aplicar reescritura";
  return "Apply rewrite";
}

function getOptimizeCardLabel(lang = "EN") {
  if (lang === "ZH") return "Optimize this card";
  if (lang === "ES") return "Optimizar esta tarjeta";
  return "Optimize this card";
}

function getNoIssueLabel(lang = "EN") {
  if (lang === "ZH") return "No major issue detected.";
  if (lang === "ES") return "No se detecto ningun problema importante.";
  return "No major issue detected.";
}

function ensureUI() {
  if (document.getElementById("tb-root")) return;

  const root = createElement("div", {
    id: "tb-root",
    style:
      "padding:12px;font-family:Arial,sans-serif;box-sizing:border-box;height:100vh;overflow-y:auto;",
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
    text: "全局进度诊断",
    style:
      "width:100%;padding:10px 12px;margin-bottom:10px;cursor:pointer;background:#102a43;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:bold;",
  });

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
    }),
    createElement("button", {
      id: "btnAudit",
      text: "Read Test",
      style:
        "padding:7px;cursor:pointer;background:#e8f0fe;border:none;border-radius:8px;font-size:11px;",
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
      text: "Board Preview",
      style: "font-size:11px;font-weight:bold;margin-bottom:2px;",
    }),
    createElement("pre", {
      id: "boardPreviewContent",
      style:
        "font-size:10px;background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:6px;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;",
    })
  );

  const suggestionSection = createElement("div", {
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

  root.append(
    header,
    systemBar,
    diagnoseButton,
    toolBlock,
    questionBlock,
    buttonRow,
    status,
    previewWrap,
    suggestionSection
  );

  document.body.appendChild(root);
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
  const selectedItems =
    parentedItems.length > 0 ? parentedItems : insideButUnparentedItems;
  const noteDetails = selectedItems
    .map((item) => ({
      id: item.id,
      text: extractPlainText(item),
      widgetType: item.type || "sticky_note",
    }))
    .filter((entry) => entry.text);

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
    readMode: parentedItems.length > 0 ? "parentId" : noteDetails.length > 0 ? "geometry-fallback" : "empty",
  };
}

async function readFullBoard() {
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
      style: {
        backgroundColor: "light_green",
      },
    });
    return;
  }

  const stickyNotes = await miro.board.get({ type: "sticky_note" });
  const sticky = stickyNotes.find((entry) => entry.id === noteId);
  if (!sticky) {
    throw new Error("Target sticky note not found.");
  }

  sticky.content = rewrittenText;
  if (sticky.style) {
    sticky.style.fillColor = "light_green";
  } else {
    sticky.style = { fillColor: "light_green" };
  }

  if (typeof sticky.sync === "function") {
    await sticky.sync();
    return;
  }

  throw new Error("This Miro SDK version does not support sticky updates in the current code path.");
}

async function handleApplyRefinement(refinementTarget) {
  if (!refinementTarget?.canApply && !refinementTarget?.canOptimize) {
    return;
  }

  await applyRefinementToSticky(
    refinementTarget.noteId,
    refinementTarget.rewrittenText || refinementTarget.optimizedText
  );
  setStatus("Optimized text applied to the selected card.", "success");
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
      })
    );
    card.appendChild(metricsWrap);
  }

  if (qualityAlert.canApply) {
    const applyButton = createElement("button", {
      text: getApplyLabel(qualityAlert.lang),
      style:
        "padding:7px 10px;cursor:pointer;background:#2f8f46;color:#fff;border:none;border-radius:8px;font-size:12px;",
    });
    applyButton.addEventListener("click", async () => {
      try {
        await handleApplyRefinement(qualityAlert);
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
  if (!Array.isArray(cardAnalyses) || cardAnalyses.length === 0) {
    return;
  }

  panel.appendChild(
    createElement("div", {
      text: "Card-by-card writing quality review",
      style: "font-size:12px;font-weight:bold;color:#7a4b00;margin:12px 0 8px 0;",
    })
  );

  for (const analysis of cardAnalyses) {
    const hasIssue = Array.isArray(analysis.alerts) && analysis.alerts.length > 0;
    const primaryAlert = hasIssue ? analysis.alerts[0] : null;
    const card = createElement("div", {
      style:
        "border:1px solid #e7dcc0;border-radius:10px;padding:10px;margin-bottom:10px;background:#fffdf7;",
    });

    card.append(
      createElement("div", {
        text: hasIssue
          ? `${analysis.cardLabel}: Logic quality alert`
          : `${analysis.cardLabel}: ${getNoIssueLabel(analysis.lang)}`,
        style: `font-size:12px;font-weight:bold;margin-bottom:6px;color:${
          hasIssue ? "#8a4b00" : "#2f6b2f"
        };`,
      }),
      createElement("div", {
        text: `${analysis.toolName} | ${analysis.frameTitle}`,
        style: "font-size:11px;color:#7a6a4d;margin-bottom:8px;word-break:break-word;",
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
      })
    );
    card.appendChild(scoreWrap);

    if (primaryAlert) {
      card.append(
        createElement("div", {
          text: `Problem: ${primaryAlert.message}`,
          style: "font-size:12px;line-height:1.6;color:#5c3c00;margin-bottom:6px;",
        }),
        createElement("div", {
          text: `Why: ${primaryAlert.reason}`,
          style: "font-size:11px;line-height:1.6;color:#6d5b36;margin-bottom:8px;",
        })
      );
    }

    card.append(
      createElement("div", {
        text: "Original text",
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
          text: "Suggested optimization",
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
      const optimizeButton = createElement("button", {
        text: getOptimizeCardLabel(analysis.lang),
        style:
          "padding:7px 10px;cursor:pointer;background:#2f8f46;color:#fff;border:none;border-radius:8px;font-size:12px;",
      });
      optimizeButton.addEventListener("click", async () => {
        try {
          await handleApplyRefinement(analysis);
        } catch (error) {
          console.error(error);
          setStatus(error?.message || "Failed to optimize this card.", "error");
        }
      });
      card.appendChild(optimizeButton);
    }

    panel.appendChild(card);
  }
}

function renderDiagnosis(result) {
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
        text: result.isIntervention ? "建议优先调整路径" : "建议优先检查逻辑一致性",
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
      text: `当前进度：${result.score}%`,
      style: "font-size:16px;font-weight:bold;color:#7a4b00;margin-bottom:8px;",
    }),
    createElement("div", {
      text: `已填写 ${result.progress?.filledFrames ?? 0} / ${result.progress?.totalFrames ?? 41} 个 Frame`,
      style: "font-size:11px;color:#6b5a2c;margin-bottom:8px;",
    }),
    createElement("div", {
      text: result.coachMessage,
      style: "font-size:12px;line-height:1.6;color:#4a3a18;margin-bottom:8px;",
    })
  );

  const nextStepButton = createElement("button", {
    text: `建议完善：${result.recommendedFocus?.toolName || "下一步"}`,
    style:
      "padding:7px 10px;margin-top:15px;margin-bottom:8px;cursor:pointer;background:#7a4b00;color:#fff;border:none;border-radius:8px;font-size:12px;",
  });
  nextStepButton.addEventListener("click", async () => {
    await zoomToFrame(result.recommendedFocus?.frameTitle);
  });

  panel.append(
    nextStepButton,
    createElement("div", {
      text: `建议你下一步先处理 ${result.recommendedFocus?.frameTitle || ""}：${result.recommendedFocus?.reason || ""}`,
      style: "font-size:12px;line-height:1.6;color:#4a3a18;margin-bottom:8px;",
    })
  );

  if (
    Array.isArray(result.logicAuditSuggestions) &&
    result.logicAuditSuggestions.length > 0
  ) {
    panel.appendChild(
      createElement("div", {
        text: "逻辑一致性建议",
        style: "font-size:11px;font-weight:bold;color:#7a4b00;margin-bottom:6px;",
      })
    );

    const auditList = createElement("div", {
      style: "display:flex;flex-direction:column;gap:6px;",
    });
    for (const suggestion of result.logicAuditSuggestions) {
      auditList.appendChild(
        createElement("div", {
          text: suggestion,
          style: "font-size:11px;line-height:1.5;color:#5c4a20;",
        })
      );
    }
    panel.appendChild(auditList);
  }

  renderCardAnalyses(panel, result.cardAnalyses ?? []);
}

async function insertStickyNote(text, frameTitle) {
  setStatus("Inserting sticky note...", "neutral");

  try {
    const frames = await miro.board.get({ type: "frame" });
    const frame = frames.find((entry) => entry.title === frameTitle);
    if (!frame) {
      renderFrameWarning(frameTitle);
      setStatus(`Frame "${frameTitle}" was not found.`, "warning");
      return;
    }

    const items = await miro.board.get({ type: "sticky_note" });
    const inside = items.filter((item) => item.parentId === frame.id);
    const column = inside.length % 3;
    const row = Math.floor(inside.length / 3);
    const x = frame.x - frame.width / 2 + 40 + column * 250;
    const y = frame.y - frame.height / 2 + 40 + row * 150;
    const sticky = await miro.board.createStickyNote({ content: text, x, y });
    await miro.board.viewport.zoomTo(sticky);
    setStatus(`Inserted into ${frameTitle}`, "success");
  } catch (error) {
    console.error(error);
    setStatus("Insert failed. See console for details.", "error");
  }
}

function bindUI() {
  const toolSelect = document.getElementById("toolSelect");
  toolSelect.addEventListener("change", () => {
    populateQuestionOptions(Number(toolSelect.value));
  });

  document.getElementById("btnPreview").addEventListener("click", async () => {
    const preview = document.getElementById("boardPreview");
    const previewContent = document.getElementById("boardPreviewContent");

    setStatus("Reading board...", "neutral");
    preview.style.display = "none";
    hideDiagnosisPanel();

    try {
      const boardData = await readFullBoard();
      const missingFrames = collectMissingFrames(boardData);
      previewContent.textContent = formatBoardPreview(boardData);
      preview.style.display = "block";
      setStatus(
        missingFrames.length > 0
          ? `Board read complete. ${missingFrames.length} frame(s) are missing from the board.`
          : "Board read complete.",
        missingFrames.length > 0 ? "warning" : "success"
      );
    } catch (error) {
      console.error(error);
      setStatus("Failed to read board.", "error");
    }
  });

  document.getElementById("btnAudit").addEventListener("click", async () => {
    setStatus("Running board read test...", "neutral");
    document.getElementById("boardPreview").style.display = "none";

    try {
      const report = await runBoardReadAudit();
      const flagged = report.filter((entry) => entry.issue !== "ok");
      renderAuditReport(report);
      setStatus(
        flagged.length > 0
          ? `Read test complete. Found ${flagged.length} potential issue(s).`
          : "Read test complete. No obvious frame read issues found.",
        flagged.length > 0 ? "warning" : "success"
      );
    } catch (error) {
      console.error(error);
      setStatus("Read test failed.", "error");
    }
  });

  document.getElementById("btnAnalyse").addEventListener("click", async () => {
    setStatus("", "neutral");
    hideDiagnosisPanel();
    document.getElementById("suggestions").innerHTML = "";

    try {
      const toolId = Number(toolSelect.value);
      const qId = document.getElementById("qSelect").value;
      const tool = QUESTION_BANK.find((entry) => entry.toolId === toolId);
      const question = tool?.questions.find((entry) => entry.qId === qId);
      const boardData = await readFullBoard();
      const missingFrames = collectMissingFrames(boardData);
      const selectedTool = boardData.find((entry) => entry.toolId === toolId);
      const selectedQuestion = selectedTool?.questions.find((entry) => entry.qId === qId);

      if (!selectedQuestion?.found) {
        renderFrameWarning(question?.anchorFrameTitle ?? "");
        setStatus(
          `Frame "${question?.anchorFrameTitle ?? ""}" was not found. Create it before requesting suggestions.`,
          "warning"
        );
        return;
      }

      const payload = {
        mode: "single",
        toolId,
        toolName: tool?.toolName,
        toolDescription: tool?.toolDescription,
        focusQuestion: {
          qId,
          label: question?.label ?? "",
          anchorFrameTitle: question?.anchorFrameTitle ?? "",
        },
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
      setStatus(error?.message || "Analysis failed.", "error");
    }
  });

  document.getElementById("btnDiagnose").addEventListener("click", async () => {
    setStatus("Reading full board for diagnosis...", "neutral");
    document.getElementById("suggestions").innerHTML = "";

    try {
      const boardData = await readFullBoard();
      const payload = { boardContext: boardData };
      console.log("Sending board context:", payload);
      const response = await fetchJson("/api/diagnose", payload);
      renderDiagnosis(response);
      setStatus(
        "Diagnosis complete.",
        response.ragStatus === "offline" ? "warning" : "success"
      );
    } catch (error) {
      console.error(error);
      hideDiagnosisPanel();
      setStatus(error?.message || "Diagnosis failed.", "error");
    }
  });
}

ensureUI();
populateToolOptions();
populateQuestionOptions(QUESTION_BANK[0].toolId);
updateSystemStatus("online");
bindUI();
