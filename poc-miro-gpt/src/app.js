// src/app.js
import "./assets/style.css";
import { QUESTION_BANK } from "./questions.js";

/**
 * PoC2 (Tool2) - Explicit selector + human-in-the-loop
 * - Panel: select Tool + Question
 * - Generate suggestions (Mock for now)
 * - User accepts one -> insert sticky into specific anchor Frame
 * - Stable placement inside frame + auto layout
 * - UI simplified: removed "Read selection" button and selection/user text debug box
 */

// ---------- Config: layout inside Frame ----------
const STICKY_W = 220; // 贴纸近似宽度（用于排版估算）
const STICKY_H = 140; // 贴纸近似高度（用于排版估算）
const PADDING = 40; // Frame 内边距
const GAP_X = 30; // 横向间距
const GAP_Y = 30; // 纵向间距

// 每个 Tool 记录已插入数量，用于排版 index
const insertedCountByTool = new Map(); // toolId -> count

// ---------- UI ----------
function ensureUI() {
  if (document.getElementById("poc2-root")) return;

  const root = document.createElement("div");
  root.id = "poc2-root";
  root.style.padding = "12px";
  root.style.fontFamily = "Arial, sans-serif";

  root.innerHTML = `
    <h3 style="margin:0 0 8px 0;">PoC2（Tool 2 测试）</h3>

    <div style="font-size:12px;color:#666;margin-bottom:10px; line-height:1.4;">
      说明：请在白板上为 Tool2 区域创建一个 Frame，并命名为
      <b>TB_TOOL_2_ANCHOR</b>。<br/>
      当你采纳建议时，贴纸将稳定插入到该 Frame 内部（Human-in-the-loop）。
    </div>

    <div style="display:flex; gap:8px; margin-bottom:10px;">
      <div style="flex:1;">
        <div style="font-size:12px; color:#666; margin-bottom:4px;">Tool</div>
        <select id="toolSelect" style="width:100%; padding:6px;"></select>
      </div>
      <div style="flex:2;">
        <div style="font-size:12px; color:#666; margin-bottom:4px;">
          Focus / Question（选择你希望系统按哪个维度帮助）
        </div>
        <select id="qSelect" style="width:100%; padding:6px;"></select>
      </div>
    </div>

    <div style="display:flex; gap:8px; margin-bottom:10px;">
      <button id="btnSuggest" style="padding:8px 10px; cursor:pointer;">
        生成建议（Mock）
      </button>
      <button id="btnResetLayout" style="padding:8px 10px; cursor:pointer;">
        重置排版计数
      </button>
    </div>

    <div style="border:1px solid #ddd; border-radius:8px; padding:10px;">
      <div style="display:flex; align-items:center; justify-content:space-between;">
        <b>Suggestions</b>
        <span id="status" style="font-size:12px;color:#666;"></span>
      </div>

      <div
        id="suggestions"
        style="
          margin-top:8px;
          max-height:320px;
          overflow-y:auto;
          padding-right:6px;
          border-top:1px dashed #eee;
          padding-top:8px;
        "
      ></div>
    </div>
  `;

  document.body.appendChild(root);
}

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
  const questions = tool?.questions ?? [];

  for (const q of questions) {
    const opt = document.createElement("option");
    opt.value = q.qId;
    opt.textContent = q.label.length > 90 ? q.label.slice(0, 90) + "…" : q.label;
    opt.title = q.label;
    qSel.appendChild(opt);
  }
}

function getSelectedToolAndQuestion() {
  const toolId = Number(document.getElementById("toolSelect").value);
  const qId = document.getElementById("qSelect").value;

  const tool = QUESTION_BANK.find((t) => t.toolId === toolId) ?? null;
  const q = tool?.questions.find((qq) => qq.qId === qId) ?? null;

  return { toolId, tool, qId, q };
}

// ---------- Suggest (Mock now, GPT later) ----------
function buildMockSuggestions({ toolName, questionText }) {
  const base = [
    "把观察写成“事实/行为/情绪/需求”四列：先列出3条具体事实，再推断可能的需求（每条推断都要能回到事实）。",
    "补充一条“反例/矛盾观察”：有没有人并不在意该问题？为什么（避免单一视角）。",
    "把观察改成可验证表述：加入场景、频率、对象（例如：在X场景中，Y人群每周Z次表现出…）。",
  ];

  return base.map((s, i) => ({
    id: `s${i + 1}`,
    text: `【${toolName}｜建议 ${i + 1}】\nFocus: ${questionText}\n\n${s}`,
  }));
}

