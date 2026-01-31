import './assets/style.css';

function ensureUI() {
  // 如果你的 app.html 已经有按钮/输出区，这段不会破坏；
  // 如果还没有，这段会自动插入最小 UI，保证可见可测。
  if (!document.getElementById('poc2-root')) {
    const root = document.createElement('div');
    root.id = 'poc2-root';
    root.style.padding = '12px';
    root.style.fontFamily = 'Arial, sans-serif';

    root.innerHTML = `
      <h3 style="margin:0 0 6px 0;">PoC2（Canvas → GPT）</h3>
      <div style="color:#666;font-size:12px;margin-bottom:10px;">
        先在白板选中一个便签/文本框，再点击读取。
      </div>
      <button id="btnRead" style="padding:8px 10px; cursor:pointer;">读取选中内容</button>

      <div style="margin-top:10px;padding:10px;border:1px solid #ddd;border-radius:8px;">
        <div><b>Selection:</b> <span id="selInfo">（未读取）</span></div>
        <div style="margin-top:8px;"><b>Text:</b></div>
        <pre id="selText" style="white-space:pre-wrap;word-break:break-word;margin:6px 0 0 0;">(empty)</pre>
      </div>
    `;
    document.body.appendChild(root);
  }
}

function stripHtml(html) {
  return String(html).replace(/<[^>]*>/g, ' ');
}

function extractTextFromItem(item) {
  const candidates = [
    item.text,
    item.title,
    item.label,
    item.content,   // 经常是 HTML
    item.plainText,
  ].filter(Boolean);

  if (candidates.length === 0) return '';
  return stripHtml(candidates[0]).trim();
}

async function readSelectionAndRender() {
  const selInfoEl = document.getElementById('selInfo');
  const selTextEl = document.getElementById('selText');

  const items = await miro.board.getSelection();

  if (!items || items.length === 0) {
    selInfoEl.textContent = '未选中任何元素';
    selTextEl.textContent = '(empty)';
    return;
  }

  const first = items[0];
  const text = extractTextFromItem(first);

  selInfoEl.textContent = `type=${first.type || 'unknown'}, id=${first.id || 'unknown'} (selected ${items.length})`;
  selTextEl.textContent = text || '(no text found)';
}

function bindUI() {
  const btn = document.getElementById('btnRead');
  btn.addEventListener('click', async () => {
    try {
      await readSelectionAndRender();
    } catch (e) {
      console.error(e);
      document.getElementById('selInfo').textContent = '读取失败（看 console）';
      document.getElementById('selText').textContent = String(e);
    }
  });
}

// ✅ PoC2：只初始化 UI 和事件，不做任何自动写入
ensureUI();
bindUI();
