/*
 * 研词 · 应用入口
 * ------------------------------------------------------------
 * 视图：今日 / 词库 / 词根 / 统计 + 单词详情抽屉 + 设置弹窗
 * 依赖：KY_WORDS, KY_AFFIX, KY_MORPH, KY_STORE, KY_SRS, KY_QUEUE
 *
 * 想加新视图：
 *   1. 在 index.html 的 #tabs 里加一个 data-view
 *   2. 在 VIEWS 里注册同名渲染函数
 *   3. 需要的话在 CSS 里补样式
 */
(function (global) {
  'use strict';

  var DATA = global.KY_WORDS;
  var ALL_WORDS = DATA.words;
  var META = DATA.meta;
  var S = global.KY_STORE;
  var SRS = global.KY_SRS;
  var Q = global.KY_QUEUE;
  var M = global.KY_MORPH;
  var EX = global.KY_EXAM;

  var BASIC = new Set((global.KY_BASIC_WORDS || []).map(function (w) { return String(w).toLowerCase(); }));

  // 同根词索引：只收「有前后缀」或「整词就是词根」的高置信匹配。
  // FAMILY_EXCLUDE 是人工校正表：自动拆解难免把 often/seven/sister 这类
  // 形似词收进词族，发现一个就往这里加一个即可，无需改算法。
  var FAMILY_EXCLUDE = new Set([
    'often', 'ten', 'even', 'seven', 'evening', 'sister', 'college', 'legal',
    'religious', 'religion', 'oblige', 'obligation', 'secure', 'security',
    'accurate', 'accuracy', 'curious', 'surface', 'postman', 'main', 'face',
    'invite', 'invitation', 'see', 'keep', 'avoid', 'spicy', 'fake', 'superficial'
  ]);

  var MORPH_CACHE = new Map();
  var WORDS = [];            // 当前展示的词（可能已过滤基础虚词）
  var BY_WORD = new Map();   // word -> 词条
  var BY_LOWER = new Map();  // lower -> 原始词条 key
  var FAMILY = {};           // rootKey -> [word]
  var ROOT_COUNTS = {};      // rootKey -> 词数
  var ROOTED = new Set();    // 已归入词根词族的词

  function morphOf(word) {
    if (!MORPH_CACHE.has(word)) MORPH_CACHE.set(word, M.decompose(word));
    return MORPH_CACHE.get(word);
  }

  /*
   * 重建所有派生索引。切换「显示基础虚词」、或将来导入自定义词表后
   * 调用这个函数即可，不需要刷新页面。
   */
  /*
   * 规则拆解失败时，从逐词解析的「词根: xxx」一行里取词根，
   * 只接受与词根变体完全相等的结果，避免把解释里顺带提到的词误收进来。
   */
  function noteRootKey(w) {
    if (!w.rt) return null;
    var m = String(w.rt).replace(/\s+/g, ' ').match(/词根\s*[:：]?\s*["“'\-]?([a-zA-Z][a-zA-Z-]{1,20})/);
    if (!m) return null;
    var token = m[1].toLowerCase().replace(/^-+|-+$/g, '');
    for (var i = 0; i < M.roots.length; i++) {
      var vars = M.roots[i].vars;
      for (var j = 0; j < vars.length; j++) {
        if (vars[j] === token) return M.roots[i].k;
      }
    }
    return null;
  }

  function buildIndexes() {
    var hideBasic = S.getSettings().hideBasic !== false;
    var removed = S.get().removed || {};
    WORDS = ALL_WORDS.filter(function (w) {
      if (removed[w.w]) return false;
      return !(hideBasic && BASIC.has(w.w.toLowerCase()));
    });

    BY_WORD = new Map();
    BY_LOWER = new Map();
    WORDS.forEach(function (w, i) {
      w._i = i;                 // 在当前词表中的序号（= 高频排名）
      BY_WORD.set(w.w, w);
      BY_LOWER.set(w.w.toLowerCase(), w.w);
    });

    FAMILY = {};
    ROOTED = new Set();
    WORDS.forEach(function (w) {
      if (FAMILY_EXCLUDE.has(w.w)) return;
      var d = morphOf(w.w);
      var key = null;
      if (d.rootKey) {
        var hasAffix = d.parts.some(function (p) { return p.type === 'prefix' || p.type === 'suffix'; });
        var pureRoot = d.parts.length === 1 && d.parts[0].type === 'root';
        if (hasAffix || pureRoot) key = d.rootKey;
      }
      if (!key) key = noteRootKey(w);
      if (!key) return;
      (FAMILY[key] = FAMILY[key] || []).push(w.w);
      ROOTED.add(w.w);
    });

    ROOT_COUNTS = {};
    Object.keys(FAMILY).forEach(function (k) { ROOT_COUNTS[k] = FAMILY[k].length; });
    global.KY_VOCAB_SET = new Set(ALL_WORDS.map(function (w) { return w.w.toLowerCase(); }));
  }

  var state = {
    view: 'today',
    session: null,
    lib: { q: '', status: 'all', cefr: 'all', band: 'all', pos: 'all', letter: 'all', sort: 'freq', limit: 90 },
    rootKey: null,
    rootQuery: '',
    paperTab: 'library',
    paperFilter: { year: 'all', type: 'all' },
    exam: null
  };

  /* ---------- 小工具 ---------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var toastTimer = null;
  var toastAction = null;
  function toast(msg, actionLabel, action) {
    var el = $('#toast');
    el.innerHTML = '<span>' + esc(msg) + '</span>' +
      (actionLabel ? '<button class="toast-action" id="toastAction">' + esc(actionLabel) + '</button>' : '');
    toastAction = action || null;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
      toastAction = null;
    }, actionLabel ? 15000 : 1800);
  }

  function todayPlan() {
    return SRS.buildPlan(WORDS);
  }

  function fmtNum(n) {
    if (n >= 10000) return (n / 1000).toFixed(1).replace('.0', '') + 'k';
    return String(n);
  }

  function cleanPhonetic(p) {
    return String(p || '').split(/[;；]/)[0]
      .replace(/\(also\)/ig, '')
      .replace(/^\/+|\/+$/g, '')
      .trim();
  }

  function bandOf(f) {
    if (f >= 500) return { key: 'S', label: '超高频', tone: 'danger' };
    if (f >= 100) return { key: 'A', label: '高频', tone: 'warning' };
    if (f >= 40) return { key: 'B', label: '常考', tone: 'info' };
    if (f >= 10) return { key: 'C', label: '中频', tone: 'accent' };
    return { key: 'D', label: '低频', tone: '' };
  }

  var POS_LABEL = {
    n: 'n.', v: 'v.', adj: 'adj.', adv: 'adv.', prep: 'prep.',
    conj: 'conj.', pron: 'pron.', num: 'num.', art: 'art.',
    int: 'int.', aux: 'aux.', abbr: 'abbr.'
  };
  var POS_CN = {
    n: '名词', v: '动词', adj: '形容词', adv: '副词', prep: '介词',
    conj: '连词', pron: '代词', num: '数词', art: '冠词',
    int: '感叹词', aux: '助动词', abbr: '缩写'
  };

  function posList(w) { return (w && w.p) ? w.p : []; }
  function posText(w, max) {
    var arr = posList(w).slice(0, max || 3).map(function (p) { return POS_LABEL[p] || (p + '.'); });
    return arr.join(' / ');
  }
  function hasPos(w, p) { return posList(w).indexOf(p) !== -1; }

  function pips(lv) {
    var out = '';
    for (var i = 1; i <= 5; i++) {
      out += '<i class="pip" data-on="' + (i <= lv ? lv : 0) + '"></i>';
    }
    return '<span class="level-pips" title="熟悉度 ' + (lv || 0) + '/5">' + out + '</span>';
  }

  function levelName(lv) {
    var row = SRS.LEVELS[lv] || SRS.LEVELS[0];
    return row.name;
  }

  function dueLabel(rec) {
    if (!rec || !rec.due) return '';
    var today = S.todayStr();
    if (rec.due < today) return '逾期' + S.diffDays(today, rec.due) + '天';
    if (rec.due === today) return '今天';
    var d = S.diffDays(rec.due, today);
    return d === 1 ? '明天' : d + '天后';
  }

  /* ---------- 发音 ---------- */

  var VOICES = [];
  var audioEl = null;
  var audioText = '';

  function refreshVoices() {
    if (!('speechSynthesis' in global)) return;
    try { VOICES = global.speechSynthesis.getVoices() || []; } catch (e) { VOICES = []; }
  }

  /* 优先挑一个高质量英文语音；宁可提示，也不要拿中文语音硬读 */
  function pickEnglishVoice() {
    if (!VOICES.length) refreshVoices();
    var best = null, bestScore = -1;
    VOICES.forEach(function (v) {
      var name = (v.name || '').toLowerCase();
      var lang = (v.lang || '').toLowerCase();
      var score = -1;
      if (lang.indexOf('en-us') === 0) score = 30;
      else if (lang.indexOf('en-gb') === 0) score = 26;
      else if (lang.indexOf('en') === 0) score = 22;
      else return;
      if (/google/.test(name)) score += 24;
      if (/natural|neural|premium|enhanced|siri/.test(name)) score += 18;
      if (/aria|jenny|guy|samantha|alex|daniel|karen|moira|tessa|zira|david|mark|allison|ava|tom/.test(name)) score += 10;
      if (lang.indexOf('zh') === 0 || /chinese|中文/.test(name)) score -= 60;
      if (v.localService) score += 2;
      if (score > bestScore) { bestScore = score; best = v; }
    });
    return bestScore > 0 ? best : null;
  }

  function speakSystem(text, rate) {
    if (!('speechSynthesis' in global)) {
      toast('当前浏览器不支持系统语音，可在设置里切换在线发音');
      return;
    }
    try {
      if (audioEl) audioEl.pause();
      global.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      var v = pickEnglishVoice();
      if (!v && VOICES.length) {
        toast('系统里没有英文语音，建议到设置切换「在线发音」');
        return;
      }
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-US'; }
      u.rate = rate || 0.9;
      u.pitch = 1;
      u.volume = 1;
      global.speechSynthesis.speak(u);
    } catch (e) {
      toast('发音失败，请检查系统语音');
    }
  }

  function speakYoudao(text) {
    try {
      audioText = text;
      if (audioEl) global.speechSynthesis && global.speechSynthesis.cancel();
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.addEventListener('error', function () {
          toast('在线发音失败，已切回系统语音');
          if (audioText) speakSystem(audioText);
        });
      }
      audioEl.pause();
      audioEl.currentTime = 0;
      audioEl.src = 'https://dict.youdao.com/dictvoice?audio=' +
        encodeURIComponent(text) + '&type=2';   // 2 = 美音
      var p = audioEl.play();
      if (p && p.catch) p.catch(function () { speakSystem(text); });
    } catch (e) {
      speakSystem(text);
    }
  }

  function speak(text, sourceOverride) {
    if (!text) return;
    if (sourceOverride === 'youdao' || (!sourceOverride && S.getSettings().audioSource === 'youdao')) {
      speakYoudao(text);
    } else {
      speakSystem(text);
    }
  }

  function greeting() {
    var h = new Date().getHours();
    if (h < 5) return '夜深了';
    if (h < 11) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  function dateCN() {
    var d = new Date();
    var w = '日一二三四五六'[d.getDay()];
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · 周' + w;
  }

  /* ---------- 构词块 ---------- */

  function cleanNote(t) {
    return String(t || '')
      .replace(/^\s*(词根|词缀|前缀|后缀)\s*[:：]?\s*/, '')
      .replace(/^[\s"“”']+/, '')
      .trim();
  }

  function morphHTML(word, compact) {
    var d = morphOf(word);
    if (d.confidence < 0.5 && d.parts.length === 1) {
      return '<div class="morph-note" style="margin-top:0">这是一个基础词，没有常见的词根词缀拆分。可以结合下方词源与例句整体记忆。</div>';
    }
    var chips = d.parts.map(function (p) {
      var type = p.type;
      var label = { prefix: '前缀', root: '词根', suffix: '后缀', base: '词干' }[type] || '';
      return '<span class="chip" data-type="' + type + '">' + esc(p.text) +
        '<small>' + label + (p.gloss ? ' · ' + esc(p.gloss) : '') + '</small></span>';
    }).join('<span class="chip-plus">+</span>');

    var html = '<div class="chips">' + chips + '</div>';

    var rootPart = null;
    d.parts.forEach(function (p) { if (p.type === 'root' && !rootPart) rootPart = p; });

    var notes = [];
    if (rootPart && rootPart.note) notes.push('<div><b>词源</b> · ' + esc(rootPart.note) + '</div>');
    if (rootPart && rootPart.ex && rootPart.ex.length) {
      notes.push('<div><b>同根例词</b> · ' + esc(rootPart.ex.slice(0, 6).join('、')) + '</div>');
    }
    if (d.confidence < 0.5) {
      notes.push('<div class="faint">规则库未找到可靠的词根拆解，请参考下方逐词整理。</div>');
    }
    if (notes.length) html += '<div class="root-detail">' + notes.join('') + '</div>';
    return html;
  }

  /* ---------- 今日 ---------- */

  function renderToday() {
    var plan = todayPlan();
    var settings = S.getSettings();
    var left = SRS.daysLeft();
    var learned = plan.started;
    var mastered = 0;
    var dueCount = 0;
    WORDS.forEach(function (w) {
      var r = S.word(w.w);
      if (!r || !r.first) return;
      if (r.lv >= 4) mastered++;
      if (r.due && r.due <= S.todayStr()) dueCount++;
    });

    var pct = plan.total ? (learned / plan.total * 100) : 0;
    var todayDone = plan.learnedToday.length;
    var todayTarget = settings.dailyNew;

    if (state.session) {
      return '<div class="focus-head">' +
        '<div><b>今日学习</b> <span class="faint small">· ' + plan.learnedToday.length + ' / ' + todayTarget + ' 新词</span></div>' +
        '<div class="tiny faint">空格显示答案 · 1–4 评分</div>' +
      '</div>' +
      '<div class="study-grid">' +
        '<section class="card study-card" id="studyCard">' + studyHTML(plan) + '</section>' +
        '<aside class="side-stack">' + checklistHTML(plan) + levelDistHTML() + '</aside>' +
      '</div>';
    }

    var html = '<div class="hero">' +
      '<div class="card hero-main">' +
        '<h1>' + greeting() + '，今天也背一点。</h1>' +
        '<div class="sub">' + dateCN() +
          (left != null ? ' · 距考研还有 <b>' + left + '</b> 天' : '') + '</div>' +
        '<div class="kpi-row">' +
          kpi(learned, '已开始学习 / ' + plan.total) +
          kpi(mastered, '已掌握（≥熟练）') +
          kpi(dueCount, '今日待复习') +
          kpi(todayDone + ' / ' + todayTarget, '今日新词') +
        '</div>' +
        '<div class="progress-track"><div class="progress-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
        '<div class="progress-legend"><span>总进度 ' + pct.toFixed(1) + '%</span><span>剩余 ' + (plan.total - learned) + ' 词</span></div>' +
        heroFoot(plan) +
      '</div>' +
      '<div class="hero-side">' +
        '<div class="card today-card">' +
          '<div class="row"><span class="faint small">今日任务</span><span class="badge" data-tone="accent">' + (plan.newList.length + plan.dueList.length) + ' 词待完成</span></div>' +
          '<div class="split">' +
            '<div class="mini-stat"><div class="v">' + (plan.newList.length) + '</div><div class="k">新词（额度 ' + plan.quota + '）</div></div>' +
            '<div class="mini-stat"><div class="v">' + (plan.dueList.length) + '</div><div class="k">到期复习</div></div>' +
          '</div>' +
          '<button class="btn btn-primary btn-block" id="startBtn">' +
            (plan.newList.length + plan.dueList.length ? '开始学习 →' : '今日任务已完成 ✓') +
          '</button>' +
          '<div class="tiny faint" style="text-align:center">空格显示答案 · 1–4 评分</div>' +
        '</div>' +
      '</div>' +
    '</div>';

    /* 学习区 */
    html += '<div class="study-grid" style="margin-top:16px">' +
      '<section class="card study-card" id="studyCard">' + studyHTML(plan) + '</section>' +
      '<aside class="side-stack">' + checklistHTML(plan) + levelDistHTML() + '</aside>' +
    '</div>';

    return html;
  }

  function heroFoot(plan) {
    var p = SRS.projection(WORDS);
    var st = S.getSettings();
    return '<div class="hero-foot">' +
      '<div class="hf"><span>按每日 ' + st.dailyNew + ' 词</span><b>约 ' + p.needDays + ' 天完成</b></div>' +
      '<div class="hf"><span>考试前需要</span><b>' + p.perDayNeeded + ' 词 / 天</b></div>' +
      '<div class="hf"><span>计划状态</span><b class="' + (p.onTrack ? 'ok' : 'warn') + '">' +
        (p.onTrack == null ? '未设置考试日期' : p.onTrack ? '进度安全' : '需要加速') + '</b></div>' +
    '</div>';
  }

  function kpi(n, label) {
    return '<div class="kpi"><div class="n">' + n + '</div><div class="l">' + label + '</div></div>';
  }

  function studyHTML(plan) {
    if (!state.session) {
      var preview = plan.dueList.slice(0, 3).map(function (w) { return { w: w, tag: '复习' }; })
        .concat(plan.newList.slice(0, 5).map(function (w) { return { w: w, tag: '新词' }; }));

      if (!preview.length) {
        return '<div class="study-body" style="display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:12px;min-height:330px">' +
          '<div class="badge" data-tone="success">今日完成</div>' +
          '<div style="font-family:var(--font-serif);font-size:26px;line-height:1.35">今天的额度已经清空。</div>' +
          '<div class="muted" style="max-width:44ch;font-size:13.5px">可以去词库自由翻看，或者去设置里调整每日新词量。明天的复习已经自动排好。</div>' +
        '</div>';
      }

      return '<div class="study-head">' +
        '<div class="queue-label"><span class="badge" data-tone="accent">今日预览</span>' +
          '<span>复习 ' + plan.dueList.length + ' · 新词 ' + plan.newList.length + '</span></div>' +
        '<span class="tiny faint">点单词看词根</span>' +
      '</div>' +
      '<div class="study-body" style="min-height:330px;padding-top:18px">' +
        preview.map(function (it) {
          var w = it.w, rec = S.word(w.w), band = bandOf(w.f);
          return '<div class="preview-row" data-open="' + esc(w.w) + '">' +
            '<span class="badge" data-tone="' + (it.tag === '复习' ? 'info' : 'accent') + '">' + it.tag + '</span>' +
            '<span class="pv-w">' + esc(w.w) + '</span>' +
            '<span class="pv-t">' + (posText(w, 2) ? '<span class="pos-tag">' + esc(posText(w, 2)) + '</span>' : '') + esc(w.t) + '</span>' +
            '<span class="pv-f mono tiny">' + band.label + ' ' + w.f + '</span>' +
            pips(rec && rec.first ? rec.lv : 0) +
          '</div>';
        }).join('') +
        '<div class="tiny faint" style="margin-top:14px">这一轮会按「到期复习 → 新词」的顺序进行；每个词评分后自动安排下次复习日期。</div>' +
      '</div>';
    }

    var sess = state.session;
    if (sess.i >= sess.queue.length) return summaryHTML();

    var item = sess.queue[sess.i];
    var w = item.w;
    var rec = S.word(w.w);
    var band = bandOf(w.f);
    var mor = morphOf(w.w);

    var html = '<div class="study-head">' +
      '<div class="queue-label">' +
        '<span class="badge" data-tone="' + (item.kind === 'new' ? 'accent' : item.kind === 'relearn' ? 'danger' : 'info') + '">' +
          (item.kind === 'new' ? '新词' : item.kind === 'relearn' ? '重来' : '复习') + '</span>' +
        '<span>' + (sess.i + 1) + ' / ' + sess.queue.length + '</span>' +
        '<span class="faint">·</span><span>' + (sess.done) + ' 已完成</span>' +
      '</div>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<button class="icon-btn" data-act="speak" data-speak="' + esc(w.w) + '" title="发音" style="width:30px;height:30px"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg></button>' +
        '<button class="icon-btn" data-act="star" title="收藏" style="width:30px;height:30px">' + (S.starred(w.w) ? '★' : '☆') + '</button>' +
        '<button class="btn btn-sm btn-ghost" data-act="end">结束</button>' +
      '</div>' +
    '</div>';

    html += '<div class="study-body">' +
      '<div class="word-line"><h2>' + esc(w.w) + '</h2>' +
        (cleanPhonetic(w.ph) ? '<span class="phon">/' + esc(cleanPhonetic(w.ph)) + '/</span>' : '') +
      '</div>' +
      '<div class="word-meta">' +
        '<span class="badge" data-tone="' + band.tone + '">' + band.label + ' · 词频 ' + w.f + '</span>' +
        '<span class="badge">#' + (w._i + 1) + '</span>' +
        (posText(w, 3) ? '<span class="badge" data-tone="accent" title="' + esc(posList(w).map(function (p) { return POS_CN[p] || p; }).join('、')) + '">' + esc(posText(w, 3)) + '</span>' : '') +
        (w.cefr ? '<span class="badge">CEFR ' + w.cefr + '</span>' : '') +
        (w.acad ? '<span class="badge">学术词汇</span>' : '') +
        (w.adv ? '<span class="badge">高级词汇</span>' : '') +
        (rec && rec.due ? '<span class="badge" data-tone="info">' + dueLabel(rec) + '</span>' : '') +
      '</div>';

    if (!sess.revealed) {
      html += '<div style="margin-top:34px;padding:26px;border-radius:12px;border:1px dashed var(--border-strong);background:var(--bg-sunken);text-align:center">' +
        '<div class="muted" style="font-size:13.5px">先在心里回想它的意思' +
          (w.ph ? '与读音' : '') + '，再显示答案。</div>' +
        '<button class="btn btn-primary" style="margin-top:14px" data-act="reveal">显示释义（空格）</button>' +
      '</div>';
    } else {
      html += '<p class="sense">' +
        (posText(w, 2) ? '<span class="pos">' + esc(posText(w, 2)) + '</span>' : '') +
        esc(w.t) + '</p>';
      if (w.ex) {
        html += '<div class="example"><div class="en">' + esc(w.ex) + '</div>' +
          (w.exz ? '<div class="zh">' + esc(w.exz) + '</div>' : '') +
          (w.exs ? '<div class="src">' + esc(w.exs) + '</div>' : '') + '</div>';
      }
      html += '<div class="morph"><div class="morph-title">词根词缀拆解</div>' + morphHTML(w.w) + '</div>';

      var notes = [];
      if (w.rt) notes.push('<div><b>词根</b> ' + esc(cleanNote(w.rt)) + '</div>');
      if (w.af) notes.push('<div><b>词缀</b> ' + esc(cleanNote(w.af)) + '</div>');
      if (notes.length) html += '<div class="morph" style="border-style:solid;background:transparent"><div class="morph-title">逐词解析</div><div class="morph-note">' + notes.join('') + '</div></div>';

      var fam = FAMILY[mor.rootKey] || [];
      if (fam.length > 1) {
        html += '<div class="detail-block"><h4>同根词 · ' + esc(mor.rootKey) + '</h4><div class="family-list">' +
          fam.filter(function (x) { return x !== w.w; }).slice(0, 14).map(function (x) {
            return '<button data-open="' + esc(x) + '">' + esc(x) + '</button>';
          }).join('') + '</div></div>';
      }
    }
    html += '</div>';

    if (sess.revealed) {
      html += '<div class="grade-bar">' + [1, 2, 3, 4].map(function (g) {
        var nx = SRS.next(rec || { lv: 0, iv: 0, reps: 0, lapses: 0, ease: 2.5 }, g);
        var label = ['', '忘记', '模糊', '认识', '秒杀'][g];
        var when = nx.iv ? nx.iv + ' 天后' : '今天再来';
        return '<button class="grade-btn" data-grade="' + g + '">' + label +
          '<span class="k">' + when + '</span></button>';
      }).join('') + '</div>';
    } else {
      html += '<div class="reveal-hint"><span class="kbd">空格</span><span class="small faint">显示答案</span></div>';
    }

    return html;
  }

  function summaryHTML() {
    var sess = state.session;
    return '<div class="study-body" style="display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:12px;min-height:360px">' +
      '<div class="badge" data-tone="success">本次完成</div>' +
      '<div style="font-family:var(--font-serif);font-size:28px">这一轮结束了。</div>' +
      '<div class="kpi-row" style="margin:8px 0 4px">' +
        kpi(sess.done, '学习了') + kpi(sess.counts[1] || 0, '忘记') +
        kpi(sess.counts[3] + sess.counts[4], '记住') + kpi(sess.startedAt ? Math.max(1, Math.round((Date.now() - sess.startedAt) / 60000)) + ' 分' : '1 分', '用时') +
      '</div>' +
      '<div class="muted small">下一批复习已经按遗忘曲线排好，明天见。</div>' +
      '<div style="display:flex;gap:8px;margin-top:6px">' +
        '<button class="btn btn-primary" data-act="restart">再来一轮</button>' +
        '<button class="btn" data-act="end">回到今日</button>' +
      '</div>' +
    '</div>';
  }

  function checklistHTML(plan) {
    var list = plan.dueList.map(function (w) { return { w: w, kind: '复习' }; })
      .concat(plan.newList.map(function (w) { return { w: w, kind: '新词' }; }));
    if (!list.length) {
      return '<div class="card side-card"><h3>今日清单</h3><div class="muted small">今天的任务已经清空。去词库逛逛，或调整每日计划。</div></div>';
    }
    var items = list.map(function (it) {
      var w = it.w, rec = S.word(w.w);
      var checked = !!(rec && rec.first === S.todayStr());
      return '<div class="check-item">' +
        '<input type="checkbox" data-check="' + esc(w.w) + '" aria-label="标记 ' + esc(w.w) + ' 今天背过"' + (checked ? ' checked' : '') + '>' +
        '<span class="ci-main"><span class="ci-w">' + esc(w.w) + '</span>' +
          '<span class="ci-t">' + esc(w.t) + '</span></span>' +
        '<select class="ci-level" data-level-for="' + esc(w.w) + '" aria-label="' + esc(w.w) + ' 的熟悉程度" title="熟悉程度">' +
          [0, 1, 2, 3, 4, 5].map(function (lv) {
            return '<option value="' + lv + '"' + ((rec && rec.first ? rec.lv : 0) === lv ? ' selected' : '') + '>' + levelName(lv) + '</option>';
          }).join('') +
        '</select>' +
      '</div>';
    }).join('');

    return '<div class="card side-card">' +
      '<h3>今日清单 · ' + list.length + ' 词</h3>' +
      '<div class="tiny faint" style="margin-bottom:8px">勾选表示今天背过；右侧下拉选择熟悉度。</div>' +
      '<div class="check-list">' + items + '</div>' +
    '</div>';
  }

  function levelDistHTML() {
    var counts = [0, 0, 0, 0, 0, 0];
    WORDS.forEach(function (w) {
      var r = S.word(w.w);
      counts[r && r.first ? r.lv : 0]++;
    });
    var total = WORDS.length;
    return '<div class="card side-card"><h3>熟悉度分布</h3>' +
      counts.map(function (n, lv) {
        var pct = total ? n / total * 100 : 0;
        return '<div style="margin:7px 0">' +
          '<div class="legend-row"><span><span class="dot" style="background:' + (lv === 0 ? 'var(--fg-faint)' : 'var(--level-' + lv + ')') + '"></span>' +
          levelName(lv) + '</span><span class="mono tiny">' + n + '</span></div>' +
          '<div class="queue-bar" style="margin:4px 0 0"><i style="width:' + pct + '%;background:' + (lv === 0 ? 'var(--fg-faint)' : 'var(--level-' + lv + ')') + '"></i></div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  /* ---------- 学习流程 ---------- */

  function startSession() {
    var plan = todayPlan();
    var settings = S.getSettings();
    var due = plan.dueList.slice(0, settings.reviewLimit || 150);
    var queue = due.map(function (w) { return { w: w, kind: 'review' }; })
      .concat(plan.newList.map(function (w) { return { w: w, kind: 'new' }; }));
    if (!queue.length) { toast('今天没有待学单词'); return; }
    state.session = { queue: queue, i: 0, revealed: false, done: 0, counts: { 1: 0, 2: 0, 3: 0, 4: 0 }, startedAt: Date.now() };
    render();
  }

  function focusCard() {
    var el = $('.study-card');
    if (el) {
      var y = el.getBoundingClientRect().top + window.scrollY - 62;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }
  }

  function reveal() {
    if (!state.session || state.session.revealed) return;
    state.session.revealed = true;
    render();
    focusCard();
  }

  function grade(g) {
    var sess = state.session;
    if (!sess || !sess.revealed) return;
    var item = sess.queue[sess.i];
    var w = item.w;
    SRS.grade(w.w, g);
    sess.counts[g] = (sess.counts[g] || 0) + 1;
    sess.done++;
    // 忘记的词排到队尾再练一次
    if (g === 1) sess.queue.push({ w: w, kind: 'relearn' });
    sess.i++;
    sess.revealed = false;
    render();
    focusCard();
  }

  function toggleCheck(word) {
    var rec = S.word(word);
    var today = S.todayStr();
    if (rec && rec.first === today) {
      // 撤销今天的记录
      S.removeWord(word);
      var d = S.day();
      d.new = d.new.filter(function (x) { return x !== word; });
      d.review = d.review.filter(function (x) { return x !== word; });
      S.save();
    } else {
      S.setWord(word, {
        lv: Math.max(1, rec ? rec.lv : 0),
        iv: 1,
        due: S.addDays(today, 1),
        reps: (rec ? rec.reps : 0) + 1,
        lapses: rec ? rec.lapses : 0,
        first: today,
        last: today
      });
      var day = S.day();
      if (day.new.indexOf(word) === -1) day.new.push(word);
      S.touchStreak();
      S.save();
    }
    render();
  }

  /* ---------- 词库 ---------- */

  function filteredWords() {
    var f = state.lib;
    var q = f.q.trim().toLowerCase();
    var out = [];
    for (var i = 0; i < WORDS.length; i++) {
      var w = WORDS[i];
      if (q && w.w.toLowerCase().indexOf(q) === -1 && w.t.indexOf(q) === -1) continue;
      if (f.cefr !== 'all' && w.cefr !== f.cefr) continue;
      if (f.pos === 'other') {
        if (!w.p || w.p.some(function (p) { return ['n', 'v', 'adj', 'adv'].indexOf(p) !== -1; })) continue;
      } else if (f.pos !== 'all' && !hasPos(w, f.pos)) continue;
      if (f.band !== 'all' && bandOf(w.f).key !== f.band) continue;
      if (f.letter !== 'all' && w.w[0].toLowerCase() !== f.letter) continue;
      var rec = S.word(w.w);
      var lv = rec && rec.first ? rec.lv : 0;
      switch (f.status) {
        case 'new': if (rec && rec.first) continue; break;
        case 'due': if (!(rec && rec.due && rec.due <= S.todayStr())) continue; break;
        case 'known': if (lv < 4) continue; break;
        case 'learning': if (!(rec && rec.first && lv < 4)) continue; break;
        case 'star': if (!S.starred(w.w)) continue; break;
        case 'note': if (!S.note(w.w)) continue; break;
        case 'noroot': if (ROOTED.has(w.w)) continue; break;
      }
      out.push(w);
    }
    if (f.sort === 'alpha') out.sort(function (a, b) { return a.w.localeCompare(b.w); });
    else if (f.sort === 'rerank') out.sort(function (a, b) { return a.rk - b.rk; });
    else if (f.sort === 'freq') out.sort(function (a, b) { return b.f - a.f; });
    else if (f.sort === 'level') out.sort(function (a, b) {
      var ra = S.word(a.w), rb = S.word(b.w);
      return ((rb && rb.lv) || 0) - ((ra && ra.lv) || 0) || b.f - a.f;
    });
    return out;
  }

  var libObserver = null;

  function loadMoreLibrary() {
    if (state.view !== 'library' || state.lib.loading) return;
    if (state.lib.limit >= (state.lib.total || 0)) return;
    state.lib.loading = true;
    state.lib.limit += 120;
    render();
    setTimeout(function () { state.lib.loading = false; }, 350);
  }

  function setupLibObserver() {
    if (libObserver) { libObserver.disconnect(); libObserver = null; }
    if (state.view !== 'library' || !('IntersectionObserver' in global)) return;
    var el = $('#libSentinel');
    if (!el) return;
    libObserver = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) loadMoreLibrary();
    }, { rootMargin: '400px' });
    libObserver.observe(el);
  }

  function renderLibrary() {
    var f = state.lib;
    var list = filteredWords();
    state.lib.total = list.length;
    var shown = list.slice(0, f.limit);
    var letters = 'abcdefghijklmnopqrstuvwxyz'.split('');

    var html = '<div class="section-title"><h2>词库 · ' + WORDS.length + ' 词</h2>' +
      '<span class="tiny faint">数据来自 NETEMVocabulary，按真题词频排序</span></div>' +
      '<div class="card">' +
      '<div class="toolbar">' +
        '<div class="search-box">' +
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
          '<input id="libSearch" type="search" placeholder="搜索单词或中文释义…" value="' + esc(f.q) + '">' +
        '</div>' +
        '<select class="select" id="libCefr" aria-label="CEFR 等级">' +
          option('all', '全部等级', f.cefr) + ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(function (x) { return option(x, 'CEFR ' + x, f.cefr); }).join('') +
        '</select>' +
        '<select class="select" id="libBand" aria-label="词频区间">' +
          option('all', '全部词频', f.band) +
          option('S', '超高频 ≥500', f.band) + option('A', '高频 100–499', f.band) +
          option('B', '常考 40–99', f.band) + option('C', '中频 10–39', f.band) + option('D', '低频 <10', f.band) +
        '</select>' +
        '<select class="select" id="libPos" aria-label="词性">' +
          option('all', '全部词性', f.pos) +
          option('n', '名词 n.', f.pos) + option('v', '动词 v.', f.pos) +
          option('adj', '形容词 adj.', f.pos) + option('adv', '副词 adv.', f.pos) +
          option('other', '其他词性', f.pos) +
        '</select>' +
        '<select class="select" id="libSort" aria-label="排序">' +
          option('freq', '按词频', f.sort) + option('rerank', '按学习优先级', f.sort) +
          option('alpha', '按字母', f.sort) + option('level', '按熟悉度', f.sort) +
        '</select>' +
      '</div>' +
      '<div class="filter-chips">' +
        chip('all', '全部', f.status) + chip('new', '未学', f.status) + chip('learning', '在学', f.status) +
        chip('due', '待复习', f.status) + chip('known', '已掌握', f.status) +
        chip('star', '收藏', f.status) + chip('note', '有笔记', f.status) + chip('noroot', '未归类', f.status) +
        '<span style="flex:1"></span>' +
        '<select class="select" id="libLetter" style="padding:4px 8px;font-size:12px">' +
          option('all', '首字母', f.letter) + letters.map(function (x) { return option(x, x.toUpperCase(), f.letter); }).join('') +
        '</select>' +
      '</div>' +
      '<div class="list-head"><span>#</span><span>单词</span><span>释义</span><span style="text-align:right">词频</span><span>熟悉度</span><span style="text-align:right">复习</span><span></span></div>' +
      (shown.length ? shown.map(rowHTML).join('') :
        '<div class="empty">没有匹配的单词，试试换个筛选条件。</div>') +
      (list.length > shown.length
        ? '<div class="lib-sentinel" id="libSentinel">继续向下滚动，自动加载更多… <span class="faint">' + shown.length + ' / ' + list.length + '</span></div>'
        : (list.length ? '<div class="pager faint">已显示全部 ' + list.length + ' 词</div>' : '')) +
      '</div>';
    return html;
  }

  function option(v, label, cur) {
    return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>';
  }

  function chip(v, label, cur) {
    return '<button class="filter-chip" data-status="' + v + '" aria-pressed="' + (cur === v) + '">' + label + '</button>';
  }

  function rowHTML(w) {
    var rec = S.word(w.w);
    var lv = rec && rec.first ? rec.lv : 0;
    return '<div class="list-row" data-open="' + esc(w.w) + '" tabindex="0" role="button">' +
      '<span class="rank">' + (w._i + 1) + '</span>' +
      '<span><span class="w">' + esc(w.w) + '</span>' +
        (cleanPhonetic(w.ph) ? '<div class="ph">/' + esc(cleanPhonetic(w.ph)) + '/</div>' : '') + '</span>' +
      '<span class="tr">' + (posText(w, 2) ? '<span class="pos-tag">' + esc(posText(w, 2)) + '</span>' : '') + esc(w.t) + '</span>' +
      '<span class="freq">' + fmtNum(w.f) + '</span>' +
      '<span class="lv-cell">' + pips(lv) +
        '<button class="row-review" data-quick="' + esc(w.w) + '" title="标记已复习" aria-label="标记 ' + esc(w.w) + ' 已复习">✓</button>' +
      '</span>' +
      '<span class="tiny ' + (rec && rec.due && rec.due <= S.todayStr() ? '' : 'faint') + '" style="text-align:right">' +
        (rec && rec.first ? dueLabel(rec) : (S.starred(w.w) ? '★' : '—')) + '</span>' +
      '<button class="row-del" data-del="' + esc(w.w) + '" title="从词库移除" aria-label="从词库移除 ' + esc(w.w) + '">×</button>' +
    '</div>';
  }


  /* ---------- 真题 ---------- */

  function paperTitleShort(p) {
    return p.title.replace(/^\d{4}年真题\s*·\s*/, '');
  }

  function paperTypeMeta(t) { return EX.typeMeta(t); }

  function paperKpi(v, l) {
    return '<div class="pk"><div class="v">' + v + '</div><div class="k">' + l + '</div></div>';
  }

  function paperCardHTML(p) {
    var tm = paperTypeMeta(p.type);
    var best = EX.bestOf(p.id);
    var pct = best ? Math.round(best.best.correct / (best.best.total || 1) * 100) : 0;
    return '<button class="paper-card" data-paper="' + esc(p.id) + '">' +
      '<div class="pc-top"><span class="badge" data-tone="' + tm.color + '">' + tm.short + '</span>' +
        '<span class="faint tiny">' + p.questions.length + ' 题 · ' + (p.minutes || '—') + ' 分钟</span></div>' +
      '<div class="pc-title">' + esc(paperTitleShort(p)) + '</div>' +
      '<div class="pc-foot">' + (best
        ? '最好 ' + best.best.correct + '/' + best.best.total + ' · ' + pct + '%'
        : '未练习') + '</div>' +
      '<div class="pc-bar"><i style="width:' + pct + '%"></i></div>' +
    '</button>';
  }

  function renderPapers() {
    var stats = EX.stats();
    var sess = EX.getSession();
    var f = state.paperFilter;
    var papers = EX.papers.filter(function (p) {
      if (f.year !== 'all' && String(p.year) !== String(f.year)) return false;
      if (f.type !== 'all' && p.type !== f.type) return false;
      return true;
    });

    var html = '<div class="paper-hero">' +
      '<div><div class="badge" data-tone="accent">考研英语（二）</div>' +
        '<h1>历年真题 · 客观题</h1>' +
        '<div class="muted small">2010–2026 · ' + EX.meta.count + ' 个练习 · ' + EX.meta.questions +
          ' 道题 · 当前为英语二，英语一整理中 · 答案与解析仅供参考</div></div>' +
      '<div class="seg" role="tablist">' +
        '<button data-ptab="library" aria-pressed="' + (state.paperTab === 'library') + '">题库</button>' +
        '<button data-ptab="analysis" aria-pressed="' + (state.paperTab === 'analysis') + '">分析</button>' +
      '</div>' +
    '</div>';

    if (sess) {
      var sp = EX.get(sess.paperId);
      var sessAnswered = Object.keys(sess.answers || {}).length;
      if (sp && sessAnswered > 0) {
        html += '<div class="resume-banner"><div><b>未完成的练习</b> · ' + esc(sp.title) +
          ' <span class="faint tiny">' + Object.keys(sess.answers || {}).length + ' / ' + sp.questions.length + ' 已答</span></div>' +
          '<div style="display:flex;gap:8px"><button class="btn btn-sm btn-primary" data-resume>继续</button>' +
          '<button class="btn btn-sm" data-discard="1">放弃</button></div></div>';
      }
    }

    if (state.paperTab === 'analysis') {
      return html + paperAnalysisHTML(stats);
    }

    html += '<div class="paper-kpis card">' +
      paperKpi(stats.donePapers + ' / ' + EX.meta.count, '已完成练习') +
      paperKpi(stats.totalQ, '累计答题') +
      paperKpi((stats.accuracy * 100).toFixed(1) + '%', '总正确率') +
      paperKpi(stats.wrong.length, '近期错题') +
    '</div>';

    html += '<div class="paper-filters">' +
      '<select class="select" id="paperYear" aria-label="年份">' +
        option('all', '全部年份', f.year) +
        EX.meta.years.map(function (y) { return option(String(y), y + ' 年', f.year); }).join('') +
      '</select>' +
      '<div class="filter-chips" style="padding:0">' +
        paperTypeChip('all', '全部题型', f.type) +
        paperTypeChip('reading', '阅读理解', f.type) +
        paperTypeChip('cloze', '完形填空', f.type) +
        paperTypeChip('newtype', '新题型', f.type) +
      '</div>' +
      '<span class="paper-count tiny faint">' + papers.length + ' 个练习</span>' +
    '</div>';

    var years = [];
    papers.forEach(function (p) { if (years.indexOf(p.year) === -1) years.push(p.year); });
    html += '<div class="paper-years">' + years.map(function (y) {
      return '<div class="year-block"><div class="year-label">' + y + '<small>年</small></div>' +
        '<div class="paper-cards">' +
          papers.filter(function (p) { return p.year === y; }).map(paperCardHTML).join('') +
        '</div></div>';
    }).join('') + '</div>' +
    '<div class="paper-source tiny faint">真题数据：houxinjin774/English2（源自懒笔记考研英语真题站）· 答案与解析由开源整理，仅供参考，仅用于个人学习。</div>';

    return html;
  }

  function paperTypeChip(v, label, cur) {
    return '<button class="filter-chip" data-ptype="' + v + '" aria-pressed="' + (cur === v) + '">' + label + '</button>';
  }

  function trendSVG(trend) {
    if (!trend.length) return '';
    var w = 640, h = 150, pad = 22;
    if (trend.length === 1) {
      var onlyY = h - pad - trend[0].accuracy * (h - 2 * pad);
      return '<svg class="trend" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="正确率趋势">' +
        '<line x1="' + pad + '" y1="' + (h - pad) + '" x2="' + (w - pad) + '" y2="' + (h - pad) + '" stroke="var(--border)" stroke-dasharray="3 4"/>' +
        '<circle cx="' + (w / 2) + '" cy="' + onlyY.toFixed(1) + '" r="4.5" fill="var(--accent)"/>' +
        '<text x="' + (w / 2 + 12) + '" y="' + (onlyY - 8).toFixed(1) + '" font-size="12" fill="var(--fg-muted)">' +
          (trend[0].accuracy * 100).toFixed(0) + '%</text></svg>';
    }
    var pts = trend.map(function (t, i) {
      var x = trend.length === 1 ? w / 2 : pad + i * (w - 2 * pad) / (trend.length - 1);
      var y = h - pad - t.accuracy * (h - 2 * pad);
      return [x, y];
    });
    var line = pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var area = pad + ',' + (h - pad) + ' ' + line + ' ' + (w - pad) + ',' + (h - pad);
    var dots = pts.map(function (p) {
      return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.2" fill="var(--accent)"/>';
    }).join('');
    return '<svg class="trend" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="正确率趋势">' +
      '<polygon points="' + area + '" fill="var(--accent-soft)" opacity=".55"/>' +
      '<polyline points="' + line + '" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>' +
      dots + '</svg>';
  }

  function paperAnalysisHTML(stats) {
    if (!stats.attempts) {
      return '<div class="card empty paper-empty"><div style="font-family:var(--font-serif);font-size:22px;margin-bottom:6px">还没有刷题记录</div>' +
        '<div class="muted small">先从一套阅读开始，做完交卷后这里会出现正确率、题型分布和错题分析。</div>' +
        '<button class="btn btn-primary" data-ptab="library" style="margin-top:14px">去题库选题</button></div>';
    }

    var typeKeys = ['reading', 'cloze', 'newtype'];
    var typeRows = typeKeys.map(function (k) {
      var t = stats.byType[k];
      if (!t) return '';
      var acc = t.total ? t.correct / t.total : 0;
      return '<div class="ana-row"><div class="ana-label">' + EX.types[k].name + '</div>' +
        '<div class="ana-bar"><i style="width:' + (acc * 100).toFixed(1) + '%"></i></div>' +
        '<div class="ana-val">' + (acc * 100).toFixed(0) + '% <span class="faint tiny">(' + t.correct + '/' + t.total + ')</span></div></div>';
    }).join('');

    var yearKeys = Object.keys(stats.byYear).map(Number).sort(function (a, b) { return b - a; });
    var yearRows = yearKeys.map(function (y) {
      var t = stats.byYear[y];
      var acc = t.total ? t.correct / t.total : 0;
      return '<div class="ana-row"><div class="ana-label">' + y + '</div>' +
        '<div class="ana-bar"><i style="width:' + (acc * 100).toFixed(1) + '%"></i></div>' +
        '<div class="ana-val">' + (acc * 100).toFixed(0) + '%</div></div>';
    }).join('');

    var wrongRows = stats.wrong.slice(0, 8).map(function (w) {
      return '<button class="wrong-row" data-wrong="' + esc(w.paperId) + '|' + w.n + '">' +
        '<span class="wr-title">' + esc(w.title) + ' · 第 ' + w.n + ' 题</span>' +
        '<span class="wr-q">' + esc((w.q || '').slice(0, 70)) + '</span>' +
        '<span class="wr-ans">你的 ' + (w.chosen == null ? '—' : String.fromCharCode(65 + w.chosen)) +
          ' → 正确 ' + String.fromCharCode(65 + w.correct) + '</span></button>';
    }).join('');

    var recent = EX.attempts().slice(0, 8).map(function (a) {
      var acc = a.total ? Math.round(a.correct / a.total * 100) : 0;
      return '<button class="attempt-row" data-attempt="' + esc(a.id) + '">' +
        '<span class="ar-title">' + esc(a.title) + '</span>' +
        '<span class="ar-meta">' + new Date(a.finishedAt).toLocaleDateString('zh-CN') + ' · ' + EX.fmtDuration(a.duration) + '</span>' +
        '<span class="ar-score">' + a.correct + '/' + a.total + ' · ' + acc + '%</span></button>';
    }).join('');

    return '<div class="paper-kpis card">' +
      paperKpi(stats.donePapers, '已完成练习') +
      paperKpi((stats.accuracy * 100).toFixed(1) + '%', '总正确率') +
      paperKpi(stats.totalQ, '累计答题') +
      paperKpi(EX.fmtDuration(stats.avgSeconds), '平均每题') +
    '</div>' +
    '<div class="ana-grid">' +
      '<div class="card ana-card ana-wide"><h3>最近 12 次正确率</h3>' +
        '<div class="trend-wrap">' + trendSVG(stats.trend) + '</div>' +
        '<div class="trend-labels">' + stats.trend.map(function (t) {
          var td = new Date(t.date);
          return '<span>' + (td.getMonth() + 1) + '/' + td.getDate() + '</span>';
        }).join('') + '</div></div>' +
      '<div class="card ana-card"><h3>题型掌握度</h3>' + typeRows + '</div>' +
      '<div class="card ana-card"><h3>分年份正确率</h3>' + yearRows + '</div>' +
      '<div class="card ana-card ana-wide"><h3>最近错题</h3>' +
        (wrongRows || '<div class="muted small">还没有错题，保持住。</div>') + '</div>' +
      '<div class="card ana-card ana-wide"><h3>最近练习</h3>' + recent + '</div>' +
    '</div>';
  }

  /* ---------- 开始一套卷 ---------- */

  function openPaperStart(id) {
    var p = EX.get(id);
    if (!p) return;
    var best = EX.bestOf(id);
    var sess = EX.getSession();
    var same = sess && sess.paperId === id;
    var tm = paperTypeMeta(p.type);
    var root = $('#modalRoot');
    root.innerHTML = '<div class="modal-mask"><div class="modal paper-start" data-paper-id="' + esc(p.id) + '" role="dialog" aria-modal="true" aria-label="开始练习">' +
      '<div class="modal-head"><div><div class="tiny faint">' + p.year + ' 年 · 英语二</div><h3>' + esc(p.title) + '</h3></div>' +
        '<button class="icon-btn" data-close="1">✕</button></div>' +
      '<div class="modal-body">' +
        '<div class="ps-meta"><span class="badge" data-tone="' + tm.color + '">' + tm.name + '</span>' +
          '<span class="faint tiny">' + p.questions.length + ' 题 · 建议 ' + (p.minutes || '—') + ' 分钟 · 满分 ' + (p.score || '—') + '</span></div>' +
        (p.intro ? '<p class="muted small" style="margin:10px 0 0">' + esc(p.intro) + '</p>' : '') +
        (best ? '<div class="ps-best">最好成绩：' + best.best.correct + '/' + best.best.total + ' · 做过 ' + best.count + ' 次</div>' : '') +
        (same ? '<div class="ps-resume">有一套未完成的练习，可以继续。</div>' : '') +
        (sess && !same ? '<div class="ps-warn">注意：开始新练习会覆盖当前未完成的「' + esc((EX.get(sess.paperId) || {}).title || '') + '」。</div>' : '') +
        '<div class="ps-modes">' +
          '<button class="ps-mode" data-start="practice"><b>练习模式</b><span>选完立即显示对错与解析，适合精做</span></button>' +
          '<button class="ps-mode" data-start="mock"><b>模考模式</b><span>先答完，交卷后统一批改，适合计时模拟</span></button>' +
        '</div>' +
      '</div>' +
      '<div class="modal-foot">' +
        (same ? '<button class="btn btn-primary" data-resume>继续上次</button>' : '') +
        '<button class="btn" data-close="1">取消</button>' +
      '</div>' +
    '</div></div>';
  }

  function startPaper(id, mode) {
    var p = EX.get(id);
    if (!p) return;
    var sess = EX.createSession(id, mode);
    state.view = 'exam';
    state.exam = {
      paper: p, sess: sess, submitted: false, result: null, attempt: null,
      onlyWrong: false, showZh: false,
      showPassage: true
    };
    closeModal();
    render();
    window.scrollTo(0, 0);
    startExamTimer();
  }

  function resumePaper() {
    var sess = EX.getSession();
    if (!sess) return;
    var p = EX.get(sess.paperId);
    if (!p) return;
    state.view = 'exam';
    state.exam = {
      paper: p, sess: sess, submitted: false, result: null, attempt: null,
      onlyWrong: false, showZh: false,
      showPassage: true
    };
    closeModal();
    render();
    window.scrollTo(0, 0);
    startExamTimer();
  }

  /* ---------- 练习界面 ---------- */

  var examTimerId = null;

  function startExamTimer() {
    stopExamTimer();
    updateExamTimer();
    examTimerId = setInterval(updateExamTimer, 1000);
  }

  function stopExamTimer() {
    if (examTimerId) { clearInterval(examTimerId); examTimerId = null; }
  }

  function updateExamTimer() {
    var el = $('#examTimer');
    if (!el) return;
    var st = state.exam;
    if (!st || st.submitted) { el.textContent = '—'; return; }
    var sec = (Date.now() - st.sess.startedAt) / 1000;
    el.textContent = EX.fmtDuration(sec);
  }

  function letterOf(i) { return i == null ? '—' : String.fromCharCode(65 + i); }

  function answerLetter(q, i) {
    if (i == null || !q || !q.opts || !q.opts[i]) return letterOf(i);
    var m = String(q.opts[i]).match(/^(T|F)\./);
    return m ? m[1] : letterOf(i);
  }

  function lookupKey(token) {
    var w = token.toLowerCase().replace(/[’']s$/, '');
    if (BY_LOWER.has(w)) return BY_LOWER.get(w);
    var tries = [w.replace(/ies$/, 'y'), w.replace(/ied$/, 'y'), w.replace(/ing$/, ''),
      w.replace(/ed$/, ''), w.replace(/es$/, ''), w.replace(/s$/, ''), w.replace(/ly$/, '')];
    for (var i = 0; i < tries.length; i++) {
      if (tries[i] && BY_LOWER.has(tries[i])) return BY_LOWER.get(tries[i]);
    }
    return null;
  }

  function linkWords(text) {
    var parts = text.split(/([A-Za-z][A-Za-z'’\-]*)/);
    return parts.map(function (seg) {
      if (!/^[A-Za-z]/.test(seg)) return esc(seg).replace(/\n/g, '<br>');
      var key = lookupKey(seg);
      if (!key) return esc(seg);
      return '<button type="button" class="wlook" data-open="' + esc(key) + '">' + esc(seg) + '</button>';
    }).join('');
  }

  function passageHTML(p, activeIndex) {
    var raw = p.passage || '';
    var paras;
    if (p.type === 'cloze') {
      paras = raw.split(/\n{2,}/).map(function (para) {
        var segs = para.split(/(__\(\d+\)__)/);
        return '<p>' + segs.map(function (seg) {
          var m = seg.match(/^__\((\d+)\)__$/);
          if (!m) return linkWords(seg);
          var n = Number(m[1]);
          return '<span class="cloze-blank' + (n === activeIndex + 1 ? ' active' : '') +
            '" data-blank="' + n + '">' + n + '</span>';
        }).join('') + '</p>';
      });
    } else {
      paras = raw.split(/\n{2,}/).map(function (para) { return '<p>' + linkWords(para) + '</p>'; });
    }
    return paras.join('');
  }

  function optionHTML(i, text, chosen, correct, reveal) {
    var cls = 'q-opt';
    var raw = String(text);
    var m = raw.match(/^([A-G]|T|F)\.\s*/);
    var label = m ? raw.slice(m[0].length) : raw;
    var letter = m ? m[1] : letterOf(i);
    if (chosen === i) cls += ' selected';
    if (reveal) {
      if (i === correct) cls += ' correct';
      else if (chosen === i) cls += ' wrong';
    }
    return '<button class="' + cls + '" data-opt="' + i + '">' +
      '<span class="letter">' + esc(letter) + '</span><span>' + esc(label) + '</span></button>';
  }

  function answerSheetHTML(p, sess) {
    var answered = 0;
    p.questions.forEach(function (_, i) { if (sess.answers[i] != null) answered++; });
    return '<div class="answer-sheet"><div class="as-head"><span>答题卡</span>' +
      '<span class="tiny faint">' + answered + ' / ' + p.questions.length + ' 已答</span></div>' +
      '<div class="as-chips">' + p.questions.map(function (_, i) {
        var cls = 'as-chip';
        if (i === sess.index) cls += ' current';
        if (sess.answers[i] != null) cls += ' done';
        if (sess.flags[i]) cls += ' flag';
        return '<button class="' + cls + '" data-jump="' + i + '">' + (i + 1) + '</button>';
      }).join('') + '</div></div>';
  }

  function renderExam() {
    var st = state.exam;
    if (!st) { state.view = 'papers'; return renderPapers(); }
    if (st.submitted) return examResultHTML(st);

    var p = st.paper, sess = st.sess;
    var q = p.questions[sess.index];
    var tm = paperTypeMeta(p.type);
    var chosen = sess.answers[sess.index];
    var reveal = st.sess.mode === 'practice' && chosen != null;
    var flagged = !!sess.flags[sess.index];

    var html = '<div class="exam-bar">' +
      '<button class="btn btn-sm btn-ghost" data-act="exit-exam">← 返回</button>' +
      '<div class="eb-title">' + esc(p.title) + ' <span class="badge" data-tone="' + tm.color + '">' + tm.short + '</span></div>' +
      '<div class="eb-timer" id="examTimer">' + EX.fmtDuration((Date.now() - sess.startedAt) / 1000) + '</div>' +
      '<button class="btn btn-primary btn-sm" data-act="submit-exam">交卷</button>' +
    '</div>';

    html += '<div class="exam-grid">' +
      '<aside class="passage-pane">' +
        '<div class="pp-head"><span>文章</span><div class="pp-tools">' +
          (p.passageZh ? '<button class="btn btn-sm btn-ghost" data-act="toggle-zh">' + (st.showZh ? '隐藏中译' : '中译') + '</button>' : '') +
          '<button class="btn btn-sm btn-ghost" data-act="toggle-passage">' + (st.showPassage ? '收起' : '展开') + '</button>' +
        '</div></div>' +
        (st.showPassage ? '<div class="passage" id="examPassage">' + passageHTML(p, sess.index) + '</div>' +
          (st.showZh && p.passageZh ? '<div class="passage-zh" id="examZh">' + esc(p.passageZh) + '</div>' : '')
          : '<div class="passage-folded"><button class="btn btn-sm" data-act="toggle-passage">显示文章</button></div>') +
      '</aside>' +
      '<section class="q-pane" id="qPane">' +
        '<div class="q-top"><span class="q-counter">第 ' + (sess.index + 1) + ' / ' + p.questions.length + ' 题</span>' +
          '<button class="btn btn-sm btn-ghost" data-act="flag">' + (flagged ? '★ 已标记' : '☆ 标记') + '</button></div>' +
        '<div class="q-stem">' + esc(q.q) + '</div>' +
        '<div class="q-opts">' + q.opts.map(function (o, i) {
          return optionHTML(i, o, chosen, q.ans, reveal);
        }).join('') + '</div>' +
        (reveal ? '<div class="q-feedback ' + (chosen === q.ans ? 'ok' : 'bad') + '">' +
          '<div class="qf-head">' + (chosen === q.ans ? '✓ 回答正确' : '✗ 回答错误') +
          ' · 正确答案 ' + answerLetter(q, q.ans) + '</div>' +
          (q.explain ? '<div class="qf-body">' + esc(q.explain) + '</div>' : '') + '</div>' : '') +
        '<div class="q-foot">' +
          '<button class="btn btn-sm" data-act="prev"' + (sess.index === 0 ? ' disabled' : '') + '>上一题</button>' +
          '<span class="tiny faint">' + (sess.mode === 'practice' ? '练习模式 · 即时解析' : '模考模式 · 交卷后批改') + '</span>' +
          '<button class="btn btn-sm" data-act="next"' + (sess.index === p.questions.length - 1 ? ' disabled' : '') + '>下一题</button>' +
        '</div>' +
        answerSheetHTML(p, sess) +
      '</section>' +
    '</div>';

    return html;
  }

  function examResultHTML(st) {
    var p = st.paper, r = st.result;
    var dur = st.attempt ? st.attempt.duration : (Date.now() - st.sess.startedAt) / 1000;
    var wrong = r.details.filter(function (d) { return !d.ok; });
    var list = st.onlyWrong ? wrong : r.details;
    var tm = paperTypeMeta(p.type);

    var html = '<div class="exam-bar">' +
      '<button class="btn btn-sm btn-ghost" data-act="back-papers">← 题库</button>' +
      '<div class="eb-title">' + esc(p.title) + ' <span class="badge" data-tone="' + tm.color + '">' + tm.short + '</span></div>' +
      '<div class="tiny faint">已交卷</div>' +
    '</div>';

    html += '<div class="result-hero card">' +
      '<div class="score-ring"><div class="score-num">' + r.score + '</div><div class="score-full">/ ' + r.fullScore + '</div></div>' +
      '<div class="result-main">' +
        '<div class="result-title">' + (r.accuracy >= 0.8 ? '做得不错。' : r.accuracy >= 0.6 ? '还有提升空间。' : '这套值得二刷。') + '</div>' +
        '<div class="result-kpis">' +
          '<span>正确 <b>' + r.correct + '</b> / ' + r.total + '</span>' +
          '<span>正确率 <b>' + (r.accuracy * 100).toFixed(1) + '%</b></span>' +
          '<span>用时 <b>' + EX.fmtDuration(dur) + '</b></span>' +
          '<span>' + (st.attempt ? (st.attempt.mode === 'practice' ? '练习模式' : '模考模式') : '') + '</span>' +
        '</div>' +
        '<div class="result-actions">' +
          '<button class="btn btn-sm" data-act="toggle-wrong">' + (st.onlyWrong ? '显示全部' : '只看错题') + '</button>' +
          '<button class="btn btn-sm" data-act="retry-paper">再练一次</button>' +
          '<button class="btn btn-sm btn-primary" data-act="back-papers">返回题库</button>' +
        '</div>' +
      '</div>' +
    '</div>';

    html += '<details class="result-passage"><summary>查看原文' + (p.passageZh ? '与中译' : '') + '</summary>' +
      '<div class="passage">' + passageHTML(p, -1) + '</div>' +
      (p.passageZh ? '<div class="passage-zh">' + esc(p.passageZh) + '</div>' : '') + '</details>';

    html += '<div class="review-head"><h2>逐题解析</h2><span class="tiny faint">' + list.length + ' 题</span></div>';
    html += '<div class="review-list">' + list.map(function (d) {
      return '<div class="review-card" id="review-' + d.n + '">' +
        '<div class="rc-head"><span class="rc-n">' + d.n + '</span>' +
          '<span class="badge" data-tone="' + (d.ok ? 'success' : 'danger') + '">' + (d.ok ? '正确' : '错误') + '</span>' +
          '<span class="rc-ans tiny faint">你的答案 ' + answerLetter(d.q, d.chosen) + ' · 正确答案 ' + answerLetter(d.q, d.correct) + '</span></div>' +
        '<div class="rc-q">' + esc(d.q.q) + '</div>' +
        '<div class="rc-opts">' + d.q.opts.map(function (o, i) {
          return optionHTML(i, o, d.chosen, d.correct, true);
        }).join('') + '</div>' +
        (d.q.explain ? '<div class="rc-explain"><b>解析</b> ' + esc(d.q.explain) + '</div>' : '') +
      '</div>';
    }).join('') + '</div>';

    return html;
  }

  function examChoose(i) {
    var st = state.exam;
    if (!st || st.submitted) return;
    st.sess.answers[st.sess.index] = i;
    EX.saveSession(st.sess);
    renderKeepScroll();
  }

  function examJump(i) {
    var st = state.exam;
    if (!st || st.submitted) return;
    st.sess.index = Math.max(0, Math.min(st.paper.questions.length - 1, i));
    EX.saveSession(st.sess);
    renderKeepScroll();
    var q = $('#qPane');
    if (q && window.innerWidth < 900) q.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function examFlag() {
    var st = state.exam;
    if (!st || st.submitted) return;
    st.sess.flags[st.sess.index] = !st.sess.flags[st.sess.index];
    EX.saveSession(st.sess);
    renderKeepScroll();
  }

  function examSubmit() {
    var st = state.exam;
    if (!st || st.submitted) return;
    var unanswered = st.paper.questions.filter(function (_, i) { return st.sess.answers[i] == null; }).length;
    if (unanswered) {
      $('#modalRoot').innerHTML = '<div class="modal-mask"><div class="modal" role="dialog" aria-modal="true" aria-label="确认交卷">' +
        '<div class="modal-head"><h3>还有 ' + unanswered + ' 题未作答</h3><button class="icon-btn" data-close="1">✕</button></div>' +
        '<div class="modal-body"><p class="muted" style="margin:0">现在交卷会按已作答的题目计分，未作答按错误计算。也可以回去继续答完。</p></div>' +
        '<div class="modal-foot"><button class="btn" data-close="1">继续答题</button>' +
        '<button class="btn btn-primary" data-act="confirm-submit">仍然交卷</button></div></div></div>';
      return;
    }
    doSubmitExam();
  }

  function doSubmitExam() {
    var st = state.exam;
    if (!st || st.submitted) return;
    var result = EX.grade(st.paper, st.sess.answers);
    var attempt = EX.saveAttempt(st.paper, st.sess, result);
    st.submitted = true;
    st.result = result;
    st.attempt = attempt;
    closeModal();
    stopExamTimer();
    render();
    window.scrollTo(0, 0);
  }

  function examExit() {
    var st = state.exam;
    if (!st) return;
    // 进度会保留，直接退出，不再弹原生确认框
    stopExamTimer();
    state.view = 'papers';
    state.exam = null;
    render();
    window.scrollTo(0, 0);
  }

  function renderKeepScroll() {
    var y = window.scrollY;
    var ps = $('#examPassage') ? $('#examPassage').scrollTop : 0;
    render();
    window.scrollTo(0, y);
    var np = $('#examPassage');
    if (np) np.scrollTop = ps;
  }

  function showAttempt(id) {
    var a = EX.attempts().filter(function (x) { return x.id === id; })[0];
    if (!a) return;
    var p = EX.get(a.paperId);
    if (!p) return;
    state.view = 'exam';
    state.exam = {
      paper: p,
      sess: { paperId: p.id, mode: a.mode, answers: a.answers, flags: {}, index: 0, startedAt: a.startedAt },
      submitted: true, result: EX.grade(p, a.answers), attempt: a,
      onlyWrong: false, showZh: false, showPassage: false
    };
    stopExamTimer();
    render();
    window.scrollTo(0, 0);
  }

  function showWrong(paperId, n) {
    var a = EX.attempts().filter(function (x) { return x.paperId === paperId; })[0];
    if (!a) return;
    showAttempt(a.id);
    if (n) {
      setTimeout(function () {
        var el = document.getElementById('review-' + n);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 120);
    }
  }

  /* ---------- 词根 ---------- */

  function renderRoots() {
    var keys = Object.keys(ROOT_COUNTS).sort(function (a, b) { return ROOT_COUNTS[b] - ROOT_COUNTS[a]; });
    var q = state.rootQuery.trim().toLowerCase();
    if (!state.rootKey || !ROOT_COUNTS[state.rootKey]) {
      // 默认选词族最大的那个
      state.rootKey = keys[0] || null;
    }
    var shownKeys = keys.filter(function (k) {
      if (!q) return true;
      var r = M.rootByKey[k];
      return k.indexOf(q) !== -1 || (r && r.m.indexOf(q) !== -1);
    });

    var coverage = WORDS.length ? (ROOTED.size / WORDS.length * 100) : 0;
    var unclassified = WORDS.length - ROOTED.size;
    var html = '<div class="section-title"><h2>词根词典 · ' + keys.length + ' 个词根</h2>' +
      '<span class="tiny faint">已归类 ' + ROOTED.size + ' / ' + WORDS.length + ' 词（' + coverage.toFixed(0) + '%）</span></div>' +
      '<div class="tiny faint" style="margin:-6px 0 10px">只有能可靠拆出词根的词才会进入词族；其余 ' + unclassified +
        ' 个词没有稳定的词根结构。' +
        (unclassified ? ' <button class="btn btn-sm btn-ghost" data-goto="noroot" style="padding:1px 6px">查看未归类词 →</button>' : '') +
      '</div>' +
      '<div class="roots-layout">' +
      '<div class="card root-index">' +
        '<input class="input" id="rootSearch" placeholder="搜索词根 / 含义" value="' + esc(state.rootQuery) + '" style="width:100%;margin-bottom:6px">' +
        shownKeys.map(function (k) {
          var r = M.rootByKey[k];
          return '<button data-root="' + esc(k) + '" aria-pressed="' + (state.rootKey === k) + '">' +
            '<span>' + esc(r.k) + ' <span class="faint tiny">' + esc(r.m) + '</span></span>' +
            '<span class="cnt">' + ROOT_COUNTS[k] + '</span></button>';
        }).join('') +
      '</div>' +
      '<div id="rootPane">' + rootPaneHTML(state.rootKey) + '</div>' +
      '</div>';
    return html;
  }

  function rootPaneHTML(key) {
    var r = M.rootByKey[key];
    if (!r) return '<div class="card empty">选择一个词根</div>';
    var words = (FAMILY[key] || []).map(function (w) { return BY_WORD.get(w); }).filter(Boolean)
      .sort(function (a, b) { return b.f - a.f; });
    var known = 0;
    words.forEach(function (w) { var rec = S.word(w.w); if (rec && rec.first) known++; });

    return '<div class="card root-hero">' +
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px">' +
        '<div><div class="rk">' + esc(r.k) + '</div>' +
        '<div class="muted" style="margin-top:2px">' + esc(r.m) + '</div></div>' +
        '<div class="badge" data-tone="accent">' + words.length + ' 个考研词 · 已学 ' + known + '</div>' +
      '</div>' +
      '<div class="root-vars">' + r.vars.map(function (v) { return '<span>' + esc(v) + '</span>'; }).join('') + '</div>' +
      (r.o ? '<div class="muted small" style="margin-top:12px">词源：' + esc(r.o) + '</div>' : '') +
      (r.ex && r.ex.length ? '<div class="muted small" style="margin-top:4px">例词：' + esc(r.ex.join('、')) + '</div>' : '') +
      '<div class="section-title" style="margin:18px 0 8px"><h2>同根词</h2><span class="tiny faint">按词频排序 · 自动匹配，供联想</span></div>' +
      '<div class="word-cloud">' + words.slice(0, 120).map(function (w) {
        var rec = S.word(w.w);
        return '<button data-open="' + esc(w.w) + '">' + esc(w.w) +
          (rec && rec.first ? ' <small>' + levelName(rec.lv) + '</small>' : '') + '</button>';
      }).join('') + (words.length > 120 ? '<span class="tiny faint" style="align-self:center">…另有 ' + (words.length - 120) + ' 词</span>' : '') + '</div>' +
    '</div>';
  }

  /* ---------- 统计 ---------- */

  function renderStats() {
    var total = WORDS.length;
    var counts = [0, 0, 0, 0, 0, 0];
    var learned = 0, mastered = 0, starred = 0;
    var week = Q.weekly();
    var dueForecast = {};
    var today = S.todayStr();

    WORDS.forEach(function (w) {
      var r = S.word(w.w);
      if (r && r.first) {
        learned++;
        counts[r.lv]++;
        if (r.lv >= 4) mastered++;
        if (r.due && r.due >= today) {
          var d = S.diffDays(r.due, today);
          if (d <= 6) dueForecast[d] = (dueForecast[d] || 0) + 1;
        }
      } else {
        counts[0]++;
      }
      if (S.starred(w.w)) starred++;
    });

    var st = S.get().stats;
    var cefr = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(function (c) {
      var all = WORDS.filter(function (w) { return w.cefr === c; });
      var done = all.filter(function (w) { var r = S.word(w.w); return r && r.first; }).length;
      return { cefr: c, all: all.length, done: done };
    }).filter(function (x) { return x.all > 0; });

    var heat = Q.heatmap(35);
    // 对齐到周日起
    var pad = new Date(heat[0].date.split('-').map(Number)[0], heat[0].date.split('-').map(Number)[1] - 1, heat[0].date.split('-').map(Number)[2]).getDay();
    var heatCells = '';
    for (var p = 0; p < pad; p++) heatCells += '<div></div>';
    heat.forEach(function (d) {
      var lv = d.total >= 40 ? 4 : d.total >= 20 ? 3 : d.total >= 8 ? 2 : d.total > 0 ? 1 : 0;
      heatCells += '<div class="cal-cell" data-lv="' + lv + '" data-dow="' + (new Date(d.date.split('-').map(Number)[0], d.date.split('-').map(Number)[1] - 1, d.date.split('-').map(Number)[2]).getDay()) + '"' +
        (d.date === today ? ' data-today="1"' : '') + ' title="' + d.date + ' · ' + d.total + ' 词">' + d.date.slice(8) + '</div>';
    });

    return '<div class="section-title"><h2>学习统计</h2><span class="tiny faint">数据只在本机</span></div>' +
      '<div class="kpi-row" style="margin-top:0">' +
        kpi(learned, '已开始学习') + kpi(mastered, '已掌握') +
        kpi(st.totalReviews || 0, '累计复习次数') + kpi((st.streak || 0) + ' 天', '连续打卡') +
      '</div>' +
      '<div class="plan-grid" style="margin-top:14px">' +
        '<div class="card plan-card">' +
          '<h3>熟悉度分布</h3><div class="desc">从生词到掌握，看看自己卡在哪一层。</div>' +
          counts.map(function (n, lv) {
            var pct = total ? n / total * 100 : 0;
            return '<div style="margin:8px 0"><div class="legend-row"><span>' + levelName(lv) + '</span><span class="mono tiny">' + n + '</span></div>' +
              '<div class="queue-bar" style="margin:3px 0 0"><i style="width:' + pct + '%;background:' + (lv === 0 ? 'var(--fg-faint)' : 'var(--level-' + lv + ')') + '"></i></div></div>';
          }).join('') +
        '</div>' +
        '<div class="card plan-card">' +
          '<h3>近 7 天</h3><div class="desc">新词 + 复习的完成量。</div>' +
          '<div class="bars">' + week.map(function (d) {
            var max = Math.max.apply(null, week.map(function (x) { return x.total; }).concat([1]));
            return '<div class="bar-wrap" title="' + d.date + ' · ' + d.total + ' 词">' +
              '<div class="bar" style="height:' + Math.max(3, d.total / max * 100) + '%"><i></i></div>' +
              '<span class="bar-label">' + '日一二三四五六'[new Date(d.date.split('-').map(Number)[0], d.date.split('-').map(Number)[1] - 1, d.date.split('-').map(Number)[2]).getDay()] + '</span></div>';
          }).join('') + '</div>' +
        '</div>' +
        '<div class="card plan-card">' +
          '<h3>未来 7 天复习量</h3><div class="desc">按当前间隔，预计每天要复习的词数。</div>' +
          [0, 1, 2, 3, 4, 5, 6].map(function (d) {
            var n = dueForecast[d] || 0;
            return '<div class="legend-row"><span>' + (d === 0 ? '今天' : d + ' 天后') + '</span><span class="mono small">' + n + ' 词</span></div>';
          }).join('') +
        '</div>' +
        '<div class="card plan-card">' +
          '<h3>CEFR 等级进度</h3><div class="desc">对照欧标，看看整体覆盖。</div>' +
          cefr.map(function (x) {
            return '<div style="margin:9px 0"><div class="legend-row"><span>' + x.cefr + '</span><span class="mono tiny">' + x.done + ' / ' + x.all + '</span></div>' +
              '<div class="queue-bar" style="margin:3px 0 0"><i style="width:' + (x.all ? x.done / x.all * 100 : 0) + '%;background:var(--accent)"></i></div></div>';
          }).join('') +
        '</div>' +
      '</div>' +
      '<div class="card plan-card" style="margin-top:14px">' +
        '<h3>最近 5 周打卡</h3><div class="desc">颜色越深，当天完成的词越多。</div>' +
        '<div class="calendar" style="grid-template-columns:repeat(7,minmax(0,1fr));max-width:420px">' + heatCells + '</div>' +
        '<div class="cal-legend"><span>少</span><i style="background:var(--bg-sunken)"></i><i style="background:color-mix(in srgb,var(--accent) 16%,var(--bg-sunken))"></i>' +
          '<i style="background:color-mix(in srgb,var(--accent) 34%,var(--bg-sunken))"></i><i style="background:color-mix(in srgb,var(--accent) 58%,var(--bg-sunken))"></i>' +
          '<i style="background:var(--accent)"></i><span>多</span></div>' +
      '</div>';
  }

  /* ---------- 详情抽屉 ---------- */

  function openDrawer(word) {
    var w = BY_WORD.get(word);
    if (!w) return;
    var rec = S.word(w.w);
    var band = bandOf(w.f);
    var mor = morphOf(w.w);

    $('#drawerHead').innerHTML =
      '<div><div class="detail-word">' + esc(w.w) + '</div>' +
      '<div class="word-meta" style="margin-top:6px">' +
        (cleanPhonetic(w.ph) ? '<span class="phon">/' + esc(cleanPhonetic(w.ph)) + '/</span>' : '') +
        '<span class="badge" data-tone="' + band.tone + '">' + band.label + ' ' + w.f + '</span>' +
        '<span class="badge">#' + (w._i + 1) + '</span>' +
        (w.cefr ? '<span class="badge">CEFR ' + w.cefr + '</span>' : '') +
      '</div></div>' +
      '<div style="display:flex;gap:6px">' +
        '<button class="icon-btn" data-act="speak" data-speak="' + esc(w.w) + '" title="发音"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg></button>' +
        '<button class="icon-btn" data-act="star" title="收藏">' + (S.starred(w.w) ? '★' : '☆') + '</button>' +
        '<button class="icon-btn" data-act="close-drawer" title="关闭">✕</button>' +
      '</div>';

    var html = '';

    html += '<div class="detail-block"><h4>释义</h4>' +
      (posList(w).length ? '<div class="word-meta" style="margin:0 0 8px">' + posList(w).map(function (p) {
        return '<span class="badge" data-tone="accent" title="' + esc(POS_CN[p] || p) + '">' +
          esc(POS_LABEL[p] || (p + '.')) + ' ' + esc(POS_CN[p] || '') + '</span>';
      }).join('') + '</div>' : '') +
      '<p style="font-size:16px">' + esc(w.t) + '</p>' +
      '<div class="tiny faint">' + esc(w.cat) + (w.acad ? ' · 学术词汇' : '') + (w.adv ? ' · 高级词汇' : '') +
      (w.alt ? ' · 其他拼写：' + esc(w.alt) : '') + '</div></div>';

    if (w.ex) {
      html += '<div class="detail-block"><h4>例句</h4><div class="example"><div class="en">' + esc(w.ex) + '</div>' +
        (w.exz ? '<div class="zh">' + esc(w.exz) + '</div>' : '') +
        (w.exs ? '<button class="btn btn-sm btn-ghost" data-act="speak" data-speak="' + esc(w.ex) + '" style="padding:2px 0;margin-top:4px">朗读例句</button>' : '') +
        (w.exs ? '<div class="src">' + esc(w.exs) + (w.z ? ' · 真题出现 ' + w.z + ' 次' : '') + '</div>' : '') +
        '</div></div>';
    }

    html += '<div class="detail-block"><h4>词根词缀</h4>' +
      '<div class="morph" style="margin-top:0">' + morphHTML(w.w) + '</div>';
    if (w.rt) html += '<p style="margin-top:12px"><b class="small">词根</b><br>' + esc(cleanNote(w.rt)) + '</p>';
    if (w.af) html += '<p><b class="small">词缀</b><br>' + esc(cleanNote(w.af)) + '</p>';
    if (w.mem) html += '<div class="morph" style="border-style:solid"><div class="morph-title">记忆辅助</div><div class="morph-note">' + esc(w.mem) + '</div></div>';
    html += '<div class="tiny faint" style="margin-top:8px">词根词缀解析来自开源 AI 词库，仅供记忆参考；发现明显错误可自行忽略。</div>';
    html += '</div>';

    var fam = FAMILY[mor.rootKey] || [];
    if (fam.length > 1) {
      html += '<div class="detail-block"><h4>同根词 · ' + esc(mor.rootKey) + '（' + fam.length + '）</h4>' +
        '<div class="family-list">' + fam.filter(function (x) { return x !== w.w; }).slice(0, 20).map(function (x) {
          return '<button data-open="' + esc(x) + '">' + esc(x) + '</button>';
        }).join('') + '</div></div>';
    }

    if (w.hist) {
      html += '<div class="detail-block"><h4>词源与文化</h4><p class="muted small">' + esc(w.hist) + '</p></div>';
    }

    html += '<div class="detail-block"><h4>我的熟悉度</h4>' +
      '<div class="seg-level">' + [0, 1, 2, 3, 4, 5].map(function (lv) {
        return '<button data-lv="' + lv + '" aria-pressed="' + ((rec && rec.first ? rec.lv : 0) === lv) + '" style="--c:' + (lv === 0 ? 'var(--fg-muted)' : 'var(--level-' + lv + ')') + '">' + levelName(lv) + '</button>';
      }).join('') + '</div>' +
      (rec && rec.first
        ? '<div class="tiny faint" style="margin-top:8px">已复习 ' + rec.reps + ' 次 · 下次 ' + esc(dueLabel(rec)) + ' · 当前间隔 ' + (rec.iv || 0) + ' 天</div>'
        : '<div class="tiny faint" style="margin-top:8px">还没有学习记录。选一个熟悉度会写入今日进度并安排复习。</div>') +
    '</div>';

    html += '<div class="detail-block"><h4>我的笔记</h4>' +
      '<textarea class="note-area" id="noteArea" placeholder="记下你的联想、易混词、真题句子…">' + esc(S.note(w.w)) + '</textarea></div>';

    html += '<div class="detail-block" style="border-top:1px solid var(--border);padding-top:14px">' +
      '<button class="btn btn-sm" data-del="' + esc(w.w) + '" style="color:var(--danger)">从词库移除「' + esc(w.w) + '」</button>' +
      '<div class="tiny faint" style="margin-top:6px">只从当前词库隐藏，学习记录会保留；可在 设置 → 数据 里恢复。</div></div>';

    $('#drawerBody').innerHTML = html;
    $('#drawer').classList.add('open');
    $('#drawerMask').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#drawer').dataset.word = w.w;
    $('#drawerBody').scrollTop = 0;
  }

  function deleteWord(word) {
    if (!word) return;
    S.removeFromLibrary(word);
    buildIndexes();
    closeDrawer();
    render();
    toast('已从词库移除「' + word + '」', '撤销', function () {
      S.restoreToLibrary(word);
      buildIndexes();
      render();
      toast('已恢复「' + word + '」');
    });
  }

  function quickReview(word) {
    var rec = S.word(word);
    var g = rec && rec.lv >= 4 ? 4 : 3;
    SRS.grade(word, g);
    var next = S.word(word);
    var when = next && next.due ? dueLabel(next) : '';
    toast('已记录「' + word + '」' + (when ? ' · 下次 ' + when : ''));
    render();
  }

  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawerMask').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
  }

  function setLevel(word, lv) {
    var rec = S.word(word);
    var today = S.todayStr();
    var next = SRS.next({ lv: lv, iv: rec ? rec.iv : 0, reps: rec ? rec.reps : 0, lapses: rec ? rec.lapses : 0, ease: rec ? rec.ease : 2.5 }, null);
    S.setWord(word, next);
    var d = S.day();
    if (lv > 0) {
      if (d.new.indexOf(word) === -1) d.new.push(word);
      S.touchStreak();
    } else {
      d.new = d.new.filter(function (x) { return x !== word; });
    }
    S.save();
    if ($('#drawer').classList.contains('open')) openDrawer(word);
    render();
    toast('已设置为「' + levelName(lv) + '」');
  }

  /* ---------- 设置 ---------- */

  function openSettings() {
    var st = S.getSettings();
    var root = $('#modalRoot');
    root.innerHTML =
      '<div class="modal-mask"><div class="modal" role="dialog" aria-modal="true" aria-label="设置">' +
        '<div class="modal-head"><h3>设置与数据</h3><button class="icon-btn" data-close="1">✕</button></div>' +
        '<div class="modal-body">' +
          '<div class="field"><label>每日新词量</label><input class="input" id="setDaily" type="number" min="5" max="300" step="5" value="' + st.dailyNew + '"></div>' +
          '<div class="field"><label>每次最多复习（词）</label><input class="input" id="setReview" type="number" min="20" max="500" step="10" value="' + (st.reviewLimit || 150) + '"></div>' +
          '<div class="field"><label>考试日期（用于倒计时与进度预测）</label><input class="input" id="setExam" type="date" value="' + esc(st.examDate) + '"></div>' +
          '<div class="field"><label>新词顺序</label><select class="select" id="setOrder">' +
            option('priority', '学习优先级（词频 × 难度，推荐）', st.order) +
            option('freq', '纯词频从高到低', st.order) +
          '</select></div>' +
          '<label class="field" style="flex-direction:row;align-items:center;gap:8px;cursor:pointer">' +
            '<input type="checkbox" id="setSkipA1"' + (st.skipA1 ? ' checked' : '') + '> ' +
            '<span>新词队列跳过 CEFR A1 基础词</span></label>' +
          '<label class="field" style="flex-direction:row;align-items:center;gap:8px;cursor:pointer">' +
            '<input type="checkbox" id="setHideBasic"' + (st.hideBasic !== false ? ' checked' : '') + '> ' +
            '<span>词库隐藏基础虚词（a / the / this / of …）</span></label>' +
          '<div class="field"><label>发音方式</label><select class="select" id="setAudio">' +
            option('system', '系统语音（离线，音色取决于系统）', st.audioSource) +
            option('youdao', '在线美音 · 有道（需联网）', st.audioSource) +
          '</select></div>' +
          '<button class="btn btn-sm" id="testAudio" style="margin:-4px 0 10px">试听 comprehension</button>' +
          '<div class="tiny faint" style="margin:-4px 0 12px">系统语音的音色取决于操作系统；如果读得别扭，建议切到在线美音。</div>' +
          '<div class="field"><label>主题</label><select class="select" id="setTheme">' +
            option('auto', '跟随系统', st.theme) + option('light', '浅色', st.theme) + option('dark', '深色', st.theme) +
          '</select></div>' +
          '<div class="section-title" style="margin:18px 0 6px"><h2>数据</h2></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="btn btn-sm" id="exportBtn">导出备份 JSON</button>' +
            '<button class="btn btn-sm" id="importBtn">导入备份</button>' +
            '<button class="btn btn-sm" id="resetBtn" style="color:var(--danger)">清空学习记录</button>' +
            '<button class="btn btn-sm" id="restoreRemovedBtn">恢复已移除的词（' + S.removedCount() + '）</button>' +
            '<input type="file" id="importFile" accept=".json,application/json" style="display:none">' +
          '</div>' +
          '<div class="section-title" style="margin:20px 0 6px"><h2>快捷键</h2></div>' +
          '<div class="small muted">空格：显示释义 · 1/2/3/4：忘记/模糊/认识/秒杀 · S：发音 · Esc：关闭</div>' +
          '<div class="section-title" style="margin:20px 0 6px"><h2>数据来源</h2></div>' +
          '<div class="source-list">' + META.sources.map(function (s) {
            return '<div class="li"><a href="' + s.url + '" target="_blank" rel="noopener">' + esc(s.name) + '</a>' +
              '<div class="tiny faint">' + esc(s.used) + ' · ' + esc(s.license) + '</div></div>';
          }).join('') + '</div>' +
          '<div class="tiny faint" style="margin-top:12px">数据文件生成于 ' + esc(META.builtAt) + '，当前 ' + WORDS.length + ' 词；词根解析 ' + META.withRoots + ' 条、音标 ' + META.withPhonetic + ' 条。全部学习记录只保存在本机浏览器。</div>' +
        '</div>' +
        '<div class="modal-foot"><button class="btn" data-close="1">关闭</button><button class="btn btn-primary" id="saveSettings">保存设置</button></div>' +
      '</div></div>';
  }

  function closeModal() { $('#modalRoot').innerHTML = ''; }

  /* ---------- 路由与事件 ---------- */

  var VIEWS = {
    today: renderToday,
    library: renderLibrary,
    papers: renderPapers,
    exam: renderExam,
    roots: renderRoots,
    stats: renderStats
  };

  function render() {
    var top = window.scrollY;
    document.body.classList.toggle('exam-mode', state.view === 'exam');
    $('#view').innerHTML = VIEWS[state.view]();
    var activeView = state.view === 'exam' ? 'papers' : state.view;
    $$('#tabs button').forEach(function (b) {
      b.setAttribute('aria-selected', b.dataset.view === activeView);
    });
    if (state.view === 'exam' && state.exam && !state.exam.submitted) startExamTimer();
    else stopExamTimer();
    $('#streakNum').textContent = S.get().stats.streak || 0;
    if (state.view === 'library') {
      setupLibObserver();
      var inp = $('#libSearch');
      if (inp && state.lib.q && document.activeElement !== inp) {
        inp.value = state.lib.q;
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    }
    window.scrollTo(0, top > 0 ? top : 0);
  }

  function go(view) {
    if (state.view === 'exam' && view !== 'exam') {
      if (state.exam && !state.exam.submitted && !Object.keys(state.exam.sess.answers || {}).length) {
        EXAM_clearEmptySession();
      }
      stopExamTimer();
      state.exam = null;
    }
    state.view = view;
    state.session = null;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function EXAM_clearEmptySession() {
    var sess = EX.getSession();
    if (sess && !Object.keys(sess.answers || {}).length) EX.clearSession();
  }

  function bindGlobal() {
    $('#tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-view]');
      if (b) go(b.dataset.view);
    });

    $('#themeBtn').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      S.setSettings({ theme: next });
    });

    $('#settingsBtn').addEventListener('click', openSettings);
    $('#drawerMask').addEventListener('click', closeDrawer);

    document.addEventListener('click', function (e) {
      var t = e.target;

      var quick = t.closest('[data-quick]');
      if (quick) {
        e.preventDefault();
        e.stopPropagation();
        quickReview(quick.dataset.quick);
        return;
      }

      var del = t.closest('[data-del]');
      if (del) {
        e.preventDefault();
        e.stopPropagation();
        deleteWord(del.dataset.del);
        return;
      }

      var open = t.closest('[data-open]');
      if (open) { openDrawer(open.dataset.open); return; }

      var act = t.closest('[data-act]');
      if (act) {
        var a = act.dataset.act;
        if (a === 'speak') speak(act.dataset.speak || '');
        if (a === 'star') {
          var word = $('#drawer').dataset.word;
          if (!word && state.session) word = state.session.queue[state.session.i].w.w;
          if (word) {
            var on = S.toggleStar(word);
            toast(on ? '已收藏' : '已取消收藏');
            if ($('#drawer').classList.contains('open')) openDrawer(word);
            render();
          }
        }
        if (a === 'reveal') reveal();
        if (a === 'end') { state.session = null; render(); }
        if (a === 'exit-exam') { examExit(); return; }
        if (a === 'submit-exam') { examSubmit(); return; }
        if (a === 'confirm-submit') { doSubmitExam(); return; }
        if (a === 'flag') { examFlag(); return; }
        if (a === 'prev') { examJump(state.exam.sess.index - 1); return; }
        if (a === 'next') { examJump(state.exam.sess.index + 1); return; }
        if (a === 'toggle-zh') { state.exam.showZh = !state.exam.showZh; renderKeepScroll(); return; }
        if (a === 'toggle-passage') { state.exam.showPassage = !state.exam.showPassage; renderKeepScroll(); return; }
        if (a === 'back-papers') { stopExamTimer(); state.exam = null; state.view = 'papers'; render(); window.scrollTo(0, 0); return; }
        if (a === 'retry-paper') { var _p = state.exam.paper; var _m = state.exam.attempt ? state.exam.attempt.mode : 'practice'; startPaper(_p.id, _m); return; }
        if (a === 'toggle-wrong') { state.exam.onlyWrong = !state.exam.onlyWrong; render(); return; }
        if (a === 'restart') { state.session = null; startSession(); }
        if (a === 'close-drawer') closeDrawer();
        return;
      }

      var gradeBtn = t.closest('[data-grade]');
      if (gradeBtn) { grade(Number(gradeBtn.dataset.grade)); return; }

      var start = t.closest('#startBtn, #startBtn2');
      if (start) { startSession(); return; }

      var check = t.closest('input[data-check]');
      if (check) {
        e.preventDefault();
        toggleCheck(check.dataset.check);
        return;
      }

      var chipBtn = t.closest('[data-status]');
      if (chipBtn && $('#libSearch')) {
        state.lib.status = chipBtn.dataset.status;
        state.lib.limit = 90;
        render();
        return;
      }

      var ptab = t.closest('[data-ptab]');
      if (ptab) {
        state.paperTab = ptab.dataset.ptab;
        render();
        return;
      }

      var ptype = t.closest('[data-ptype]');
      if (ptype) {
        state.paperFilter.type = ptype.dataset.ptype;
        render();
        return;
      }

      var paperEl = t.closest('[data-paper]');
      if (paperEl) { openPaperStart(paperEl.dataset.paper); return; }

      var startEl = t.closest('[data-start]');
      if (startEl) {
        var modal = t.closest('.paper-start');
        var target = modal && modal.dataset.paperId;
        if (target) startPaper(target, startEl.dataset.start);
        return;
      }

      var resumeEl = t.closest('[data-resume]');
      if (resumeEl) { resumePaper(); return; }

      var discardEl = t.closest('[data-discard]');
      if (discardEl) {
        if (confirm('放弃这套未完成的练习？')) {
          EX.clearSession();
          render();
        }
        return;
      }

      var attemptEl = t.closest('[data-attempt]');
      if (attemptEl) { showAttempt(attemptEl.dataset.attempt); return; }

      var wrongEl = t.closest('[data-wrong]');
      if (wrongEl) {
        var parts = wrongEl.dataset.wrong.split('|');
        showWrong(parts[0], Number(parts[1]));
        return;
      }

      var optEl = t.closest('[data-opt]');
      if (optEl && state.view === 'exam' && state.exam && !state.exam.submitted) {
        examChoose(Number(optEl.dataset.opt));
        return;
      }

      var jumpEl = t.closest('[data-jump]');
      if (jumpEl) { examJump(Number(jumpEl.dataset.jump)); return; }

      var gotoEl = t.closest('[data-goto]');
      if (gotoEl) {
        state.view = 'library';
        state.lib.status = gotoEl.dataset.goto;
        state.lib.limit = 90;
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      var rootBtn = t.closest('[data-root]');
      if (rootBtn) {
        state.rootKey = rootBtn.dataset.root;
        render();
        return;
      }

      var lvBtn = t.closest('[data-lv]');
      if (lvBtn && $('#drawer').classList.contains('open')) {
        setLevel($('#drawer').dataset.word, Number(lvBtn.dataset.lv));
        return;
      }

      // 设置弹窗
      if (t.closest('[data-close]') || (t.classList && t.classList.contains('modal-mask'))) {
        if (t.classList.contains('modal-mask') || t.closest('[data-close]')) closeModal();
      }
    });

    document.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'libCefr') { state.lib.cefr = t.value; state.lib.limit = 90; render(); }
      if (t.dataset && t.dataset.levelFor) {
        setLevel(t.dataset.levelFor, Number(t.value));
        return;
      }
      if (t.id === 'libBand') { state.lib.band = t.value; state.lib.limit = 90; render(); }
      if (t.id === 'libPos') { state.lib.pos = t.value; state.lib.limit = 90; render(); }
      if (t.id === 'paperYear') { state.paperFilter.year = t.value; render(); }
      if (t.id === 'libSort') { state.lib.sort = t.value; render(); }
      if (t.id === 'libLetter') { state.lib.letter = t.value; state.lib.limit = 90; render(); }
      if (t.id === 'setTheme') {
        var th = t.value;
        var actual = th === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : th;
        document.documentElement.setAttribute('data-theme', actual);
      }
      if (t.id === 'importFile' && t.files && t.files[0]) {
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var n = S.importJSON(String(reader.result));
            closeModal(); render(); toast('已导入 ' + n + ' 个单词的学习记录');
          } catch (err) { toast('导入失败：' + err.message); }
        };
        reader.readAsText(t.files[0]);
      }
    });

    document.addEventListener('input', function (e) {
      var t = e.target;
      if (t.id === 'libSearch') {
        state.lib.q = t.value;
        state.lib.limit = 90;
        render();
        var inp = $('#libSearch');
        if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
      }
      if (t.id === 'rootSearch') {
        state.rootQuery = t.value;
        render();
        var r = $('#rootSearch');
        if (r) { r.focus(); r.setSelectionRange(r.value.length, r.value.length); }
      }
      if (t.id === 'noteArea') {
        clearTimeout(t._timer);
        t._timer = setTimeout(function () { S.setNote($('#drawer').dataset.word, t.value); toast('笔记已保存'); }, 500);
      }
    });

    document.addEventListener('click', function (e) {
      if (e.target.id === 'toastAction' && toastAction) {
        var fn = toastAction;
        toastAction = null;
        $('#toast').classList.remove('show');
        fn();
        return;
      }
      if (e.target.id === 'exportBtn') {
        var blob = new Blob([S.exportJSON()], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'kaoyan-vocab-backup-' + S.todayStr() + '.json';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
        toast('备份已导出');
      }
      if (e.target.id === 'testAudio') {
        speak('comprehension', $('#setAudio').value || 'system');
        return;
      }
      if (e.target.id === 'importBtn') $('#importFile').click();
      if (e.target.id === 'restoreRemovedBtn') {
        var n = S.restoreAllRemoved();
        buildIndexes();
        closeModal();
        render();
        toast(n ? '已恢复 ' + n + ' 个词' : '没有需要恢复的词');
      }
      if (e.target.id === 'resetBtn') {
        if (confirm('确定清空全部学习记录？此操作不可撤销，建议先导出备份。')) {
          S.reset(); closeModal(); render(); toast('已清空，重新开始');
        }
      }
      if (e.target.id === 'saveSettings') {
        var daily = Math.max(5, Math.min(300, parseInt($('#setDaily').value, 10) || 50));
        var review = Math.max(20, Math.min(500, parseInt($('#setReview').value, 10) || 150));
        var exam = $('#setExam').value || '';
        var theme = $('#setTheme').value || 'auto';
        var order = $('#setOrder').value || 'priority';
        var skipA1 = $('#setSkipA1').checked;
        var hideBasic = $('#setHideBasic').checked;
        var audioSource = $('#setAudio').value || 'system';
        S.setSettings({ dailyNew: daily, reviewLimit: review, examDate: exam, theme: theme, order: order, skipA1: skipA1, hideBasic: hideBasic, audioSource: audioSource });
        buildIndexes();
        state.session = null;
        closeModal(); render(); toast('设置已保存，词库当前 ' + WORDS.length + ' 词');
      }
    });

    /* 键盘 */
    document.addEventListener('keydown', function (e) {
      if (e.target.matches('input, textarea, select')) return;
      if (e.key === 'Escape') { closeModal(); closeDrawer(); return; }
      if (state.view === 'exam' && state.exam && !state.exam.submitted) {
        var st = state.exam;
        if (/^[1-9]$/.test(e.key)) {
          var oi = Number(e.key) - 1;
          if (oi < st.paper.questions[st.sess.index].opts.length) { e.preventDefault(); examChoose(oi); }
          return;
        }
        if (/^[a-gA-G]$/.test(e.key)) {
          var li = e.key.toUpperCase().charCodeAt(0) - 65;
          if (li < st.paper.questions[st.sess.index].opts.length) { e.preventDefault(); examChoose(li); }
          return;
        }
        if (e.key === 'ArrowRight') { e.preventDefault(); examJump(st.sess.index + 1); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); examJump(st.sess.index - 1); return; }
        if (e.key === 'f' || e.key === 'F') { e.preventDefault(); examFlag(); return; }
        if (e.key === 'Enter') { e.preventDefault(); if (st.sess.index < st.paper.questions.length - 1) examJump(st.sess.index + 1); return; }
        return;
      }
      if (!state.session) return;
      if (e.code === 'Space') { e.preventDefault(); reveal(); return; }
      if (['1', '2', '3', '4'].indexOf(e.key) !== -1 && state.session.revealed) {
        e.preventDefault();
        grade(Number(e.key));
      }
      if (e.key === 's' || e.key === 'S') {
        var it = state.session.queue[state.session.i];
        if (it) speak(it.w.w);
      }
    });

    /* 词库滚动到底部自动加载 */
    window.addEventListener('scroll', function () {
      if (state.view !== 'library') return;
      var doc = document.documentElement;
      if (window.innerHeight + window.scrollY < doc.scrollHeight - 600) return;
      loadMoreLibrary();
    }, { passive: true });

    // 兜底：某些浏览器/内嵌面板里 scroll 事件不触发时，定时检查是否到底
    setInterval(function () {
      if (state.view !== 'library' || state.lib.loading) return;
      if (state.lib.limit >= (state.lib.total || 0)) return;
      var doc = document.documentElement;
      if (window.innerHeight + window.scrollY < doc.scrollHeight - 700) return;
      loadMoreLibrary();
    }, 600);

    /* 主题跟随系统 */
    if (matchMedia) {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if (S.getSettings().theme === 'auto') applyTheme();
      });
    }
  }

  function applyTheme() {
    var theme = S.getSettings().theme || 'auto';
    var actual = theme === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
    document.documentElement.setAttribute('data-theme', actual);
  }

  /* ---------- 启动 ---------- */

  function boot() {
    applyTheme();
    S.load();
    refreshVoices();
    if ('speechSynthesis' in global) {
      global.speechSynthesis.onvoiceschanged = refreshVoices;
    }
    buildIndexes();
    state.session = null;
    bindGlobal();
    render();
    // 首次进入给一点提示
    if (!S.get().stats.lastActive) {
      setTimeout(function () { toast('欢迎：先设置每日新词量，再开始今天的学习'); }, 700);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.KY_APP = { go: go, openDrawer: openDrawer, state: state };
})(typeof window !== 'undefined' ? window : globalThis);
