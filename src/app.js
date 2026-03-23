// src/app.js
import "./assets/style.css";
import { QUESTION_BANK } from "./questions.js";

// ✅ 注册 icon:click，让 App 图标出现在 Miro 工具栏
miro.board.ui.on("icon:click", async () => {
  await miro.board.ui.openPanel({ url: "/app.html" });
});

// ---------- Config ----------
const BACKEND_URL = "http://localhost:8787";

// ---------- UI ----------
function ensureUI() {
  if (document.getElementById("tb-root")) return;

  const root = document.createElement("div");
  root.id = "tb-root";
  root.style.cssText = "padding:12px; font-family:Arial,sans-serif;";

  root.innerHTML = `
    <h3 style="margin:0 0 8px 0;font-size:14px;">🧠 Toolboard GPT</h3>

    <!-- Tool selector -->
    <div style="margin-bottom:6px;">
      <div style="font-size:11px;color:#666;margin-bottom:2px;">Tool</div>
      <select id="toolSelect" style="width:100%;padding:4px;font-size:12px;"></select>
    </div>

    <!-- Question selector -->
    <div style="margin-bottom:8px;">
      <div style="font-size:11px;color:#666;margin-bottom:2px;">Focus Question</div>
      <select id="qSelect" style="width:100%;padding:4px;font-size:12px;"></select>
    </div>

    <!-- Buttons -->
    <div style="display:flex;gap:6px;margin-bottom:6px;">
      <button id="btnAnalyse" style="
        flex:1;padding:7px;cursor:pointer;
        background:#4262ff;color:#fff;
        border:none;border-radius:8px;font-size:13px;
      ">
        ✨ Analyse
      </button>
      <button id="btnPreview" style="
        padding:7px;cursor:pointer;
        background:#f0f0f0;border:none;
        border-radius:8px;font-size:11px;
      ">
        📋 Preview
      </button>
    </div>

    <!-- Status -->
    <div id="status" style="font-size:11px;color:#888;margin-bottom:6px;min-height:16px;"></div>

    <!-- Board preview -->
    <div id="boardPreview" style="display:none;margin-bottom:8px;">
      <div style="font-size:11px;font-weight:bold;margin-bottom:2px;">Board Preview</div>
      <pre id="boardPreviewContent" style="
        font-size:10px;
        background:#f9f9f9;
        border:1px solid #eee;
        border-radius:6px;
        padding:6px;
        max-height:120px;
        overflow-y:auto;
        white-space:pre-wrap;
        word-break:break-word;
      "></pre>
    </div>

    <!-- Suggestions -->
    <div style="border:1px solid #ddd;border-radius:8px;padding:8px;">
      <b style="font-size:12px;">Suggestions</b>
      <div id="suggestions" style="
        margin-top:6px;
        max-height:calc(100vh - 280px);
        overflow-y:auto;
        padding-right:4px;
        padding-bottom:20px;
      "></div>
    </div>
  `;

  document.body.appendChild(root);
}

// ---------- Populate selectors ----------
function populateToolOptions() {
  const toolSel = document.getElementById("toolSelect");
  toolSel.innerHTML = "";
  for (const tool of QUESTION_BANK) {
    const opt = document.createElement("option");
    opt.value = String(tool.toolId);
    opt.textContent = tool.toolName;
    toolSel.appendChild(opt);
  }
}

function populateQuestionOptions(toolId) {
  const qSel = document.getElementById("qSelect");
  qSel.innerHTML = "";
  const tool = QUESTION_BANK.find((t) => t.toolId === toolId);
  for (const q of tool?.questions ?? []) {
    const opt = document.createElement("option");
    opt.value = q.qId;
    opt.textContent = q.label.length > 80 ? q.label.slice(0, 80) + "…" : q.label;
    opt.title = q.label;
    qSel.appendChild(opt);
  }
}

// ---------- Read board ----------

// Read sticky notes inside a specific frame using parentId
async function readFrameContent(frameTitle) {
  const frames = await miro.board.get({ type: "frame" });
  const frame = frames.find((f) => f.title === frameTitle);
  if (!frame) return null;

  const items = await miro.board.get({ type: ["sticky_note", "text"] });

  // Filter by parentId instead of coordinates
  const inside = items.filter((it) => it.parentId === frame.id);

  return inside
    .map((it) => {
      const raw = (it.content || it.text || "").toString().trim();
      const clean = raw.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
      return clean;
    })
    .filter(Boolean);
}

// Read ALL tools from the entire board
async function readFullBoard() {
  const results = [];
  for (const tool of QUESTION_BANK) {
    const toolResult = {
      toolId: tool.toolId,
      toolName: tool.toolName,
      toolDescription: tool.toolDescription,
      questions: [],
    };

    for (const q of tool.questions) {
      const notes = await readFrameContent(q.anchorFrameTitle);
      toolResult.questions.push({
        qId: q.qId,
        label: q.label,
        anchorFrameTitle: q.anchorFrameTitle,
        notes: notes ?? [],
        found: notes !== null,
      });
    }

    results.push(toolResult);
  }
  return results;
}

// Format board for preview display
function formatBoardPreview(boardData) {
  return boardData
    .map((tool) => {
      const qLines = tool.questions
        .map((q) => {
          const notesText =
            q.notes.length > 0
              ? q.notes.map((n) => `    • ${n}`).join("\n")
              : "    (empty)";
          return `  [${q.anchorFrameTitle}]\n${notesText}`;
        })
        .join("\n");
      return `=== ${tool.toolName} ===\n${qLines}`;
    })
    .join("\n\n");
}

