/**
 * 控制台前端脚本：读 /live-pet/config 与 /standalone-ai/settings，渲染六个视图并按需写回。
 *
 * 不引入框架与构建链：所有视图用 DOM 拼装，状态只有一份 draft（配置）与 aiDraft（模型）。
 * 必须始终成立：任何写请求都带 x-dsh-pet-token（来自地址片段）；读失败不渲染空表单，
 * 而是显示可操作的错误，避免用户以为「配置是空的」而保存覆盖。
 * @module live-pet/src/console/script
 */
export const consoleScript = `
(function () {
  'use strict';

  var API = '/live-pet';
  var token = (location.hash.match(/token=([A-Za-z0-9_-]+)/) || [])[1] || '';
  var state = {
    cfg: null, ai: null, meta: null, tab: 'overview',
    draft: null, aiDraft: null, dirty: false, petIndex: 0
  };

  var TABS = [
    { id: 'overview', label: '概览', title: '概览', sub: '运行状态与快速操作' },
    { id: 'pets', label: '宠物', title: '宠物', sub: '多开、大小、位置与开关' },
    { id: 'look', label: '外观与物理', title: '外观与物理', sub: '拖拽甩抛手感、气泡字体、全局开关' },
    { id: 'ai', label: 'AI 对话', title: 'AI 对话', sub: 'DeepSeek / OpenAI 兼容接口与记忆轮数' },
    { id: 'live', label: '直播接入', title: '直播接入', sub: '抖音弹幕转发、去重与事件映射' }
  ];

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') n.className = attrs[k];
        else if (k === 'text') n.textContent = attrs[k];
        else if (k === 'on') { for (var ev in attrs.on) n.addEventListener(ev, attrs.on[ev]); }
        else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) n.setAttribute(k, attrs[k]);
      }
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function api(path, opt) {
    opt = opt || {};
    var headers = {};
    if (token) headers['x-dsh-pet-token'] = token;
    if (opt.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(path, {
      method: opt.method || 'GET',
      headers: headers,
      body: opt.body === undefined ? undefined : JSON.stringify(opt.body),
      cache: 'no-store'
    }).then(function (r) {
      return r.text().then(function (t) {
        var body = null;
        try { body = t ? JSON.parse(t) : null; } catch (e) { body = null; }
        if (!r.ok) {
          var reason = body && (body.error || body.reason) ? (body.error || body.reason) : ('HTTP ' + r.status);
          var err = new Error(reason);
          err.status = r.status;
          throw err;
        }
        if (body && body.ok === false) throw new Error(body.reason || '操作失败');
        return body;
      });
    });
  }

  var toastTimer = 0;
  function toast(message, isError) {
    var t = $('toast');
    t.textContent = message;
    t.className = 'toast show' + (isError ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function num(v, fallback) { var n = Number(v); return isFinite(n) ? n : fallback; }

  function animCount(animations) {
    if (!animations) return 0;
    var n = 0;
    ['idle', 'turn', 'drag', 'clicks'].forEach(function (k) { n += (animations[k] || []).length; });
    n += ((animations.moves || {}).actions || []).length;
    (animations.categories || []).forEach(function (c) { n += (c.actions || []).length; });
    Object.keys(animations.events || {}).forEach(function (k) { n += (animations.events[k] || []).length; });
    return n;
  }

  function mainEntry() { return (state.cfg && state.cfg.main) || {}; }

  function makeDraft() {
    var m = mainEntry();
    var pets = (m.pets || []).map(function (p) {
      var pos = p.position || {};
      return {
        name: p.name || p.id,
        id: p.id,
        size: num(p.size, 462),
        balanceEnabled: p.balanceEnabled === true,
        whisperEnabled: p.whisperEnabled !== false,
        workStatusEnabled: p.workStatusEnabled === true,
        fixedEnabled: p.fixedEnabled === true,
        display: p.display || 'desktop',
        corner: pos.corner || 'bottom-right',
        marginX: num(pos.marginX, 24),
        marginY: num(pos.marginY, 24),
        whisperPrompt: p.whisperPrompt || ''
      };
    });
    return {
      pets: pets,
      physics: Object.assign({ gravity: 1400, restitution: 0.78, groundFriction: 2.5, ceilingBounce: true, throwPower: 1, petCollision: false }, m.physics || {}),
      font: Object.assign({ family: 'candy', size: 21, followPet: true }, m.font || {}),
      trayEnabled: m.trayEnabled !== false,
      clickSoundEnabled: m.clickSoundEnabled === true,
      whisperImageEnabled: m.whisperImageEnabled !== false,
      chatImageEnabled: m.chatImageEnabled !== false,
      chatMemoryRounds: num(m.chatMemoryRounds, 5),
      chatImageLimit: m.chatImageLimit === undefined ? 10 : num(m.chatImageLimit, 10)
    };
  }

  function markDirty() {
    state.dirty = true;
    renderActions();
  }

  function renderNav() {
    var nav = $('nav');
    nav.innerHTML = '';
    TABS.forEach(function (t) {
      nav.appendChild(el('button', {
        type: 'button',
        'aria-current': String(state.tab === t.id),
        on: { click: function () { state.tab = t.id; render(); } }
      }, [el('i'), t.label]));
    });
    var m = mainEntry();
    $('foot').innerHTML = '';
    $('foot').appendChild(el('div', { text: '端口 ' + (location.port || '—') }));
    $('foot').appendChild(el('div', { text: '宠物 ' + ((m.pets || []).length) + ' 只 · 动画 ' + animCount(m.animations) + ' 段' }));
    $('foot').appendChild(el('div', { text: token ? '带令牌打开（可保存）' : '同源访问（可直接保存）' }));
  }

  function renderActions() {
    var box = $('actions');
    box.innerHTML = '';
    var tab = state.tab;
    var canSave = tab === 'pets' || tab === 'look';
    if (tab === 'ai') {
      box.appendChild(el('button', { class: 'btn primary', type: 'button', on: { click: saveAi } }, ['保存 AI 设置']));
      return;
    }
    if (!canSave) return;
    if (state.dirty) box.appendChild(el('span', { class: 'pill warn' }, [el('span', { class: 'dot' }), '有未保存的更改']));
    box.appendChild(el('button', { class: 'btn', type: 'button', on: { click: function () { state.draft = makeDraft(); state.dirty = false; render(); } } }, ['放弃更改']));
    box.appendChild(el('button', { class: 'btn primary', type: 'button', on: { click: saveConfig } }, ['保存配置']));
  }

  function field(label, control, hint) {
    return el('div', { class: 'field' }, [el('label', { text: label }), control, hint ? el('div', { class: 'hint', text: hint }) : null]);
  }

  function textInput(value, onChange, attrs) {
    var input = el('input', Object.assign({ type: 'text', value: value }, attrs || {}));
    input.addEventListener('input', function () { onChange(input.value); });
    return input;
  }

  function numberInput(value, onChange, attrs) {
    var input = el('input', Object.assign({ type: 'number', value: String(value) }, attrs || {}));
    input.addEventListener('input', function () { onChange(num(input.value, 0)); });
    return input;
  }

  function selectInput(value, options, onChange) {
    var s = el('select');
    options.forEach(function (o) {
      var op = el('option', { value: o.value, text: o.label });
      if (o.value === value) op.selected = true;
      s.appendChild(op);
    });
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }

  function toggle(checked, label, onChange) {
    var input = el('input', { type: 'checkbox' });
    input.checked = checked;
    input.addEventListener('change', function () { onChange(input.checked); });
    return el('label', { class: 'switch' }, [input, label]);
  }

  function card(title, hint, kids, right) {
    return el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('div', {}, [el('h2', { text: title }), hint ? el('p', { class: 'hint', text: hint }) : null]),
        right || null
      ]),
      el('div', {}, kids)
    ]);
  }

  function renderOverview() {
    var m = mainEntry();
    var pets = m.pets || [];
    var model = state.ai && state.ai.enabled ? (state.ai.model || '已启用') : '未配置';
    var stats = [
      { k: '宠物', v: String(pets.length), d: pets.map(function (p) { return p.name || p.id; }).join(' · ') || '—' },
      { k: '表情包', v: String(Object.keys(m.memes || {}).length), d: '碎碎念与对话配图池' },
      { k: '模型', v: model, d: state.ai && state.ai.baseUrl ? state.ai.baseUrl : '在「AI 对话」里配置' },
      { k: '直播', v: (state.liveStatus && state.liveStatus.connected) ? '已连接' : '未连接', d: (state.liveStatus && state.liveStatus.mode === 'ai') ? 'AI 模式' : '单机模式（只读弹幕）', id: 'ov-live' },
      { k: '托盘', v: m.trayEnabled === false ? '关闭' : '开启', d: '关闭后只能用任务管理器退出' }
    ];
    var grid = el('div', { class: 'grid' });
    stats.forEach(function (s) {
      grid.appendChild(el('div', { class: 'card stat' }, [
        el('div', { class: 'k', text: s.k }), el('div', { class: 'v', id: s.id || null, text: s.v }), el('div', { class: 'd', text: s.d })
      ]));
    });

    var sayInput = el('input', { type: 'text', value: '直播间的朋友们好呀～', placeholder: '要说的话' });
    var animSelect = el('select');
    ((m.animations || {}).idle || []).concat(((m.animations || {}).clicks) || []).forEach(function (name) {
      animSelect.appendChild(el('option', { value: name, text: name }));
    });
    var firstPet = (pets[0] || {}).id || 'main';

    var quick = card('快速操作', '直接驱动桌面上的宠物，不写配置文件', [
      field('让它说话', el('div', { class: 'row' }, [sayInput, el('button', { class: 'btn', type: 'button', on: { click: function () {
        api(API + '/broadcast?pet=' + encodeURIComponent(firstPet) + '&surface=any', { method: 'POST', body: { text: sayInput.value } })
          .then(function () { toast('已发送'); }).catch(function (e) { toast(e.message, true); });
      } } }, ['发送'])]), '写入 pets.<id>.say，10 秒后自动收起'),
      field('播一段动画', el('div', { class: 'row' }, [animSelect, el('button', { class: 'btn', type: 'button', on: { click: function () {
        api(API + '/anim?pet=' + encodeURIComponent(firstPet) + '&surface=any', { method: 'POST', body: { name: animSelect.value } })
          .then(function () { toast('已点播'); }).catch(function (e) { toast(e.message, true); });
      } } }, ['播放'])]), '移动类动画会真实走位'),
      field('其他', el('div', { class: 'row' }, [
        el('button', { class: 'btn ghost', type: 'button', on: { click: function () {
          api(API + '/balance', { method: 'POST', body: {} }).then(function () { toast('已触发余额刷新'); }).catch(function (e) { toast(e.message, true); });
        } } }, ['刷新余额']),
        el('button', { class: 'btn ghost', type: 'button', on: { click: function () {
          api(API + '/reload', { method: 'POST', body: {} }).then(function () { toast('正在重载桌面窗口'); }).catch(function (e) { toast(e.message, true); });
        } } }, ['重载配置'])
      ]), '修改配置文件后可用「重载配置」')
    ]);

    $('view').appendChild(grid);
    var wrap = el('div', { class: 'grid wide mt' });
    wrap.appendChild(quick);
    $('view').appendChild(wrap);
    // 概览上的直播状态可能已经变了（在直播页连过）：拉一次状态刷新数值，不重渲染整页。
    refreshLive();
  }

  function renderPets() {
    var d = state.draft;
    var grid = el('div', { class: 'grid wide' });
    d.pets.forEach(function (p, i) {
      var sizeLabel = el('span', { class: 'badge', text: String(p.size) + ' px' });
      var cardEl = card(p.name || p.id, 'id: ' + p.id, [
        el('div', { class: 'two' }, [
          field('显示名', textInput(p.name, function (v) { p.name = v; markDirty(); })),
          field('大小（宽 px）', el('div', { class: 'row' }, [
            (function () {
              var r = el('input', { type: 'range', min: '120', max: '900', step: '2', value: String(p.size) });
              r.addEventListener('input', function () { p.size = num(r.value, 462); sizeLabel.textContent = p.size + ' px'; markDirty(); });
              return r;
            })(), sizeLabel
          ]))
        ]),
        el('div', { class: 'three' }, [
          field('显示位置', selectInput(p.display, [
            { value: 'desktop', label: '仅桌面' }, { value: 'both', label: '桌面 + 网页' },
            { value: 'web', label: '仅网页' }, { value: 'none', label: '不显示' }
          ], function (v) { p.display = v; markDirty(); })),
          field('角落', selectInput(p.corner, [
            { value: 'bottom-right', label: '右下' }, { value: 'bottom-left', label: '左下' },
            { value: 'top-right', label: '右上' }, { value: 'top-left', label: '左上' }
          ], function (v) { p.corner = v; markDirty(); })),
          field('边距 X / Y', el('div', { class: 'two' }, [
            numberInput(p.marginX, function (v) { p.marginX = v; markDirty(); }),
            numberInput(p.marginY, function (v) { p.marginY = v; markDirty(); })
          ]))
        ]),
        el('div', { class: 'two' }, [
          toggle(p.balanceEnabled, '余额动画', function (v) { p.balanceEnabled = v; markDirty(); }),
          toggle(p.whisperEnabled, '自动碎碎念', function (v) { p.whisperEnabled = v; markDirty(); }),
          toggle(p.fixedEnabled, '固定原地（不自动走）', function (v) { p.fixedEnabled = v; markDirty(); })
        ]),
        field('人设（留空跟随条目默认）', (function () {
          var ta = el('textarea', { placeholder: '这只宠物的性格与说话方式' });
          ta.value = p.whisperPrompt || '';
          ta.addEventListener('input', function () { p.whisperPrompt = ta.value; markDirty(); });
          return ta;
        })())
      ], el('button', {
        class: 'btn danger', type: 'button',
        on: { click: function () {
          if (d.pets.length <= 1) { toast('至少保留一只宠物', true); return; }
          d.pets.splice(i, 1); markDirty(); render();
        } }
      }, ['删除']));
      grid.appendChild(cardEl);
    });

    var add = el('button', { class: 'btn', type: 'button', on: { click: function () {
      var base = d.pets[0];
      var id = 'pet' + (d.pets.length + 1);
      d.pets.push(Object.assign(clone(base), { id: id, name: '新宠物 ' + d.pets.length }));
      markDirty(); render();
    } } }, ['+ 添加一只']);
    $('view').appendChild(el('div', { class: 'toolbar' }, [
      el('p', { class: 'muted flush', text: '每只宠物一个独立透明窗口，共用同一套动画与配置。' }),
      add
    ]));
    $('view').appendChild(grid);
  }

  function renderLook() {
    var d = state.draft;
    var grid = el('div', { class: 'grid wide' });

    grid.appendChild(card('拖拽与抛掷', '改完保存即生效，桌面窗口会重载', [
      el('div', { class: 'three' }, [
        field('重力 px/s²', numberInput(d.physics.gravity, function (v) { d.physics.gravity = v; markDirty(); }, { min: '0', step: '50' })),
        field('弹性 0~1', numberInput(d.physics.restitution, function (v) { d.physics.restitution = v; markDirty(); }, { min: '0', max: '1', step: '0.02' })),
        field('地面摩擦', numberInput(d.physics.groundFriction, function (v) { d.physics.groundFriction = v; markDirty(); }, { min: '0', step: '0.1' }))
      ]),
      el('div', { class: 'three' }, [
        field('抛掷力度', numberInput(d.physics.throwPower, function (v) { d.physics.throwPower = v; markDirty(); }, { min: '0.1', step: '0.1' })),
        toggle(d.physics.ceilingBounce !== false, '顶部反弹', function (v) { d.physics.ceilingBounce = v; markDirty(); }),
        toggle(d.physics.petCollision === true, '宠物互相碰撞', function (v) { d.physics.petCollision = v; markDirty(); })
      ])
    ]));

    grid.appendChild(card('气泡与字体', '字号只影响气泡与悬浮提示', [
      el('div', { class: 'two' }, [
        field('字体', selectInput(d.font.family, [
          { value: 'candy', label: '软糖体（内置）' }, { value: 'yahei', label: '微软雅黑 / 苹方' },
          { value: 'youyuan', label: '幼圆' }, { value: 'kaiti', label: '楷体' },
          { value: 'simsun', label: '宋体' }, { value: 'comic', label: '漫画体' }, { value: 'system', label: '系统默认' }
        ], function (v) { d.font.family = v; markDirty(); })),
        field('字号 px', numberInput(d.font.size, function (v) { d.font.size = v; markDirty(); }, { min: '4', max: '200' }))
      ]),
      toggle(d.font.followPet !== false, '字号随宠物大小缩放', function (v) { d.font.followPet = v; markDirty(); })
    ]));

    grid.appendChild(card('全局开关', '只读 main 条目这一份', [
      el('div', { class: 'two' }, [
        toggle(d.trayEnabled, '系统托盘', function (v) { d.trayEnabled = v; markDirty(); }),
        toggle(d.clickSoundEnabled, '点击音效', function (v) { d.clickSoundEnabled = v; markDirty(); }),
        toggle(d.whisperImageEnabled, '碎碎念配图', function (v) { d.whisperImageEnabled = v; markDirty(); }),
        toggle(d.chatImageEnabled, '对话配图', function (v) { d.chatImageEnabled = v; markDirty(); })
      ])
    ]));

    $('view').appendChild(grid);
  }

  /** 提交前本地校验：返回具体原因，全部通过返回 null（与服务端同一套范围）。 */
  function aiValidate(a) {
    if (a.baseUrl) {
      var u;
      try {
        u = new URL(a.baseUrl);
      } catch (e) {
        return '接口地址格式不正确（要完整地址，如 https://api.deepseek.com）';
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '接口地址必须以 http:// 或 https:// 开头';
      if (u.username || u.password || u.search || u.hash) return '接口地址不能带账号、查询参数或 # 片段';
    }
    if (!Number.isInteger(a.whisperIntervalSec) || a.whisperIntervalSec < 60 || a.whisperIntervalSec > 86400) {
      return '碎碎念间隔必须是 60–86400 的整数（秒）';
    }
    if (!Number.isInteger(a.maxTokens) || a.maxTokens < 128 || a.maxTokens > 4096) {
      return '单次输出上限必须是 128–4096 的整数';
    }
    if (typeof a.model === 'string' && a.model.length > 200) return '模型名称最多 200 字符';
    return null;
  }

  /** 配置层（记忆轮数 / 配图上限）是否真的改过：没改就不写配置，免得白重建一次桌面窗口。 */
  function configLayerChanged() {
    var m = mainEntry();
    var rounds = num(m.chatMemoryRounds, 5);
    var limit = m.chatImageLimit === undefined ? 10 : num(m.chatImageLimit, 10);
    return state.draft.chatMemoryRounds !== rounds || state.draft.chatImageLimit !== limit;
  }

  /** 提交前本地校验：返回具体原因，全部通过返回 null（与服务端同一套范围）。 */
  function renderAi() {
    var a = state.aiDraft;
    var d = state.draft;
    var grid = el('div', { class: 'grid wide' });
    var keyHint = state.ai && state.ai.hasKey ? '已保存密钥，留空则保持不变' : '尚未保存密钥';

    grid.appendChild(card('模型连接', 'OpenAI 兼容或 Anthropic；DeepSeek 选 OpenAI 兼容', [
      el('div', { class: 'two' }, [
        field('协议', selectInput(a.protocol, [
          { value: 'openai-compatible', label: 'OpenAI 兼容（DeepSeek 选这个）' },
          { value: 'anthropic', label: 'Anthropic' }
        ], function (v) { a.protocol = v; })),
        field('模型', textInput(a.model, function (v) { a.model = v; }, { placeholder: 'deepseek-chat' }))
      ]),
      field('接口地址', textInput(a.baseUrl, function (v) { a.baseUrl = v; }, { placeholder: 'https://api.deepseek.com' }), '通常以 /v1 结尾，不要把密钥写进地址'),
      field('API 密钥', (function () {
        var i = el('input', { type: 'password', placeholder: keyHint, autocomplete: 'new-password' });
        i.addEventListener('input', function () { a.apiKey = i.value; });
        return i;
      })(), keyHint),
      toggle(!!a.clearApiKey, '清除已保存的密钥（保存后生效）', function (v) { a.clearApiKey = v; }),
      toggle(!!a.clearApiKey, '清除已保存的密钥（保存后生效）', function (v) { a.clearApiKey = v; }),
      toggle(a.enabled, '启用 AI 对话与碎碎念', function (v) { a.enabled = v; })
    ]));

    grid.appendChild(card('生成与记忆', '控制成本的三只旋钮', [
      el('div', { class: 'three' }, [
        field('记忆轮数', numberInput(d.chatMemoryRounds, function (v) { d.chatMemoryRounds = v; markDirty(); }, { min: '0', max: '50' })),
        field('配图上限（张）', numberInput(d.chatImageLimit, function (v) { d.chatImageLimit = v; markDirty(); }, { min: '0', max: '50' })),
        field('单次输出上限', numberInput(a.maxTokens, function (v) { a.maxTokens = v; }, { min: '128', max: '4096' }))
      ]),
      el('div', { class: 'two' }, [
        toggle(a.automaticWhispers, '定时自动碎碎念', function (v) { a.automaticWhispers = v; }),
        field('碎碎念间隔（秒）', numberInput(a.whisperIntervalSec, function (v) { a.whisperIntervalSec = v; }, { min: '60', max: '86400' }))
      ]),
      el('p', { class: 'hint', text: '直播场景建议：记忆 2~3 轮、输出上限 128~256，单条回复更短更便宜。' })
    ]));

    $('view').appendChild(grid);
    var test = el('button', { class: 'btn', type: 'button', on: { click: function () {
      // 用界面上的当前值测试：改了模型名但还没保存时，测的必须是新值，而不是磁盘上的旧值。
      var err = aiValidate(a);
      if (err) { toast(err, true); return; }
      var probe = { protocol: a.protocol, baseUrl: a.baseUrl, model: a.model };
      if (a.apiKey) probe.apiKey = a.apiKey;
      toast('正在测试连接…');
      api('/standalone-ai/test', { method: 'POST', body: probe })
        .then(function (r) {
          if (r && r.ok) toast('连接成功：' + (r.reply || 'ok'));
          else toast((r && r.message) || '连接失败', true);
        })
        .catch(function (e) { toast(e.message, true); });
    } } }, ['测试连接']);
    $('view').appendChild(el('div', { class: 'mt' }, [test]));
  }

  var liveTimer = 0;

  function liveField(label, control, hint) {
    return field(label, control, hint);
  }

  function refreshLive() {
    api(API + '/live/status').then(function (st) {
      state.liveStatus = st;
      var map = {
        'live-dot': st.connected ? '已连接' : '未连接',
        'live-recv': String(st.received),
        'live-deliv': String(st.delivered),
        'live-supp': String(st.suppressed),
        'live-room': st.room || '—',
        'live-mode': st.mode === 'ai' ? 'AI 模式' : '单机模式',
        'ov-live': st.connected ? '已连接' : '未连接',
        'live-mode': st.mode === 'ai' ? 'AI 模式' : '单机模式',
        'ov-live': st.connected ? '已连接' : '未连接',
        'live-last': st.lastEvent ? (st.lastEvent.kind + ' · ' + st.lastEvent.user + ' · ' + (st.lastEvent.text || '')) : '—',
        'live-err': st.lastError || '—'
      };
      Object.keys(map).forEach(function (id) {
        var node = $(id);
        if (node) node.textContent = map[id];
      });
      var pill = $('live-pill');
      if (pill) { pill.className = 'pill ' + (st.connected ? 'ok' : ''); }
    }).catch(function () {});
  }

  function renderLive() {
    var lc = state.liveCfg || { sourceUrl: 'ws://127.0.0.1:1088/ws/{room}', room: '', dedupeWindowSec: 30, dedupeMaxPerWindow: 3 };
    var st = state.liveStatus || { connected: false, received: 0, delivered: 0, suppressed: 0 };

    var roomInput = el('input', { type: 'text', value: lc.room || '', placeholder: '例如 516466932480' });
    var urlInput = el('input', { type: 'text', value: lc.sourceUrl || '' });
    var winInput = el('input', { type: 'number', value: String(lc.dedupeWindowSec), min: '1', max: '3600' });
    var maxInput = el('input', { type: 'number', value: String(lc.dedupeMaxPerWindow), min: '1', max: '100' });
    var autoBox = el('input', { type: 'checkbox' });
    autoBox.checked = lc.autoConnect !== false;
    var autoBox = el('input', { type: 'checkbox' });
    autoBox.checked = lc.autoConnect !== false;
    var modeSelect = el('select');
    [['readonly', '单机模式 · 只读弹幕（不走大模型）'], ['ai', 'AI 模式 · 弹幕交给大模型']].forEach(function (o) {
      var op = el('option', { value: o[0], text: o[1] });
      if ((lc.mode || 'readonly') === o[0]) op.selected = true;
      modeSelect.appendChild(op);
    });
    var autoBox = el('input', { type: 'checkbox' });
    autoBox.checked = lc.autoConnect !== false;
    var autoBox = el('input', { type: 'checkbox' });
    autoBox.checked = lc.autoConnect !== false;
    var modeSelect = el('select');
    [['readonly', '单机模式 · 只读弹幕（不走大模型）'], ['ai', 'AI 模式 · 弹幕交给大模型']].forEach(function (o) {
      var op = el('option', { value: o[0], text: o[1] });
      if ((lc.mode || 'readonly') === o[0]) op.selected = true;
      modeSelect.appendChild(op);
    });

    var grid = el('div', { class: 'grid wide' });

    grid.appendChild(card('抖音弹幕转发', '本地 WS 源；mock:// 为内置模拟源，没有转发器也能试', [
      liveField('接入模式', modeSelect, '单机模式：弹幕只显示「谁说了什么」，礼物用固定话术感谢，不产生 API 费用'),
      liveField('接入模式', modeSelect, '单机模式：弹幕只显示「谁说了什么」，礼物用固定话术感谢，不产生 API 费用'),
      el('div', { class: 'two' }, [
        liveField('直播间号', roomInput, '填房间号后点「保存并连接」'),
        liveField('转发服务地址', urlInput, 'douyinLive 默认 ws://127.0.0.1:1088/ws/{room}')
      ]),
      el('div', { class: 'two' }, [
        liveField('去重窗口（秒）', winInput, '同一用户 + 同一内容的统计窗口'),
        liveField('窗口内最多放行', maxInput, '超出即抑制并记日志；礼物同规则、不合并')
      ]),
      el('label', { class: 'switch mb' }, [autoBox, '启动时自动连接（模拟源除外）']),
      el('div', { class: 'row mt-6' }, [
        el('button', { class: 'btn primary', type: 'button', on: { click: function () {
          api(API + '/live/config', { method: 'POST', body: {
            mode: modeSelect.value,
            autoConnect: autoBox.checked,
            sourceUrl: urlInput.value.trim(), room: roomInput.value.trim(),
            dedupeWindowSec: num(winInput.value, 30), dedupeMaxPerWindow: num(maxInput.value, 3)
          } }).then(function (cfg) {
            state.liveCfg = cfg;
            return api(API + '/live/connect', { method: 'POST', body: { room: roomInput.value.trim() } });
          }).then(function () { toast('已开始接收直播事件'); refreshLive(); })
            .catch(function (e) { toast(e.message, true); });
        } } }, ['保存并连接']),
        el('button', { class: 'btn', type: 'button', on: { click: function () {
          api(API + '/live/disconnect', { method: 'POST', body: {} })
            .then(function () { toast('已断开'); refreshLive(); })
            .catch(function (e) { toast(e.message, true); });
        } } }, ['断开'])
      ])
    ]));

    grid.appendChild(card('运行状态', '每 2 秒刷新', [
      el('div', { class: 'rowline' }, [el('span', { text: '连接' }), el('span', { class: 'pill ' + (st.connected ? 'ok' : ''), id: 'live-pill' }, [el('span', { class: 'dot' }), el('span', { id: 'live-dot', text: st.connected ? '已连接' : '未连接' })])]),
      el('div', { class: 'rowline' }, [el('span', { text: '模式' }), el('span', { class: 'badge', id: 'live-mode', text: st.mode === 'ai' ? 'AI 模式' : '单机模式' })]),
      el('div', { class: 'rowline' }, [el('span', { text: '模式' }), el('span', { class: 'badge', id: 'live-mode', text: st.mode === 'ai' ? 'AI 模式' : '单机模式' })]),
      el('div', { class: 'rowline' }, [el('span', { text: '房间' }), el('span', { class: 'badge', id: 'live-room', text: st.room || '—' })]),
      el('div', { class: 'rowline' }, [el('span', { text: '收到 / 放行 / 抑制' }), el('span', {}, [
        el('span', { id: 'live-recv', text: String(st.received) }), ' / ',
        el('span', { id: 'live-deliv', text: String(st.delivered) }), ' / ',
        el('span', { id: 'live-supp', text: String(st.suppressed) })
      ])]),
      el('div', { class: 'rowline' }, [el('span', { text: '最近事件' }), el('span', { class: 'muted', id: 'live-last', text: '—' })]),
      el('div', { class: 'rowline' }, [el('span', { text: '最近错误' }), el('span', { class: 'muted', id: 'live-err', text: st.lastError || '—' })])
    ]));

    var testUser = el('input', { type: 'text', value: '测试观众' });
    var testText = el('input', { type: 'text', value: '主播好呀' });
    var testKind = el('select');
    [['chat', '弹幕'], ['gift', '礼物'], ['enter', '进场'], ['follow', '关注'], ['like', '点赞']].forEach(function (o) {
      testKind.appendChild(el('option', { value: o[0], text: o[1] }));
    });

    grid.appendChild(card('模拟事件', '不需要真直播间，直接验证去重与动作', [
      el('div', { class: 'two' }, [liveField('类型', testKind), liveField('用户', testUser)]),
      liveField('内容（弹幕用）', testText),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn', type: 'button', on: { click: function () {
          var kind = testKind.value;
          var body = { kind: kind, user: testUser.value || '测试观众' };
          if (kind === 'chat') body.text = testText.value;
          if (kind === 'gift') { body.giftName = testText.value || '小心心'; body.giftCount = 1; }
          api(API + '/live/test', { method: 'POST', body: body })
            .then(function (r) { toast(r.admitted ? '已放行' : '被去重抑制'); refreshLive(); })
            .catch(function (e) { toast(e.message, true); });
        } } }, ['发一条']),
        el('span', { class: 'hint', text: '连发同一用户同一内容 4 次，第 4 次应被抑制' })
      ])
    ]));

    $('view').appendChild(grid);
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(refreshLive, 2000);
    refreshLive();
  }

  function render() {
    var tab = TABS.filter(function (t) { return t.id === state.tab; })[0] || TABS[0];
    $('title').textContent = tab.title;
    $('subtitle').textContent = tab.sub;
    $('view').innerHTML = '';
    if (liveTimer) { clearInterval(liveTimer); liveTimer = 0; }
    renderNav();
    renderActions();
    if (!state.cfg) return;
    if (state.tab === 'overview') renderOverview();
    else if (state.tab === 'pets') renderPets();
    else if (state.tab === 'look') renderLook();
    else if (state.tab === 'ai') renderAi();
    else if (state.tab === 'live') renderLive();
  }

  function configBody() {
    var d = state.draft;
    return {
      pets: d.pets.map(function (p) {
        var out = {
          id: p.id, name: p.name, size: p.size,
          balanceEnabled: !!p.balanceEnabled,
          whisperEnabled: !!p.whisperEnabled,
          workStatusEnabled: !!p.workStatusEnabled,
          fixedEnabled: !!p.fixedEnabled,
          display: p.display,
          position: { corner: p.corner, marginX: p.marginX, marginY: p.marginY }
        };
        if (p.whisperPrompt) out.whisperPrompt = p.whisperPrompt;
        return out;
      }),
      physics: d.physics,
      font: d.font,
      trayEnabled: d.trayEnabled,
      clickSoundEnabled: d.clickSoundEnabled,
      whisperImageEnabled: d.whisperImageEnabled,
      chatImageEnabled: d.chatImageEnabled,
      chatMemoryRounds: d.chatMemoryRounds,
      chatImageLimit: d.chatImageLimit
    };
  }

  function saveConfig() {
    api(API + '/config', { method: 'PUT', body: configBody() })
      .then(function (cfg) {
        state.cfg = cfg;
        state.draft = makeDraft();
        state.dirty = false;
        toast('已保存，桌面窗口正在重载');
        render();
      })
      .catch(function (e) {
        if (e.status === 403) toast('没有写权限：请在本机浏览器打开控制台', true);
        else toast(e.message, true);
      });
  }

  function saveAi() {
    var a = state.aiDraft;
    var invalid = aiValidate(a);
    if (invalid) { toast(invalid, true); return; }
    var body = {
      protocol: a.protocol, baseUrl: a.baseUrl, model: a.model,
      enabled: !!a.enabled, automaticWhispers: !!a.automaticWhispers,
      whisperIntervalSec: a.whisperIntervalSec, maxTokens: a.maxTokens
    };
    if (a.apiKey) body.apiKey = a.apiKey;
    if (a.clearApiKey) body.clearApiKey = true;
    // 配置层（记忆轮数 / 配图上限）只在真的改过时才写：否则每次保存 AI 都会重建桌面窗口。
    var first = configLayerChanged()
      ? api(API + '/config', { method: 'PUT', body: configBody() }).then(function (cfg) { state.cfg = cfg; })
      : Promise.resolve();
    first
      .then(function () { return api('/standalone-ai/settings', { method: 'POST', body: body }); })
      .then(function (saved) {
        state.ai = saved;
        state.aiDraft = Object.assign({ apiKey: '' }, saved);
        toast('AI 设置已保存');
        render();
      })
      .catch(function (e) {
        if (e.status === 403) toast('没有写权限：请在本机浏览器打开控制台', true);
        else toast(e.message, true);
      });
  }

  function boot() {
    Promise.all([
      api(API + '/config'),
      api('/standalone-ai/settings').catch(function () { return {}; }),
      api(API + '/live/config').catch(function () { return null; }),
      api(API + '/live/status').catch(function () { return null; })
    ]).then(function (res) {
      state.cfg = res[0];
      state.ai = res[1] || {};
      state.liveCfg = res[2] || null;
      state.liveStatus = res[3] || null;
      state.draft = makeDraft();
      state.aiDraft = Object.assign({
        protocol: 'openai-compatible', baseUrl: '', model: 'deepseek-chat',
        enabled: false, automaticWhispers: false, whisperIntervalSec: 300, maxTokens: 1024, apiKey: ''
      }, state.ai);
      render();
    }).catch(function (e) {
      $('subtitle').textContent = '读取配置失败：' + e.message;
      $('view').appendChild(el('div', { class: 'empty', text: '无法读取配置。请确认应用仍在运行，然后刷新页面。' }));
    });
  }

  boot();
})();
`;
