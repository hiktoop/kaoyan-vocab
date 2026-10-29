/*
 * 记忆算法 · KY_SRS
 * ------------------------------------------------------------
 * 采用「熟悉度 0–5 级 + 间隔重复」的混合模型：
 *   - 0 未学 / 1 生词 / 2 眼熟 / 3 认识 / 4 熟练 / 5 掌握
 *   - 每次评分按 SM-2 的 ease 因子修正间隔，并对遗忘做惩罚
 *   - 间隔上限 180 天，避免考研周期内「排到考试之后」
 *
 * 评分（grade）：
 *   1 忘记    重置到 lv1，间隔 10 分钟（当天重来）
 *   2 模糊    lv 不升或 -1，间隔约为上次的 40%
 *   3 认识    lv +1，间隔按 ease 增长
 *   4 秒杀    lv +2，间隔按 ease ×1.3 增长
 *
 * 纯函数部分（next）不读写存储，方便单元测试与替换算法。
 */
(function (global) {
  'use strict';

  var LEVELS = [
    { lv: 0, name: '未学', color: 'muted' },
    { lv: 1, name: '生词', color: 'danger' },
    { lv: 2, name: '眼熟', color: 'warning' },
    { lv: 3, name: '认识', color: 'info' },
    { lv: 4, name: '熟练', color: 'primary' },
    { lv: 5, name: '掌握', color: 'success' }
  ];

  var BASE_INTERVAL = [0, 1, 2, 4, 8, 16];   // 各等级首次达到时的基础间隔（天）
  var MAX_INTERVAL = 180;
  var MIN_EASE = 1.3;
  var DEFAULT_EASE = 2.5;

  function today() { return global.KY_STORE.todayStr(); }

  /* 估算「下次复习日」；grade=null 表示只按当前等级排程 */
  function next(state, grade) {
    var s = state || { lv: 0, iv: 0, due: null, reps: 0, lapses: 0, ease: DEFAULT_EASE };
    var ease = s.ease || DEFAULT_EASE;
    var lv = s.lv || 0;
    var iv = s.iv || 0;
    var reps = s.reps || 0;
    var lapses = s.lapses || 0;
    var now = today();

    if (grade == null) {
      if (lv <= 0) return { lv: 0, iv: 0, due: now, reps: reps, lapses: lapses, ease: ease, first: s.first || null, last: s.last || null };
      var base = iv || BASE_INTERVAL[lv] || 1;
      return { lv: lv, iv: base, due: global.KY_STORE.addDays(now, base), reps: reps, lapses: lapses, ease: ease, first: s.first || now, last: now };
    }

    if (grade <= 1) {
      /* 忘记：清零重来，当天再练一次 */
      lapses += 1;
      ease = Math.round(Math.max(MIN_EASE, ease - 0.2) * 100) / 100;
      return { lv: 1, iv: 0, due: now, reps: reps + 1, lapses: lapses, ease: ease, first: s.first || now, last: now, relearn: true };
    }

    if (grade === 2) {
      /* 模糊：降一级，间隔缩短 */
      lv = Math.max(1, lv - 1);
      ease = Math.round(Math.max(MIN_EASE, ease - 0.15) * 100) / 100;
      iv = Math.max(1, Math.round((iv || BASE_INTERVAL[lv] || 1) * 0.4));
    } else if (grade === 3) {
      lv = Math.min(5, (lv || 0) + 1);
      ease = Math.min(3.0, ease + 0.05);
      iv = iv ? Math.round(iv * ease) : BASE_INTERVAL[lv];
    } else {
      /* 秒杀 */
      lv = Math.min(5, (lv || 0) + 2);
      ease = Math.min(3.2, ease + 0.12);
      iv = iv ? Math.round(iv * ease * 1.3) : Math.round(BASE_INTERVAL[lv] * 1.4);
    }

    iv = Math.max(1, Math.min(MAX_INTERVAL, iv));
    return {
      lv: lv, iv: iv, due: global.KY_STORE.addDays(now, iv),
      reps: reps + 1, lapses: lapses, ease: ease,
      first: s.first || now, last: now,
      relearn: false
    };
  }

  /* 在一份词表上推进一个单词，并写入本地存储 */
  function grade(word, g) {
    var S = global.KY_STORE;
    var cur = S.word(word) || { lv: 0, iv: 0, due: null, reps: 0, lapses: 0, ease: DEFAULT_EASE, first: null, last: null };
    var nx = next(cur, g);
    S.setWord(word, nx);

    var d = S.day();
    var firstTime = !cur.first;
    if (firstTime) {
      if (d.new.indexOf(word) === -1) d.new.push(word);
    } else if (d.review.indexOf(word) === -1) {
      d.review.push(word);
    }
    d.grades[g] = (d.grades[g] || 0) + 1;

    var st = S.get().stats;
    st.totalReviews = (st.totalReviews || 0) + 1;
    st.totalGrades[g] = (st.totalGrades[g] || 0) + 1;
    S.touchStreak();
    S.save();
    return nx;
  }

  function isDue(w) {
    var rec = global.KY_STORE.word(w);
    if (!rec || !rec.due) return false;
    return rec.due <= today();
  }

  function isNew(w) {
    var rec = global.KY_STORE.word(w);
    return !rec || !rec.first;
  }

  /* 距考试剩余天数（含今天） */
  function daysLeft() {
    var exam = global.KY_STORE.getSettings().examDate;
    if (!exam) return null;
    var n = global.KY_STORE.diffDays(exam, today());
    return n;
  }

  /* 主看板的今日任务：新词计划 + 到期复习 */
  function buildPlan(words, opts) {
    var S = global.KY_STORE;
    var st = S.getSettings();
    var filter = (opts && opts.filter) || function () { return true; };
    var dailyNew = Math.max(0, st.dailyNew | 0);
    var d = S.day();

    var learnedToday = (d.new || []).filter(filter);
    var due = [];
    var fresh = [];
    var started = 0, known = 0;

    words.forEach(function (w) {
      var key = w.w;
      if (!filter(w)) return;
      var rec = S.word(key);
      if (!rec || !rec.first) {
        if (fresh.length < 5000) fresh.push(w);
      } else {
        started++;
        if (rec.lv >= 4) known++;
        // 到期就进队列；「忘记」的词当天会再次到期，所以自然会重复出现
        if (rec.due && rec.due <= today()) due.push(w);
      }
    });

    // 新词顺序：默认按「学习优先级」重排，也可切回纯词频
    if (st.order === 'freq') {
      fresh.sort(function (a, b) { return b.f - a.f; });
    } else {
      fresh.sort(function (a, b) { return (a.rk || 99999) - (b.rk || 99999); });
    }
    // 跳过 CEFR A1 基础词（可在设置里关掉）
    if (st.skipA1) fresh = fresh.filter(function (w) { return w.cefr !== 'A1'; });

    // 今日新词额度
    var quota = Math.max(0, dailyNew - learnedToday.length);
    var newList = fresh.slice(0, quota);

    // 复习按逾期天数排序（越久越先）
    due.sort(function (a, b) {
      var ra = S.word(a.w), rb = S.word(b.w);
      return (ra.due < rb.due ? -1 : ra.due > rb.due ? 1 : 0);
    });

    return {
      newList: newList,
      dueList: due,
      learnedToday: learnedToday,
      quota: quota,
      dailyNew: dailyNew,
      started: started,
      known: known,
      total: words.length
    };
  }

  /* 学习进度与考试倒推 */
  function projection(words) {
    var S = global.KY_STORE;
    var left = daysLeft();
    var st = S.getSettings();
    var plan = buildPlan(words);
    var remaining = plan.total - plan.started;
    var perDay = st.dailyNew || 1;
    var needDays = Math.ceil(remaining / perDay);
    return {
      daysLeft: left,
      remaining: remaining,
      needDays: needDays,
      perDayNeeded: left && left > 0 ? Math.ceil(remaining / left) : remaining,
      onTrack: left == null ? null : needDays <= left
    };
  }

  global.KY_SRS = {
    LEVELS: LEVELS,
    next: next,
    grade: grade,
    isDue: isDue,
    isNew: isNew,
    daysLeft: daysLeft,
    buildPlan: buildPlan,
    projection: projection,
    MAX_INTERVAL: MAX_INTERVAL
  };
})(typeof window !== 'undefined' ? window : globalThis);
