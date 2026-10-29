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
    draft: null, aiDraft: null, dirty: false, petIndex: 0,
    liveCfg: null, liveStatus: null, songCfg: null, song: null
  };

  var TABS = [
    { id: 'overview', label: '概览', title: '概览', sub: '运行状态与快速操作' },
    { id: 'pets', label: '宠物', title: '宠物', sub: '多开、大小、位置与开关' },
    { id: 'look', label: '外观与物理', title: '外观与物理', sub: '拖拽甩抛手感、气泡字体、全局开关' },
    { id: 'ai', label: 'AI 对话', title: 'AI 对话', sub: 'DeepSeek / OpenAI 兼容接口与记忆轮数' },
    { id: 'live', label: '直播接入', title: '直播接入', sub: '抖音弹幕转发、去重与事件映射' },
    { id: 'song', label: '点歌', title: '点歌', sub: '弹幕点歌、队列与版权过滤（默认关闭）' }
  ];

  /** 可选的语音音色（与宿主 VOICES 同一份，写死省掉一次联网拉列表）。 */
  var VOICE_OPTIONS = [
    { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声（温柔，默认）' },
    { value: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声（活泼）' },
    { value: 'zh-CN-YunxiNeural', label: '云希 · 男声（少年）' },
    { value: 'zh-CN-YunjianNeural', label: '云健 · 男声（沉稳）' },
    { value: 'zh-CN-YunyangNeural', label: '云扬 · 男声（播音）' },
    { value: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 女声（东北话）' },
    { value: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 女声（陕西话）' },
    { value: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 女声（台湾腔）' },
    { value: 'zh-HK-HiuMaanNeural', label: '曉曼 · 女声（粤语）' }
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

    // 语音：宿主把「要说的那句话」合成成 mp3，桌面端收到就播。音色走 Edge 朗读接口，需要联网。
    var v = state.voiceCfg || { enabled: true, voice: 'zh-CN-XiaoxiaoNeural', rate: 0, volume: 0.85, maxChars: 120 };
    var vVoice = selectInput(v.voice, VOICE_OPTIONS, function (nv) { v.voice = nv; });
    var vRate = numberInput(v.rate, function (nv) { v.rate = nv; }, { min: '-50', max: '100' });
    var vVol = numberInput(Math.round((v.volume === undefined ? 0.85 : v.volume) * 100), function (nv) { v.volume = nv / 100; }, { min: '0', max: '100' });

    grid.appendChild(card('宠物语音', '弹幕、碎碎念、对话回复都会念出来；音色走 Edge 朗读接口，需联网', [
      toggle(v.enabled !== false, '启用语音', function (nv) { v.enabled = nv; }),
      el('div', { class: 'two' }, [
        field('音色', vVoice),
        field('语速 %', vRate, '-50 慢 ~ +100 快，0 为原速')
      ]),
      field('音量 %', vVol, '只影响桌宠播放的音量，不影响系统音量'),
      el('div', { class: 'row mt-6' }, [
        el('button', { class: 'btn primary', type: 'button', on: { click: function () {
          api(API + '/voice/config', { method: 'POST', body: {
            enabled: v.enabled !== false, voice: v.voice, rate: v.rate,
            volume: v.volume, maxChars: v.maxChars
          } }).then(function (cfg) {
            state.voiceCfg = cfg;
            toast('语音设置已保存');
          }).catch(function (e) { toast(e.message, true); });
        } } }, ['保存语音设置']),
        el('button', { class: 'btn', type: 'button', on: { click: function () {
          api(API + '/voice/test', { method: 'POST', body: { text: '你好呀，我是你的桌面宠物' } })
            .then(function (r) {
              var audio = new Audio(API + '/voice/' + r.name);
              audio.volume = v.volume === undefined ? 0.85 : v.volume;
              var p = audio.play();
              if (p && p.catch) p.catch(function () {});
              toast('已合成，正在播放');
            })
            .catch(function (e) { toast(e.message, true); });
        } } }, ['试听'])
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

  /** 把毫秒时间戳格式化成 HH:MM:SS（互动记录的时间列）。 */
  function clockOf(ts) {
    var d = new Date(ts || Date.now());
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /** 一条互动记录里「内容」列该显示什么：礼物显示礼物名×数量，其余显示正文。 */
  function eventText(ev) {
    if (ev.kind === 'gift') return '礼物 ' + (ev.giftName || '礼物') + (ev.giftCount > 1 ? ' ×' + ev.giftCount : '');
    if (ev.kind === 'enter') return '进场';
    if (ev.kind === 'follow') return '关注';
    if (ev.kind === 'like') return '点赞';
    return ev.text || '';
  }

  /** 一条互动记录的状态标签（已播 / 排队中 / 待抽样 / 被抽样刷掉 / 队列满被挤掉）。 */
  function eventStatus(it) {
    if (it.status === 'played') return '已播';
    if (it.status === 'queued') return '排队中';
    if (it.status === 'pending') return '待抽样';
    if (it.dropReason === 'queue-full') return '队列满';
    return '抽样丢';
  }

  var lastEventSig = '';

  /**
   * 渲染互动记录列表。
   *
   * 每 2 秒被 refreshLive 调用一次，但只有「条数或最新一条 id」变了才重画，
   * 否则每次刷新都会把滚动位置弹回顶部。
   */
  function renderEvents() {
    var box = $('ev-list');
    if (!box) return;
    api(API + '/live/events?limit=120').then(function (r) {
      var items = (r && r.items) || [];
      var sig = items.length + ':' + (items[0] ? items[0].id : 0);
      if (sig === lastEventSig) return;
      lastEventSig = sig;
      box.innerHTML = '';
      if (!items.length) {
        box.appendChild(el('div', { class: 'empty', text: '还没有收到互动。连上直播间后这里会实时出现。' }));
        return;
      }
      items.forEach(function (it) {
        var ev = it.event || {};
        var cls = 'ev' + (ev.kind === 'gift' ? ' gift' : '') + (it.status === 'dropped' ? ' dropped' : '');
        box.appendChild(el('div', { class: cls }, [
          el('span', { class: 't', text: clockOf(it.receivedAt) }),
          el('span', { class: 'who', text: ev.user || '匿名' }),
          el('span', { class: 'txt', text: eventText(ev) }),
          el('span', { class: 'badge' + (ev.kind === 'gift' ? ' gift' : ''), text: eventStatus(it) })
        ]));
      });
    }).catch(function () {});
  }

  function refreshLive() {
    api(API + '/live/status').then(function (st) {
      state.liveStatus = st;
      var map = {
        'live-dot': st.connected ? '已连接' : '未连接',
        'live-recv': String(st.received),
        'live-deliv': String(st.delivered),
        'live-supp': String(st.suppressed),
        'live-queued': String(st.queued || 0),
        'live-drop-sampled': String(st.droppedSampled || 0),
        'live-drop-full': String(st.droppedQueueFull || 0),
        'live-room': st.room || '—',
        'live-mode': st.mode === 'ai' ? 'AI 模式' : '单机模式',
        'ov-live': st.connected ? '已连接' : '未连接',
        'live-last': st.lastEvent ? (st.lastEvent.kind + ' · ' + st.lastEvent.user + ' · ' + (st.lastEvent.text || '')) : '—',
        'live-err': st.lastError || '—',
        'live-collector': st.collector ? (st.collector.running ? '运行中' : (st.collector.configured ? '未运行' : '未配置')) : '未知',
        'live-collector-err': st.collector && st.collector.lastError ? st.collector.lastError : '—'
      };
      Object.keys(map).forEach(function (id) {
        var node = $(id);
        if (node) node.textContent = map[id];
      });
      var pill = $('live-pill');
      if (pill) { pill.className = 'pill ' + (st.connected ? 'ok' : ''); }
      var colPill = $('live-collector-pill');
      if (colPill) { colPill.className = 'pill ' + (st.collector && st.collector.running ? 'ok' : ''); }
      renderEvents();
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
    var modeSelect = el('select');
    [['readonly', '单机模式 · 只读弹幕（不走大模型）'], ['ai', 'AI 模式 · 弹幕交给大模型']].forEach(function (o) {
      var op = el('option', { value: o[0], text: o[1] });
      if ((lc.mode || 'readonly') === o[0]) op.selected = true;
      modeSelect.appendChild(op);
    });

    var grid = el('div', { class: 'grid wide' });

    grid.appendChild(card('抖音弹幕转发', '本地 WS 源；mock:// 为内置模拟源，没有转发器也能试', [
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
      el('div', { class: 'rowline' }, [el('span', { text: '房间' }), el('span', { class: 'badge', id: 'live-room', text: st.room || '—' })]),
      el('div', { class: 'rowline' }, [el('span', { text: '收到 / 已播 / 去重抑制' }), el('span', {}, [
        el('span', { id: 'live-recv', text: String(st.received) }), ' / ',
        el('span', { id: 'live-deliv', text: String(st.delivered) }), ' / ',
        el('span', { id: 'live-supp', text: String(st.suppressed) })
      ])]),
      el('div', { class: 'rowline' }, [el('span', { text: '排队中 / 抽样丢 / 队列满' }), el('span', {}, [
        el('span', { id: 'live-queued', text: String(st.queued || 0) }), ' / ',
        el('span', { id: 'live-drop-sampled', text: String(st.droppedSampled || 0) }), ' / ',
        el('span', { id: 'live-drop-full', text: String(st.droppedQueueFull || 0) })
      ])]),
      el('div', { class: 'rowline' }, [el('span', { text: '采集器' }), el('span', { class: 'pill ' + (st.collector && st.collector.running ? 'ok' : ''), id: 'live-collector-pill' }, [
        el('span', { class: 'dot' }),
        el('span', { id: 'live-collector', text: st.collector ? (st.collector.running ? '运行中' : (st.collector.configured ? '未运行' : '未配置')) : '未知' })
      ])]),
      el('div', { class: 'rowline' }, [el('span', { text: '采集器错误' }), el('span', { class: 'muted', id: 'live-collector-err', text: (st.collector && st.collector.lastError) || '—' })]),
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

    // 排队与抽样：人多时按批抽一半，留下的仍按到达顺序一句一句播；礼物必谢、不参与抽样。
    var q = {
      maxPending: lc.maxPending === undefined ? 50 : lc.maxPending,
      sampleRatio: lc.sampleRatio === undefined ? 0.5 : lc.sampleRatio,
      flushMs: lc.flushMs === undefined ? 3000 : lc.flushMs,
      outputGapMs: lc.outputGapMs === undefined ? 2200 : lc.outputGapMs
    };
    var qMax = numberInput(q.maxPending, function (v) { q.maxPending = v; }, { min: '1', max: '500' });
    var qRatio = numberInput(Math.round(q.sampleRatio * 100), function (v) { q.sampleRatio = v / 100; }, { min: '0', max: '100' });
    var qFlush = numberInput(q.flushMs, function (v) { q.flushMs = v; }, { min: '200', max: '60000' });
    var qGap = numberInput(q.outputGapMs, function (v) { q.outputGapMs = v; }, { min: '200', max: '60000' });

    grid.appendChild(card('排队与抽样', '弹幕太多时按批抽样，留下的仍按先后顺序一句一句播', [
      el('div', { class: 'two' }, [
        liveField('互动最大数', qMax, '也是抽样批量：攒够这么多就抽一次'),
        liveField('保留比例 %', qRatio, '50 = 50 条里随机留一半')
      ]),
      el('div', { class: 'two' }, [
        liveField('批次最长等待 ms', qFlush, '小房间攒不满也按这个间隔抽一次'),
        liveField('两句最小间隔 ms', qGap, '实际间隔还会按字数估的语音时长拉长')
      ]),
      el('p', { class: 'hint', text: '礼物永远不参与抽样，也不会被丢掉；进场/关注/点赞在单机模式下只记日志、不占播报节奏。' }),
      el('div', { class: 'row mt-6' }, [
        el('button', { class: 'btn primary', type: 'button', on: { click: function () {
          api(API + '/live/config', { method: 'POST', body: {
            maxPending: num(qMax.value, 50),
            sampleRatio: num(qRatio.value, 50) / 100,
            flushMs: num(qFlush.value, 3000),
            outputGapMs: num(qGap.value, 2200)
          } }).then(function (cfg) {
            state.liveCfg = cfg;
            toast('排队参数已保存');
            refreshLive();
          }).catch(function (e) { toast(e.message, true); });
        } } }, ['保存排队参数']),
        el('span', { class: 'hint', text: '保存后立即生效，不用重连' })
      ])
    ]));

    // 采集器：填了路径就能让宿主在启动时把它一起拉起来，不用再单开一个终端。
    var colPath = textInput(lc.collectorPath || '', function () {}, { placeholder: '例如 C:\\Users\\你\\.live-pet\\tools\\douyinLive\\douyinLive.exe' });
    var colAuto = el('input', { type: 'checkbox' });
    colAuto.checked = lc.collectorAutoStart !== false;

    grid.appendChild(card('弹幕采集器', '填了路径，启动桌宠时会自动把 douyinLive 拉起来', [
      liveField('采集器可执行文件', colPath, '留空 = 不自动拉起，需要你自己开'),
      el('label', { class: 'switch mb' }, [colAuto, '启动时自动拉起（端口没在听才拉）']),
      el('div', { class: 'row mt-6' }, [
        el('button', { class: 'btn primary', type: 'button', on: { click: function () {
          api(API + '/live/config', { method: 'POST', body: {
            collectorPath: colPath.value.trim(),
            collectorAutoStart: colAuto.checked
          } }).then(function (cfg) {
            state.liveCfg = cfg;
            return api(API + '/live/collector/start', { method: 'POST', body: {} });
          }).then(function (col) {
            var ok = col && col.running;
            toast(ok ? '采集器已在运行' : '采集器未能启动：' + ((col && col.lastError) || '未知原因'), !ok);
            refreshLive();
          }).catch(function (e) { toast(e.message, true); });
        } } }, ['保存并启动']),
        el('button', { class: 'btn', type: 'button', on: { click: function () {
          api(API + '/live/collector/start', { method: 'POST', body: {} })
            .then(function (col) {
              var ok = col && col.running;
              toast(ok ? '采集器已在运行' : '采集器未能启动：' + ((col && col.lastError) || '未知原因'), !ok);
              refreshLive();
            })
            .catch(function (e) { toast(e.message, true); });
        } } }, ['仅启动'])
      ])
    ]));

    $('view').appendChild(grid);

    // 互动记录：收到的全部互动（含被抽样丢弃的），全宽卡片，放在最下面。
    $('view').appendChild(el('div', { class: 'card mt' }, [
      el('div', { class: 'card-head' }, [
        el('div', {}, [
          el('h2', { text: '互动记录' }),
          el('p', { class: 'hint', text: '收到的全部互动，含被抽样刷掉和排队中的；礼物高亮，置灰表示没播出去' })
        ])
      ]),
      el('div', { class: 'evlist', id: 'ev-list' }, [el('div', { class: 'empty', text: '正在读取…' })])
    ]));
    renderEvents();
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(refreshLive, 2000);
    refreshLive();
  }

  // ===== 点歌 =====
  var songTimer = 0;
  var songQueueSig = '';
  var songHistSig = '';

  function saveSongConfig(patch, message) {
    api(API + '/song/config', { method: 'POST', body: patch }).then(function (cfg) {
      state.songCfg = cfg;
      toast(message || '已保存');
      refreshSong();
    }).catch(function (e) { toast(e.message, true); });
  }

  /** 把 textarea 的每行拆成数组（保存时用）。 */
  function lines(textarea) {
    return textarea.value.split('\\n').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
  }

  /** 数组拼回 textarea 文本。 */
  function joinLines(list) {
    return (list || []).join('\\n');
  }

  function songQueueRow(item) {
    var title = item.song ? item.song.title : item.raw;
    var artist = item.song ? item.song.artist : '';
    var review = item.verdict === 'review';
    var btn = el('button', { class: 'btn sm', type: 'button', on: { click: function () {
      api(API + '/song/remove', { method: 'POST', body: { id: item.id } }).then(function (r) {
        state.song = r.status;
        songQueueSig = '';
        updateSong(r.status);
        toast('已移除');
      }).catch(function (e) { toast(e.message, true); });
    } } }, ['移除']);
    return el('div', { class: 'songrow' + (review ? ' review' : '') }, [
      el('span', { class: 't', text: '#' + item.id }),
      el('span', { class: 'who', text: item.user }),
      el('span', { class: 'txt', text: title + (artist ? ' · ' + artist : '') }),
      el('span', { class: 'badge' + (review ? ' gift' : ''), text: review ? '待复核' : '已通过' }),
      btn
    ]);
  }

  function renderSongQueue(st) {
    var box = $('song-queue');
    if (!box) return;
    var items = (st && st.pending) || [];
    var playing = st && st.playing ? st.playing.id : 0;
    var sig = items.length + ':' + (items[0] ? items[0].id : 0) + ':' + playing;
    if (sig === songQueueSig) return;
    songQueueSig = sig;
    box.innerHTML = '';
    if (!items.length) {
      box.appendChild(el('div', { class: 'empty', text: '队列是空的。观众发「点歌 歌名」就会排进来。' }));
      return;
    }
    items.forEach(function (it) { box.appendChild(songQueueRow(it)); });
  }

  function renderSongHistory(st) {
    var box = $('song-history');
    if (!box) return;
    var counts = (st && st.counts) || {};
    var sig = String(counts.played || 0) + ':' + String(counts.failed || 0) + ':' + String(counts.rejected || 0);
    if (sig === songHistSig) return;
    songHistSig = sig;
    box.textContent = '已播 ' + (counts.played || 0) + ' 首 · 失败 ' + (counts.failed || 0) + ' 首 · 拒绝 ' + (counts.rejected || 0) + ' 次';
  }

  /** 状态刷新：只改 DOM 文本，不重建整页（否则输入框会失焦）。 */
  function updateSong(st) {
    if (!st) return;
    var map = {
      'song-enabled': st.enabled ? '已开启' : '已关闭',
      'song-accepting': st.accepting ? '接单中' : '已停单',
      'song-client': st.client && st.client.running ? '运行中' : '未运行',
      'song-title': (st.client && st.client.title) || '—',
      'song-playing': st.playing
        ? ((st.playing.song ? st.playing.song.title : st.playing.raw) + ' · ' + st.playing.user + ' · ' + st.playing.status)
        : '—',
      'song-pending': String((st.pending || []).length),
      'song-accepted': String((st.counts && st.counts.accepted) || 0),
      'song-err': st.lastError || '—'
    };
    Object.keys(map).forEach(function (id) {
      var node = $(id);
      if (node) node.textContent = map[id];
    });
    var pill = $('song-pill');
    if (pill) pill.className = 'pill ' + (st.enabled ? 'ok' : '');
    var cli = $('song-client-pill');
    if (cli) cli.className = 'pill ' + (st.client && st.client.running ? 'ok' : 'warn');
    var acc = $('song-accept-pill');
    if (acc) acc.className = 'pill ' + (st.accepting ? 'ok' : 'warn');
    renderSongQueue(st);
    renderSongHistory(st);
  }

  function refreshSong() {
    api(API + '/song/status').then(function (st) {
      state.song = st;
      updateSong(st);
    }).catch(function () {});
  }

  function renderSong() {
    if (!state.songCfg) {
      $('view').appendChild(el('div', { class: 'empty', text: '正在读取点歌配置…' }));
      api(API + '/song/config').then(function (cfg) {
        state.songCfg = cfg;
        if (state.tab === 'song') render();
      }).catch(function (e) { toast(e.message, true); });
      return;
    }
    // 每次重建页签都要把签名清掉：否则切走再切回来，DOM 是新的、签名还是旧的，
    // 列表会一直停在「正在读取…」。
    songQueueSig = '';
    songHistSig = '';
    var st = state.song || {
      enabled: false, accepting: true, playing: null, pending: [],
      counts: { accepted: 0, played: 0, failed: 0, rejected: 0 },
      client: { running: false, title: '' }
    };
    var cfg = state.songCfg || {
      enabled: false, accepting: true,
      guard: { mode: 'fail-closed', whitelistSongIds: [], blacklistSongIds: [], blacklistArtists: [], bannedWords: [], rejectOverSec: 600 },
      queue: { maxPending: 10, perUserCooldownSec: 300, perUserMaxPerHour: 3, duplicateWindowSec: 1800 },
      playback: { playLimitSec: 240, verifyDelayMs: 3000, pollIntervalMs: 5000, tailMs: 1500 },
      announce: { enabled: true, delayMs: 2500 },
      netease: { exePath: '', autoLaunch: false, launchMinimized: true, commandGapMs: 400 }
    };
    var grid = el('div', { class: 'grid wide' });

    var enableBox = el('input', { type: 'checkbox' });
    enableBox.checked = cfg.enabled === true;
    var acceptBox = el('input', { type: 'checkbox' });
    acceptBox.checked = cfg.accepting !== false;

    grid.appendChild(card('运行状态', '每 2 秒刷新；开关改动立即生效', [
      el('div', { class: 'rowline' }, [el('span', { text: '功能' }), el('span', { class: 'pill ' + (st.enabled ? 'ok' : ''), id: 'song-pill' }, [el('span', { class: 'dot' }), el('span', { id: 'song-enabled', text: st.enabled ? '已开启' : '已关闭' })])]),
      el('div', { class: 'rowline' }, [el('span', { text: '接单' }), el('span', { class: 'pill ' + (st.accepting ? 'ok' : 'warn'), id: 'song-accept-pill' }, [el('span', { class: 'dot' }), el('span', { id: 'song-accepting', text: st.accepting ? '接单中' : '已停单' })])]),
      el('div', { class: 'rowline' }, [el('span', { text: '网易云客户端' }), el('span', { class: 'pill ' + (st.client && st.client.running ? 'ok' : 'warn'), id: 'song-client-pill' }, [el('span', { class: 'dot' }), el('span', { id: 'song-client', text: st.client && st.client.running ? '运行中' : '未运行' })])]),
      el('div', { class: 'rowline' }, [el('span', { text: '当前曲目' }), el('span', { class: 'muted', id: 'song-title', text: (st.client && st.client.title) || '—' })]),
      el('div', { class: 'rowline' }, [el('span', { text: '正在播' }), el('span', { class: 'muted', id: 'song-playing', text: '—' })]),
      el('div', { class: 'rowline' }, [el('span', { text: '排队 / 累计接收' }), el('span', {}, [el('span', { id: 'song-pending', text: '0' }), ' / ', el('span', { id: 'song-accepted', text: '0' })])]),
      el('div', { class: 'rowline' }, [el('span', { text: '最近错误' }), el('span', { class: 'muted', id: 'song-err', text: '—' })]),
      el('label', { class: 'switch mt' }, [enableBox, '启用点歌（观众发「点歌 歌名」）']),
      el('label', { class: 'switch mb' }, [acceptBox, '接单（取消勾选 = 暂停点歌，不动总开关）']),
      el('div', { class: 'row mt-6' }, [
        el('button', { class: 'btn primary', type: 'button', on: { click: function () {
          // 首次开启必须过一道确认：这是唯一会「让直播间响起第三方音乐」的开关，
          // 不能点一下就默认用户已经想清楚了版权问题。
          if (enableBox.checked && cfg.enabled !== true) {
            var agreed = window.confirm('开启后，点歌会把第三方音乐播放到直播间。\\n\\n平台只对自有授权曲库提供许可，网易云能播放不等于抖音有授权。\\n请确认你已获得相应授权，并自行承担版权与平台合规责任。');
            if (!agreed) return;
          }
          saveSongConfig({ enabled: enableBox.checked, accepting: acceptBox.checked }, '设置已保存');
        } } }, ['保存开关']),
        el('button', { class: 'btn', type: 'button', on: { click: function () {
          api(API + '/song/launch', { method: 'POST', body: {} }).then(function (r) {
            state.song = r.status;
            updateSong(r.status);
            toast(r.running ? '客户端已在运行' : '客户端未能启动，请手动打开');
          }).catch(function (e) { toast(e.message, true); });
        } } }, ['启动客户端']),
        el('button', { class: 'btn', type: 'button', on: { click: function () {
          api(API + '/song/skip', { method: 'POST', body: {} }).then(function (r) {
            state.song = r.status;
            songQueueSig = '';
            updateSong(r.status);
            toast(r.skipped ? '已切歌' : '当前没有在播的歌');
          }).catch(function (e) { toast(e.message, true); });
        } } }, ['跳过当前'])
      ]),
      el('p', { class: 'hint mt', text: '版权提示：网易云的「可播放」不等于抖音的「可授权」。默认策略是白名单外一律拒绝，请只加入你确认过授权的曲目。' })
    ]));

    grid.appendChild(card('点歌队列', '按到达顺序播放；判定为「待复核」的条目会高亮', [
      el('div', { class: 'songlist', id: 'song-queue' }, [el('div', { class: 'empty', text: '正在读取…' })]),
      el('div', { class: 'row mt' }, [
        el('button', { class: 'btn', type: 'button', on: { click: function () {
          api(API + '/song/clear', { method: 'POST', body: {} }).then(function (r) {
            state.song = r.status;
            songQueueSig = '';
            updateSong(r.status);
            toast('已清空 ' + r.removed + ' 条');
          }).catch(function (e) { toast(e.message, true); });
        } } }, ['清空队列']),
        el('span', { class: 'hint', text: '正在播的那首不受「清空」影响，需要停下请点「跳过当前」' })
      ])
    ]));

    var manualUser = el('input', { type: 'text', value: '主播' });
    var manualText = el('input', { type: 'text', placeholder: '例如 点歌 蓝莲花' });
    grid.appendChild(card('手工点歌', '自己加一首，走与弹幕完全相同的搜索与过滤', [
      el('div', { class: 'two' }, [
        field('点歌人', manualUser),
        field('内容', manualText)
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn primary', type: 'button', on: { click: function () {
          var text = (manualText.value || '').trim();
          if (!text) { toast('先填歌名', true); return; }
          api(API + '/song/queue', { method: 'POST', body: { user: manualUser.value || '主播', text: text } }).then(function (r) {
            toast(r.message || (r.ok ? '已入队' : '未入队'), !r.ok);
            manualText.value = '';
            songQueueSig = '';
            refreshSong();
          }).catch(function (e) { toast(e.message, true); });
        } } }, ['加入队列']),
        el('span', { class: 'hint', text: '被拒绝时这里会显示原因，和观众听到的一致' })
      ])
    ]));

    var modeSelect = el('select');
    [['fail-closed', '严格：白名单外一律拒绝（推荐）'], ['fail-open', '宽松：白名单外放行，标记待复核']].forEach(function (o) {
      var op = el('option', { value: o[0], text: o[1] });
      if ((cfg.guard.mode || 'fail-closed') === o[0]) op.selected = true;
      modeSelect.appendChild(op);
    });
    var whiteIds = el('textarea', { placeholder: '每行一个 songId，例如 168091' });
    whiteIds.value = joinLines(cfg.guard.whitelistSongIds);
    var blackIds = el('textarea', { placeholder: '每行一个 songId' });
    blackIds.value = joinLines(cfg.guard.blacklistSongIds);
    var blackArtists = el('textarea', { placeholder: '每行一个艺人名，包含即命中' });
    blackArtists.value = joinLines(cfg.guard.blacklistArtists);
    var bannedWords = el('textarea', { placeholder: '每行一个词，命中歌名/艺人/检索词即拒' });
    bannedWords.value = joinLines(cfg.guard.bannedWords);
    var rejectOver = numberInput(cfg.guard.rejectOverSec, function () {}, { min: '0', max: '7200' });

    grid.appendChild(card('版权与内容过滤', '入队前判定；黑名单优先于白名单', [
      field('判定模式', modeSelect),
      el('div', { class: 'two' }, [
        field('白名单 songId', whiteIds, '平台曲库或已获书面授权的曲目'),
        field('黑名单 songId', blackIds, '明确不能播的曲目')
      ]),
      el('div', { class: 'two' }, [
        field('艺人黑名单', blackArtists, '如：周杰伦（包含匹配）'),
        field('敏感词', bannedWords, '涉政/低俗/违禁等，歌名或检索词命中即拒')
      ]),
      field('单曲时长硬上限（秒，0 = 不限）', rejectOver, '整场录音、DJ 串烧在这里挡掉'),
      el('div', { class: 'row mt-6' }, [
        el('button', { class: 'btn primary', type: 'button', on: { click: function () {
          saveSongConfig({
            guard: {
              mode: modeSelect.value,
              whitelistSongIds: lines(whiteIds),
              blacklistSongIds: lines(blackIds),
              blacklistArtists: lines(blackArtists),
              bannedWords: lines(bannedWords),
              rejectOverSec: num(rejectOver.value, 600)
            }
          }, '过滤规则已保存');
        } } }, ['保存过滤规则']),
        el('span', { class: 'hint', text: '保存后立即生效；排队中的条目会在投递前再校验一次' })
      ])
    ]));

    var maxPending = numberInput(cfg.queue.maxPending, function () {}, { min: '1', max: '100' });
    var cooldown = numberInput(cfg.queue.perUserCooldownSec, function () {}, { min: '0', max: '3600' });
    var maxPerHour = numberInput(cfg.queue.perUserMaxPerHour, function () {}, { min: '1', max: '60' });
    var dupWindow = numberInput(cfg.queue.duplicateWindowSec, function () {}, { min: '0', max: '21600' });
    var gapMs = numberInput(cfg.netease.commandGapMs, function () {}, { min: '100', max: '5000' });
    var autoLaunch = el('input', { type: 'checkbox' });
    autoLaunch.checked = cfg.netease.autoLaunch === true;

    grid.appendChild(card('排队与防刷', '人少也要防连点，人多更要防刷歌', [
      el('div', { class: 'two' }, [
        field('待播上限', maxPending),
        field('同曲去重窗口（秒）', dupWindow)
      ]),
      el('div', { class: 'two' }, [
        field('每人冷却（秒）', cooldown),
        field('每人每小时上限', maxPerHour)
      ]),
      el('div', { class: 'two' }, [
        field('两次投递最小间隔（毫秒）', gapMs, '太快客户端可能丢命令'),
        field('启动时预热客户端', el('label', { class: 'switch' }, [autoLaunch, '自动拉起（不投歌）']))
      ]),
      el('div', { class: 'row mt-6' }, [
        el('button', { class: 'btn primary', type: 'button', on: { click: function () {
          saveSongConfig({
            queue: {
              maxPending: num(maxPending.value, 10),
              perUserCooldownSec: num(cooldown.value, 300),
              perUserMaxPerHour: num(maxPerHour.value, 3),
              duplicateWindowSec: num(dupWindow.value, 1800)
            },
            netease: {
              commandGapMs: num(gapMs.value, 400),
              autoLaunch: autoLaunch.checked
            }
          }, '排队参数已保存');
        } } }, ['保存排队参数'])
      ])
    ]));

    var playLimit = numberInput(cfg.playback.playLimitSec, function () {}, { min: '0', max: '3600' });
    var verifyDelay = numberInput(cfg.playback.verifyDelayMs, function () {}, { min: '200', max: '15000' });
    var pollInterval = numberInput(cfg.playback.pollIntervalMs, function () {}, { min: '200', max: '30000' });
    var announceOn = el('input', { type: 'checkbox' });
    announceOn.checked = cfg.announce.enabled !== false;
    var announceDelay = numberInput(cfg.announce.delayMs, function () {}, { min: '0', max: '15000' });

    grid.appendChild(card('播放与播报', '客户端不回执，只能靠「时长 + 窗口标题」两边对', [
      el('div', { class: 'two' }, [
        field('单曲最长播放（秒，0 = 整首）', playLimit, '到点强制切歌，降低整首播放的暴露面'),
        field('播报与投歌间隔（毫秒）', announceDelay, '先念完再起歌，避免两条音频叠在一起')
      ]),
      el('div', { class: 'two' }, [
        field('投递后确认延迟（毫秒）', verifyDelay),
        field('轮询标题间隔（毫秒）', pollInterval)
      ]),
      el('label', { class: 'switch mb' }, [announceOn, '让桌宠报幕（「接下来播放…」）']),
      el('div', { class: 'row mt-6' }, [
        el('button', { class: 'btn primary', type: 'button', on: { click: function () {
          saveSongConfig({
            playback: {
              playLimitSec: num(playLimit.value, 240),
              verifyDelayMs: num(verifyDelay.value, 3000),
              pollIntervalMs: num(pollInterval.value, 5000),
              tailMs: cfg.playback.tailMs
            },
            announce: { enabled: announceOn.checked, delayMs: num(announceDelay.value, 2500) }
          }, '播放参数已保存');
        } } }, ['保存播放参数']),
        el('span', { class: 'hint', text: '版权受限、未登录、id 失效都表现为「客户端没反应」，靠确认延迟兜住' })
      ])
    ]));

    grid.appendChild(card('统计', '只算本次运行，重启归零', [
      el('div', { class: 'rowline' }, [el('span', { text: '累计' }), el('span', { class: 'muted', id: 'song-history', text: '—' })]),
      el('p', { class: 'hint', text: '被拒绝的请求不会进队列，也不会消耗他人的排队位置。' })
    ]));

    $('view').appendChild(grid);
    refreshSong();
    if (songTimer) clearInterval(songTimer);
    songTimer = setInterval(refreshSong, 2000);
  }

  function render() {
    var tab = TABS.filter(function (t) { return t.id === state.tab; })[0] || TABS[0];
    $('title').textContent = tab.title;
    $('subtitle').textContent = tab.sub;
    $('view').innerHTML = '';
    if (liveTimer) { clearInterval(liveTimer); liveTimer = 0; }
    if (songTimer) { clearInterval(songTimer); songTimer = 0; }
    renderNav();
    renderActions();
    if (!state.cfg) return;
    if (state.tab === 'overview') renderOverview();
    else if (state.tab === 'pets') renderPets();
    else if (state.tab === 'look') renderLook();
    else if (state.tab === 'ai') renderAi();
    else if (state.tab === 'live') renderLive();
    else if (state.tab === 'song') renderSong();
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
      api(API + '/live/status').catch(function () { return null; }),
      api(API + '/voice/config').catch(function () { return null; })
    ]).then(function (res) {
      state.cfg = res[0];
      state.ai = res[1] || {};
      state.liveCfg = res[2] || null;
      state.liveStatus = res[3] || null;
      state.voiceCfg = res[4] || null;
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