function renderSuggestions(list) {
  const wrap = document.getElementById("suggestions");
  wrap.innerHTML = "";

  if (!list || list.length === 0) {
    wrap.textContent = "(empty)";
    return;
  }

  for (const s of list) {
    const card = document.createElement("div");
    card.style.border = "1px solid #eee";
    card.style.borderRadius = "10px";
    card.style.padding = "10px";
    card.style.marginBottom = "8px";

    const pre = document.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.wordBreak = "break-word";
    pre.style.margin = "0 0 8px 0";
    pre.textContent = s.text;

    const btn = document.createElement("button");
    btn.textContent = "采纳并插入到 Tool2（贴纸）";
    btn.style.padding = "8px 10px";
    btn.style.cursor = "pointer";

    btn.addEventListener("click", async () => {
      await acceptSuggestionAndInsertSticky(s.text);
    });

    card.appendChild(pre);
    card.appendChild(btn);
    wrap.appendChild(card);
  }
}

// ---------- Anchor frame + placement ----------
async function findAnchorFrameByTitle(title) {
  const frames = await miro.board.get({ type: "frame" });
  const frame = frames.find((f) => f.title === title);
  if (!frame) {
    throw new Error(
      `未找到锚点 Frame：${title}\n请在白板上创建/重命名 Frame 为该名字。`
    );
  }
  return frame;
}

function computePositionInsideFrame(frame, index) {
  const left = frame.x - frame.width / 2;
  const top = frame.y - frame.height / 2;

  const usableW = Math.max(0, frame.width - PADDING * 2);
  const colWidth = STICKY_W + GAP_X;

  const cols = Math.max(1, Math.floor((usableW + GAP_X) / colWidth));
  const col = index % cols;
  const row = Math.floor(index / cols);

  const x = left + PADDING + col * colWidth;
  const y = top + PADDING + row * (STICKY_H + GAP_Y);

  return { x, y };
}

function nextIndexForTool(toolId) {
  const current = insertedCountByTool.get(toolId) ?? 0;
  insertedCountByTool.set(toolId, current + 1);
  return current;
}

// ---------- Insert sticky after user accepts ----------
async function acceptSuggestionAndInsertSticky(text) {
  const status = document.getElementById("status");
  status.textContent = "正在插入贴纸…";

  try {
    const { toolId, tool } = getSelectedToolAndQuestion();
    const anchorTitle = tool?.anchorFrameTitle ?? "TB_TOOL_2_ANCHOR";

    const frame = await findAnchorFrameByTitle(anchorTitle);
    const idx = nextIndexForTool(toolId);
    const { x, y } = computePositionInsideFrame(frame, idx);

    const sticky = await miro.board.createStickyNote({
      content: text,
      x,
      y,
    });

    await miro.board.viewport.zoomTo(sticky);
    status.textContent = `已插入到 ${anchorTitle} ✅`;
  } catch (e) {
    console.error(e);
    status.textContent = "插入失败（看 console）";
    alert(String(e?.message ?? e));
  }
}

// ---------- Bind events ----------
function bindUI() {
  const toolSel = document.getElementById("toolSelect");
  toolSel.addEventListener("change", () => {
    populateQuestionOptions(Number(toolSel.value));
  });

  document.getElementById("btnSuggest").addEventListener("click", async () => {
    try {
      document.getElementById("status").textContent = "";
      const { tool, q } = getSelectedToolAndQuestion();

      const toolName = tool?.toolName ?? "Unknown Tool";
      const questionText = q?.label ?? "Unknown focus";

      const suggestions = buildMockSuggestions({ toolName, questionText });
      renderSuggestions(suggestions);
    } catch (e) {
      console.error(e);
      document.getElementById("suggestions").textContent = String(e);
    }
  });

  document.getElementById("btnResetLayout").addEventListener("click", () => {
    const { toolId } = getSelectedToolAndQuestion();
    insertedCountByTool.set(toolId, 0);
    document.getElementById("status").textContent = "已重置当前 Tool 的排版计数";
  });
}

// ---------- Init ----------
ensureUI();
populateToolOptions();
populateQuestionOptions(QUESTION_BANK[0].toolId);
bindUI();
