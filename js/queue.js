/*
 * 生词本 / 复习队列的纯逻辑工具
 * ------------------------------------------------------------
 * 把「今天练什么」的编排从 UI 里抽出来，方便替换策略：
 *   - 新词优先按词频（或智能重排）取，且尊重用户的每日额度
 *   - 复习词按遗忘曲线到期时间排序，逾期最久的排前面
 *   - 打卡日历、图表等统计也放这里
 */
(function (global) {
  'use strict';

  function startOfWeek(dateStr) {
    var p = dateStr.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    var wd = d.getDay(); // 0=周日
    return global.KY_STORE.addDays(dateStr, -wd);
  }

  /* 最近 n 天的打卡记录（用于热力日历） */
  function heatmap(n) {
    var S = global.KY_STORE;
    var days = [];
    var today = S.todayStr();
    for (var i = n - 1; i >= 0; i--) {
      var d = S.addDays(today, -i);
      var rec = S.get().days[d];
      days.push({
        date: d,
        newCount: rec ? rec.new.length : 0,
        reviewCount: rec ? rec.review.length : 0,
        total: rec ? (rec.new.length + rec.review.length) : 0
      });
    }
    return days;
  }

  /* 近 7 天柱状图 */
  function weekly() {
    return heatmap(7);
  }

  function monthStats(monthStr) {
    var S = global.KY_STORE;
    var all = S.get().days;
    var prefix = monthStr || S.todayStr().slice(0, 7);
    var out = { days: 0, new: 0, review: 0 };
    Object.keys(all).forEach(function (k) {
      if (k.slice(0, 7) !== prefix) return;
      var r = all[k];
      out.days++;
      out.new += r.new ? r.new.length : 0;
      out.review += r.review ? r.review.length : 0;
    });
    return out;
  }

  /* 单词状态筛选器：all | new | learning | due | known | star | note | wrong */
  function makeFilter(kind, extra) {
    var S = global.KY_STORE;
    return function (w) {
      var rec = S.word(w.w);
      var lv = rec ? rec.lv : 0;
      switch (kind) {
        case 'new': return !rec || !rec.first;
        case 'learning': return rec && rec.first && lv < 3;
        case 'due': return rec && rec.due && rec.due <= S.todayStr();
        case 'known': return lv >= 4;
        case 'star': return S.starred(w.w);
        case 'note': return !!S.note(w.w);
        case 'wrong': return rec && rec.lapses > 0;
        case 'range': return extra && w.f >= extra.min && w.f < extra.max;
        default: return true;
      }
    };
  }

  /* 分组：按 CEFR / 语义分类 / 熟悉度 */
  function groupBy(words, keyFn) {
    var map = {};
    words.forEach(function (w) {
      var k = keyFn(w) || '未分类';
      (map[k] = map[k] || []).push(w);
    });
    return map;
  }

  global.KY_QUEUE = {
    heatmap: heatmap,
    weekly: weekly,
    monthStats: monthStats,
    makeFilter: makeFilter,
    groupBy: groupBy,
    startOfWeek: startOfWeek
  };
})(typeof window !== 'undefined' ? window : globalThis);
