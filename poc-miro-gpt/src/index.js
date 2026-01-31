// src/index.js
// 点击 Miro 顶部 App 图标时，打开面板（app.html）
miro.board.ui.on("icon:click", async () => {
  await miro.board.ui.openPanel({ url: "app.html" });
});
