/*
 * 本地存储层 · KY_STORE
 * ------------------------------------------------------------
 * 所有学习数据都保存在浏览器 localStorage 里，不上传任何服务器。
 *
 * 数据结构（version 1）：
 *   settings  { dailyNew, examDate, theme, sort, autoReveal }
 *   words     { [word]: { lv, iv, due, reps, lapses, last, first } }
 *   days      { [yyyy-mm-dd]: { new: [...], review: [...], grades: {1..4} } }
 *   notes     { [word]: string }
 *   stars     { [word]: true }
 *   stats     { streak, bestStreak, lastActive, totalReviews, totalGrades }
 *
 * 扩展方式：
 *   - 新增字段：写进 DEFAULT_STATE，并在 MIGRATIONS 里加一条迁移；
 *   - 换存储后端（IndexedDB / 文件 / 服务端）：实现同样的 get/patch/save 接口即可。
 */
(function (global) {
  'use strict';

  var KEY = 'ky_vocab_state_v1';
  var VERSION = 1;

  function todayStr(d) {
    var t = d || new Date();
    var m = String(t.getMonth() + 1).padStart(2, '0');
    var day = String(t.getDate()).padStart(2, '0');
    return t.getFullYear() + '-' + m + '-' + day;
  }

  function addDays(dateStr, n) {
    var p = dateStr.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    d.setDate(d.getDate() + n);
    return todayStr(d);
  }

  function diffDays(a, b) {
    var pa = a.split('-').map(Number), pb = b.split('-').map(Number);
    var da = Date.UTC(pa[0], pa[1] - 1, pa[2]);
    var db = Date.UTC(pb[0], pb[1] - 1, pb[2]);
    return Math.round((da - db) / 86400000);
  }

  function DEFAULT_STATE() {
    return {
      version: VERSION,
      settings: {
        dailyNew: 50,
        examDate: '2026-12-26',
        theme: 'auto',
        sort: 'freq',       // freq | rerank | alpha | level
        autoReveal: false,
        order: 'priority',   // priority = 学习优先级（词频×难度）, freq = 纯词频
        skipA1: true,        // 新词队列跳过 CEFR A1 基础词
        hideBasic: true,     // 词库隐藏 a/the/this 等基础虚词
        audioSource: 'system', // system = 浏览器语音；youdao = 在线美音
        reviewLimit: 150
      },
      words: {},
      days: {},
      notes: {},
      stars: {},
      removed: {},
      exam: { attempts: [], session: null },
      stats: { streak: 0, bestStreak: 0, lastActive: null, totalReviews: 0, totalGrades: { 1: 0, 2: 0, 3: 0, 4: 0 } }
    };
  }

  /* 迁移表：key 为「从哪个版本升级到下一个版本」的处理函数 */
  var MIGRATIONS = {
    // 0: function (s) { s.settings.newThing = 1; return s; }
  };

  function migrate(state) {
    var v = state.version || 0;
    while (v < VERSION) {
      var fn = MIGRATIONS[v];
      if (fn) state = fn(state) || state;
      v++;
      state.version = v;
    }
    return state;
  }

  var state = null;
  var listeners = [];
  var saveTimer = null;

  function load() {
    if (state) return state;
    try {
      var raw = global.localStorage.getItem(KEY);
      if (raw) {
        state = migrate(JSON.parse(raw));
        // 补齐新增字段
        var def = DEFAULT_STATE();
        Object.keys(def).forEach(function (k) {
          if (state[k] == null) state[k] = def[k];
          else if (typeof def[k] === 'object' && !Array.isArray(def[k])) {
            Object.keys(def[k]).forEach(function (kk) {
              if (state[k][kk] == null) state[k][kk] = def[k][kk];
            });
          }
        });
        Object.keys(def.settings).forEach(function (kk) {
          if (state.settings[kk] == null) state.settings[kk] = def.settings[kk];
        });
      } else {
        state = DEFAULT_STATE();
      }
    } catch (e) {
      console.warn('[KY_STORE] 读取失败，使用默认状态', e);
      state = DEFAULT_STATE();
    }
    return state;
  }

  function save(immediate) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    var doSave = function () {
      try {
        global.localStorage.setItem(KEY, JSON.stringify(state));
      } catch (e) {
        console.warn('[KY_STORE] 写入失败（可能是存储空间不足）', e);
      }
    };
    if (immediate) doSave();
    else saveTimer = setTimeout(doSave, 240);
  }

  function emit(reason) {
    listeners.forEach(function (fn) { try { fn(reason); } catch (e) { console.warn(e); } });
  }

  /* 取某天记录，没有则创建 */
  function day(dateStr) {
    var d = dateStr || todayStr();
    var s = load();
    if (!s.days[d]) s.days[d] = { new: [], review: [], grades: { 1: 0, 2: 0, 3: 0, 4: 0 } };
    if (!s.days[d].grades) s.days[d].grades = { 1: 0, 2: 0, 3: 0, 4: 0 };
    return s.days[d];
  }

  /* 更新连续打卡天数（有任意学习记录就算当天活跃） */
  function touchStreak() {
    var s = load();
    var today = todayStr();
    if (s.stats.lastActive === today) return;
    var yesterday = addDays(today, -1);
    s.stats.streak = s.stats.lastActive === yesterday ? (s.stats.streak || 0) + 1 : 1;
    s.stats.bestStreak = Math.max(s.stats.bestStreak || 0, s.stats.streak);
    s.stats.lastActive = today;
  }

  global.KY_STORE = {
    VERSION: VERSION,
    KEY: KEY,
    todayStr: todayStr,
    addDays: addDays,
    diffDays: diffDays,
    load: load,
    save: save,
    day: day,
    touchStreak: touchStreak,
    get: function () { return load(); },
    getSettings: function () { return load().settings; },
    setSettings: function (patch) {
      var s = load();
      Object.assign(s.settings, patch);
      save(); emit('settings');
    },
    word: function (w) { return load().words[w] || null; },
    setWord: function (w, patch) {
      var s = load();
      var cur = s.words[w] || null;
      s.words[w] = Object.assign({ lv: 0, iv: 0, due: null, reps: 0, lapses: 0, last: null, first: null }, cur || {}, patch);
      save(); emit('word');
      return s.words[w];
    },
    removeWord: function (w) {
      var s = load();
      delete s.words[w];
      save(); emit('word');
    },
    note: function (w) { return load().notes[w] || ''; },
    setNote: function (w, text) {
      var s = load();
      if (text && text.trim()) s.notes[w] = text.trim();
      else delete s.notes[w];
      save(); emit('note');
    },
    starred: function (w) { return !!load().stars[w]; },
    removeFromLibrary: function (w) {
      var s = load();
      s.removed[w] = todayStr();
      save(); emit('removed');
    },
    restoreToLibrary: function (w) {
      var s = load();
      delete s.removed[w];
      save(); emit('removed');
    },
    restoreAllRemoved: function () {
      var s = load();
      var n = Object.keys(s.removed || {}).length;
      s.removed = {};
      save(); emit('removed');
      return n;
    },
    isRemoved: function (w) { return !!load().removed[w]; },
    removedCount: function () { return Object.keys(load().removed || {}).length; },
    toggleStar: function (w) {
      var s = load();
      if (s.stars[w]) delete s.stars[w]; else s.stars[w] = true;
      save(); emit('star');
      return !!s.stars[w];
    },
    subscribe: function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    },
    exportJSON: function () {
      return JSON.stringify({ app: 'kaoyan-vocab', exportedAt: new Date().toISOString(), state: load() }, null, 2);
    },
    importJSON: function (text) {
      var obj = JSON.parse(text);
      var incoming = obj && obj.state ? obj.state : obj;
      if (!incoming || !incoming.words) throw new Error('文件格式不正确');
      state = migrate(incoming);
      save(true); emit('import');
      return Object.keys(state.words || {}).length;
    },
    reset: function () {
      state = DEFAULT_STATE();
      save(true); emit('reset');
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