// ---------- Backend API ----------
async function fetchSuggestions(payload) {
  const resp = await fetch(`${BACKEND_URL}/api/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  return data?.suggestions ?? [];
}

// ---------- Render suggestions ----------
function renderSuggestions(suggestions, targetFrameTitle) {
  const wrap = document.getElementById("suggestions");
  wrap.innerHTML = "";

  if (!suggestions || suggestions.length === 0) {
    wrap.innerHTML = `<div style="color:#999;font-size:13px;padding:8px 0;">(No suggestions returned)</div>`;
    return;
  }

  for (const s of suggestions) {
    const card = document.createElement("div");
    card.style.cssText = `
      border:1px solid #eee;
      border-radius:10px;
      padding:10px;
      margin-bottom:8px;
      background:#fafafa;
    `;

    const title = document.createElement("div");
    title.style.cssText = "font-weight:bold;font-size:13px;margin-bottom:6px;color:#333;";
    title.textContent = s.title || "Suggestion";

    const content = document.createElement("div");
    content.style.cssText = `
      font-size:12px;
      color:#444;
      margin-bottom:8px;
      line-height:1.5;
      white-space:pre-wrap;
      word-break:break-word;
    `;
    content.textContent = s.content || s.text || "";

    const btn = document.createElement("button");
    btn.textContent = "📌 Insert as Sticky Note";
    btn.style.cssText = `
      padding:6px 10px;
      cursor:pointer;
      background:#4262ff;
      color:#fff;
      border:none;
      border-radius:6px;
      font-size:12px;
    `;
    btn.addEventListener("click", async () => {
      await insertStickyNote(s.content || s.text || "", targetFrameTitle);
    });

    card.appendChild(title);
    card.appendChild(content);
    card.appendChild(btn);
    wrap.appendChild(card);
  }
}

// ---------- Insert sticky note ----------
async function insertStickyNote(text, frameTitle) {
  const status = document.getElementById("status");
  status.textContent = "Inserting sticky note…";

  try {
    const frames = await miro.board.get({ type: "frame" });
    const frame = frames.find((f) => f.title === frameTitle);

    let x = 0;
    let y = 0;

    if (frame) {
      const items = await miro.board.get({ type: "sticky_note" });
      const inside = items.filter((it) => it.parentId === frame.id);

      const col = inside.length % 3;
      const row = Math.floor(inside.length / 3);
      x = frame.x - frame.width / 2 + 40 + col * 250;
      y = frame.y - frame.height / 2 + 40 + row * 150;
    }

    const sticky = await miro.board.createStickyNote({ content: text, x, y });
    await miro.board.viewport.zoomTo(sticky);
    status.textContent = `✅ Inserted into ${frameTitle}`;
  } catch (e) {
    console.error(e);
    status.textContent = "❌ Insert failed (see console)";
  }
}

// ---------- Bind events ----------
function bindUI() {
  const toolSel = document.getElementById("toolSelect");

  // Tool change → update questions
  toolSel.addEventListener("change", () => {
    populateQuestionOptions(Number(toolSel.value));
  });

  // Preview button
  document.getElementById("btnPreview").addEventListener("click", async () => {
    const status = document.getElementById("status");
    const preview = document.getElementById("boardPreview");
    const previewContent = document.getElementById("boardPreviewContent");

    status.textContent = "Reading board…";
    preview.style.display = "none";

    try {
      const boardData = await readFullBoard();
      previewContent.textContent = formatBoardPreview(boardData);
      preview.style.display = "block";
      status.textContent = "✅ Board read complete";
    } catch (e) {
      console.error(e);
      status.textContent = "❌ Failed to read board";
    }
  });

  // Analyse button
  document.getElementById("btnAnalyse").addEventListener("click", async () => {
    const status = document.getElementById("status");
    status.textContent = "";
    document.getElementById("suggestions").innerHTML = "";

    try {
      const toolId = Number(toolSel.value);
      const qId = document.getElementById("qSelect").value;
      const tool = QUESTION_BANK.find((t) => t.toolId === toolId);
      const q = tool?.questions.find((qq) => qq.qId === qId);

      // Step 1: Read entire board
      status.textContent = "📋 Reading full board…";
      const fullBoardData = await readFullBoard();

      // Step 2: Send full board + focus question to backend
      status.textContent = "🧠 Requesting AI suggestions…";

      const payload = {
        mode: "single",
        toolId,
        toolName: tool.toolName,
        toolDescription: tool.toolDescription,
        focusQuestion: {
          qId,
          label: q?.label ?? "",
          anchorFrameTitle: q?.anchorFrameTitle ?? "",
        },
        // ✅ Always send full board context
        boardContext: fullBoardData,
      };

      const suggestions = await fetchSuggestions(payload);
      renderSuggestions(suggestions, q?.anchorFrameTitle ?? "");
      status.textContent = `✅ ${suggestions.length} suggestion(s) generated`;
    } catch (e) {
      console.error(e);
      status.textContent = "❌ Analysis failed (see console)";
      document.getElementById("suggestions").innerHTML = `
        <pre style="color:red;font-size:11px;">${e?.message ?? e}</pre>
      `;
    }
  });
}

// ---------- Init ----------
ensureUI();
populateToolOptions();
populateQuestionOptions(QUESTION_BANK[0].toolId);
bindUI();