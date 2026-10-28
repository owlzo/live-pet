#!/usr/bin/env node
/**
 * 控制台冒烟探针：用 Electron 无头加载 /console/，逐个点页签并收集运行时错误。
 *
 * 为什么需要它：控制台是单文件内联脚本，语法错误/空引用会让整页静默变白，
 * 而服务端接口全 200——只看 curl 发现不了。这个探针把「页面是否真的渲染出来」变成可断言的结果。
 * 不截图、不写盘、不改配置。
 *
 * 用法：先启动应用，然后 `npm run probe:console`（端口默认 18080，可用 LIVE_PET_PORT 覆盖）。
 * @module live-pet/scripts/console-probe
 */
const { app, BrowserWindow } = require('electron');

const PORT = Number(process.env.LIVE_PET_PORT || 18080);
const URL_BASE = `http://127.0.0.1:${PORT}/console/`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900 });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });

  let failed = false;
  try {
    await win.loadURL(URL_BASE);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const report = await win.webContents.executeJavaScript(`(async () => {
      const out = [];
      for (const button of Array.from(document.querySelectorAll('#nav button'))) {
        button.click();
        await new Promise((r) => setTimeout(r, 250));
        out.push({
          tab: button.textContent.trim(),
          cards: document.querySelectorAll('#view .card').length,
          chars: (document.getElementById('view').textContent || '').length
        });
      }
      return out;
    })()`);
    for (const tab of report) {
      const ok = tab.cards > 0 && tab.chars > 40;
      if (!ok) failed = true;
      console.log(`${ok ? '✓' : '✗'} ${tab.tab}  卡片 ${tab.cards} · 文本 ${tab.chars} 字`);
    }
  } catch (error) {
    failed = true;
    console.log(`✗ 加载失败：${error && error.message}`);
  }

  if (errors.length > 0) {
    failed = true;
    console.log(`✗ 页面报错 ${errors.length} 条：`);
    for (const message of errors.slice(0, 5)) console.log('  ' + message);
  }
  console.log(failed ? '控制台探针：失败' : '控制台探针：通过');
  app.exit(failed ? 1 : 0);
});
