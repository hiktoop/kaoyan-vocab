/*
 * 考研英语（二）真题 · 数据与评分
 * ------------------------------------------------------------
 * 数据来自 data/papers.js（由 scripts/build_papers.py 生成）。
 * 这里只放纯逻辑：取卷、判分、保存记录、统计分析。
 * 界面在 js/app.js 的 papers / exam 视图里。
 */
(function (global) {
  'use strict';

  var DATA = global.KY_PAPERS || { meta: {}, papers: [] };
  var S = global.KY_STORE;

  var PAPERS = DATA.papers || [];
  var META = DATA.meta || {};
  var BY_ID = new Map();
  PAPERS.forEach(function (p) { BY_ID.set(p.id, p); });

  var TYPES = {
    reading: { name: '阅读理解', short: '阅读', color: 'info' },
    cloze: { name: '完形填空', short: '完形', color: 'warning' },
    newtype: { name: '新题型', short: '新题型', color: 'accent' }
  };

  function ensure() {
    var s = S.get();
    if (!s.exam) s.exam = { attempts: [], session: null };
    if (!Array.isArray(s.exam.attempts)) s.exam.attempts = [];
    return s.exam;
  }

  function get(id) { return BY_ID.get(id) || null; }

  function typeMeta(t) { return TYPES[t] || { name: t, short: t, color: '' }; }

  /* 判分：answers 为 {题号: 选项下标}，未答视为空 */
  function grade(paper, answers) {
    var details = [], correct = 0;
    (paper.questions || []).forEach(function (q, i) {
      var chosen = answers && answers[i] != null ? answers[i] : null;
      var ok = chosen === q.ans;
      if (ok) correct++;
      details.push({ n: i + 1, q: q, chosen: chosen, correct: q.ans, ok: ok });
    });
    var total = details.length;
    var score = total && paper.score ? (correct / total) * paper.score : correct;
    return {
      total: total, correct: correct,
      score: Math.round(score * 10) / 10,
      fullScore: paper.score || total,
      accuracy: total ? correct / total : 0,
      details: details
    };
  }

  function createSession(paperId, mode) {
    var now = Date.now();
    var sess = {
      paperId: paperId, mode: mode || 'practice',
      answers: {}, flags: {}, index: 0,
      startedAt: now, updatedAt: now
    };
    ensure().session = sess;
    S.save();
    return sess;
  }

  function getSession() {
    var ex = ensure();
    if (!ex.session) return null;
    if (!get(ex.session.paperId)) { ex.session = null; S.save(); return null; }
    return ex.session;
  }

  function saveSession(sess) {
    var ex = ensure();
    if (sess) { sess.updatedAt = Date.now(); ex.session = sess; }
    else ex.session = null;
    S.save();
  }

  function clearSession() {
    var ex = ensure();
    ex.session = null;
    S.save();
  }

  function saveAttempt(paper, sess, result) {
    var ex = ensure();
    var now = Date.now();
    var attempt = {
      id: 'a' + now,
      paperId: paper.id,
      title: paper.title,
      year: paper.year,
      type: paper.type,
      mode: sess.mode,
      startedAt: sess.startedAt,
      finishedAt: now,
      duration: Math.max(1, Math.round((now - sess.startedAt) / 1000)),
      total: result.total,
      correct: result.correct,
      score: result.score,
      fullScore: result.fullScore,
      answers: sess.answers
    };
    ex.attempts.unshift(attempt);
    if (ex.attempts.length > 300) ex.attempts.length = 300;
    ex.session = null;
    S.save();
    return attempt;
  }

  function attempts() {
    return ensure().attempts.slice();
  }

  /* 最近一次某套卷的成绩 */
  function bestOf(paperId) {
    var list = ensure().attempts.filter(function (a) { return a.paperId === paperId; });
    if (!list.length) return null;
    var best = list.reduce(function (m, a) {
      return (a.correct / (a.total || 1)) > (m.correct / (m.total || 1)) ? a : m;
    }, list[0]);
    return { best: best, last: list[0], count: list.length };
  }

  function stats() {
    var list = attempts();
    var totalQ = 0, correct = 0, duration = 0;
    var byType = {}, byYear = {}, days = {}, papers = {};
    var trend = [];

    list.forEach(function (a) {
      totalQ += a.total || 0;
      correct += a.correct || 0;
      duration += a.duration || 0;
      papers[a.paperId] = true;
      var t = byType[a.type] || (byType[a.type] = { attempts: 0, total: 0, correct: 0, duration: 0 });
      t.attempts++; t.total += a.total || 0; t.correct += a.correct || 0; t.duration += a.duration || 0;
      var y = byYear[a.year] || (byYear[a.year] = { attempts: 0, total: 0, correct: 0 });
      y.attempts++; y.total += a.total || 0; y.correct += a.correct || 0;
      var d = new Date(a.finishedAt);
      var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      days[key] = (days[key] || 0) + 1;
    });

    trend = list.slice(0, 12).reverse().map(function (a) {
      return {
        id: a.id, date: a.finishedAt, title: a.title,
        accuracy: a.total ? a.correct / a.total : 0,
        correct: a.correct, total: a.total
      };
    });

    // 错题：按 paperId + 题号 去重，保留最近一次
    var wrongMap = {};
    list.forEach(function (a) {
      var p = get(a.paperId);
      if (!p) return;
      p.questions.forEach(function (q, i) {
        var chosen = a.answers && a.answers[i] != null ? a.answers[i] : null;
        if (chosen === q.ans) return;
        var key = a.paperId + '#' + i;
        if (!wrongMap[key]) {
          wrongMap[key] = {
            key: key, paperId: a.paperId, title: p.title, year: p.year, type: p.type,
            n: i + 1, q: q.q, chosen: chosen, correct: q.ans, explain: q.explain,
            lastAt: a.finishedAt
          };
        }
      });
    });
    var wrong = Object.keys(wrongMap).map(function (k) { return wrongMap[k]; })
      .sort(function (a, b) { return b.lastAt - a.lastAt; }).slice(0, 20);

    // 连续刷题天数
    var dayKeys = Object.keys(days).sort();
    var streak = 0;
    var cursor = new Date();
    for (;;) {
      var k = cursor.getFullYear() + '-' + String(cursor.getMonth() + 1).padStart(2, '0') + '-' + String(cursor.getDate()).padStart(2, '0');
      if (!days[k]) {
        if (k === todayKey()) { cursor.setDate(cursor.getDate() - 1); k = todayKey(cursor); if (!days[k]) break; }
        else break;
      }
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    return {
      attempts: list.length,
      donePapers: Object.keys(papers).length,
      totalQ: totalQ,
      correct: correct,
      accuracy: totalQ ? correct / totalQ : 0,
      duration: duration,
      avgSeconds: totalQ ? duration / totalQ : 0,
      byType: byType,
      byYear: byYear,
      trend: trend,
      wrong: wrong,
      streak: streak
    };
  }

  function todayKey(d) {
    var x = d || new Date();
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  global.KY_EXAM = {
    meta: META,
    papers: PAPERS,
    types: TYPES,
    typeMeta: typeMeta,
    get: get,
    grade: grade,
    createSession: createSession,
    getSession: getSession,
    saveSession: saveSession,
    clearSession: clearSession,
    saveAttempt: saveAttempt,
    attempts: attempts,
    bestOf: bestOf,
    stats: stats,
    fmtDuration: fmtDuration
  };
})(typeof window !== 'undefined' ? window : globalThis);
