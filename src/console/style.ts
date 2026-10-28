/**
 * 控制台样式：左侧固定导航 + 右侧全宽内容区，卡片按可用宽度自适应排布。
 *
 * 不做窄栏居中：内容区宽度 = 视口 - 导航，卡片用 auto-fill 填满，避免左右大片留白。
 * 深色配色与宠物气泡/菜单保持同一套观感（蓝灰底 + 亮蓝强调色）。
 * @module live-pet/src/console/style
 */
export const consoleStyle = `
:root{
  color-scheme:dark;
  --bg:#0e1014;--panel:#161a21;--panel2:#1d222b;--line:#2a303b;
  --ink:#e8ecf4;--muted:#94a0b2;--accent:#5b8cff;--accent2:#3f6fe0;
  --ok:#3ecf8e;--warn:#f0b429;--danger:#ef5b5b;--radius:12px;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--ink);font:14px/1.55 "Microsoft YaHei UI","PingFang SC",system-ui,-apple-system,sans-serif}
button,input,select,textarea{font:inherit;color:inherit}
.app{display:grid;grid-template-columns:236px minmax(0,1fr);height:100vh}

.side{display:flex;flex-direction:column;min-height:0;padding:20px 14px 16px;border-right:1px solid var(--line);background:var(--panel)}
.brand{display:flex;flex-direction:column;gap:2px;padding:0 8px 16px}
.brand b{font-size:17px;font-weight:600;letter-spacing:.2px}
.brand span{font-size:12px;color:var(--muted)}
.nav{display:flex;flex-direction:column;gap:2px;overflow:auto}
.nav button{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border:0;border-radius:9px;background:transparent;color:var(--muted);text-align:left;cursor:pointer}
.nav button:hover{background:var(--panel2);color:var(--ink)}
.nav button[aria-current="true"]{background:rgba(91,140,255,.14);color:#cfe0ff}
.nav i{width:18px;height:18px;border-radius:5px;background:var(--panel2);display:inline-block;flex:0 0 auto}
.nav button[aria-current="true"] i{background:var(--accent)}
.side-foot{margin-top:auto;padding:12px 8px 0;border-top:1px solid var(--line);font-size:12px;color:var(--muted);display:flex;flex-direction:column;gap:4px;word-break:break-all}

.main{display:flex;flex-direction:column;min-width:0;min-height:0}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 28px;border-bottom:1px solid var(--line);background:rgba(14,16,20,.92)}
.topbar h1{margin:0;font-size:18px;font-weight:600}
.topbar .sub{margin:2px 0 0;font-size:12px;color:var(--muted)}
.top-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}
.view{flex:1;min-height:0;overflow:auto;padding:24px 28px 64px}

.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--line);background:var(--panel);font-size:12px;color:var(--muted)}
.pill.ok{color:var(--ok);border-color:rgba(62,207,142,.35)}
.pill.warn{color:var(--warn);border-color:rgba(240,180,41,.35)}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor}

.btn{padding:8px 14px;border-radius:9px;border:1px solid var(--line);background:var(--panel2);cursor:pointer}
.btn:hover{border-color:#3a4353}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#0b1220;font-weight:600}
.btn.primary:hover{background:var(--accent2)}
.btn.ghost{background:transparent}
.btn.danger{color:var(--danger);border-color:rgba(239,91,91,.4)}
.btn:disabled{opacity:.5;cursor:not-allowed}

.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
.grid.wide{grid-template-columns:repeat(auto-fill,minmax(420px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px;min-width:0}
.card h2{margin:0 0 4px;font-size:15px;font-weight:600}
.card .hint{margin:0 0 14px;font-size:12px;color:var(--muted)}
.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}

.stat{display:flex;flex-direction:column;gap:6px}
.stat .k{font-size:12px;color:var(--muted)}
.stat .v{font-size:26px;font-weight:600;letter-spacing:.4px}
.stat .d{font-size:12px;color:var(--muted)}

.field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;min-width:0}
.field label{font-size:12px;color:var(--muted)}
.field .row{display:flex;gap:8px;align-items:center}
input[type=text],input[type=number],input[type=password],input[type=url],select,textarea{
  width:100%;min-height:36px;padding:7px 10px;border-radius:8px;border:1px solid var(--line);
  background:var(--bg);color:var(--ink);outline:none
}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
textarea{min-height:78px;resize:vertical}
input[type=range]{width:100%;accent-color:var(--accent)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.three{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.switch{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink);cursor:pointer}
.switch input{width:16px;height:16px;accent-color:var(--accent)}
.badge{padding:2px 8px;border-radius:999px;background:var(--panel2);border:1px solid var(--line);font-size:11px;color:var(--muted)}
.badge.ok{color:var(--ok);border-color:rgba(62,207,142,.35)}
.muted{color:var(--muted)}
.mt{margin-top:16px}
.mt-6{margin-top:6px}
.mb{margin-bottom:12px}
.flush{margin:0}
.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}
.mt{margin-top:16px}
.mt-6{margin-top:6px}
.mb{margin-bottom:12px}
.flush{margin:0}
.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}
.empty{padding:28px;border:1px dashed var(--line);border-radius:var(--radius);text-align:center;color:var(--muted)}
.toast{position:fixed;right:24px;bottom:24px;padding:10px 16px;border-radius:10px;background:var(--panel2);border:1px solid var(--line);box-shadow:0 8px 24px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);transition:.18s;pointer-events:none;z-index:60}
.toast.show{opacity:1;transform:none}
.toast.err{border-color:rgba(239,91,91,.5);color:#ffd7d7}
.rowline{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
.rowline:last-child{border-bottom:0}
@media (max-width:900px){.app{grid-template-columns:1fr}.side{flex-direction:row;align-items:center;overflow:auto;border-right:0;border-bottom:1px solid var(--line)}.brand{padding:0 12px 0 4px}.nav{flex-direction:row}.side-foot{display:none}.two,.three{grid-template-columns:1fr}}
`;
