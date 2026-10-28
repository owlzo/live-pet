/**
 * 控制台页面骨架：只有一个挂载壳，所有视图由 app.js 在浏览器里生成。
 *
 * CSP 收紧到 self：脚本、样式、素材全部同源，不引任何 CDN。
 * 不内联脚本：便于把权限（令牌）与渲染逻辑分开审查。
 * @module live-pet/src/console/page
 */
export const consolePage = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'">
<title>live-pet 控制台</title>
<link rel="stylesheet" href="/console/app.css">
</head><body>
<div class="app">
  <aside class="side">
    <div class="brand"><b>live-pet</b><span>直播陪伴控制台</span></div>
    <nav class="nav" id="nav"></nav>
    <div class="side-foot" id="foot"></div>
  </aside>
  <main class="main">
    <header class="topbar">
      <div>
        <h1 id="title">概览</h1>
        <p class="sub" id="subtitle">正在读取配置…</p>
      </div>
      <div class="top-actions" id="actions"></div>
    </header>
    <section class="view" id="view"></section>
  </main>
</div>
<div class="toast" id="toast"></div>
<script src="/console/app.js"></script>
</body></html>`;
