/*
 * 构词拆解引擎 · KY_MORPH
 * ------------------------------------------------------------
 * 纯函数，无依赖，把单词切成「前缀 / 词根 / 后缀」色块。
 *
 * 设计原则：宁可少拆，不可乱拆。
 *   - 每一段必须是 KY_AFFIX 里的真实词缀或词根变体；
 *   - 拼合结果必须 100% 还原原单词；
 *   - 词根与后缀之间最多允许 1 个连接元音。
 *   - 拆不出高置信结果时退回「基础词」，此时页面上仍然显示
 *     逐词人工整理的词根/词缀说明（见 words.js 的 rt / af 字段）。
 *
 * 匹配顺序（命中即停）：
 *   ① 前缀 + 词根 + [后缀…]
 *   ② 词根 + [后缀…]
 *   ③ 前缀 + 词表已知词干 + [后缀…]   （preview = pre + view）
 *   ④ 词表已知词干 + [后缀…]           （dangerous = danger + ous）
 *   ⑤ 合成词                          （classroom）
 *   ⑥ 基础词
 */
(function (global) {
  'use strict';

  var AFFIX = global.KY_AFFIX || { prefixes: [], roots: [], suffixes: [] };

  var PREFIXES = [], SUFFIXES = [], ROOTS = [], ROOT_MAP = {};

  AFFIX.prefixes.forEach(function (p) {
    p.p.forEach(function (surface) {
      PREFIXES.push({ surface: surface, m: p.m, o: p.o, ex: p.ex });
    });
  });
  AFFIX.suffixes.forEach(function (s) {
    s.s.forEach(function (surface) {
      SUFFIXES.push({ surface: surface, m: s.m, pos: s.pos, ex: s.ex });
    });
  });
  AFFIX.roots.forEach(function (r) {
    if (!ROOT_MAP[r.k]) ROOT_MAP[r.k] = { k: r.k, m: r.m, o: r.o, ex: [], vars: [] };
    var e = ROOT_MAP[r.k];
    (r.ex || []).forEach(function (x) { if (e.ex.indexOf(x) === -1) e.ex.push(x); });
    (r.v || [r.k]).forEach(function (v) { if (e.vars.indexOf(v) === -1) e.vars.push(v); });
  });
  Object.keys(ROOT_MAP).forEach(function (k) { ROOTS.push(ROOT_MAP[k]); });

  // 长前缀优先（inter 先于 in）
  PREFIXES.sort(function (a, b) { return b.surface.length - a.surface.length; });
  SUFFIXES.sort(function (a, b) { return b.surface.length - a.surface.length; });
  ROOTS.forEach(function (r) {
    r.vars.sort(function (a, b) { return b.length - a.length; });
  });
  ROOTS.sort(function (a, b) { return b.vars[0].length - a.vars[0].length; });

  var MIN_FRAGMENT = 3;
  var MAX_SUFFIXES = 3;
  var VOWELS = 'aeiouy';

  function isVowel(ch) { return VOWELS.indexOf(ch) !== -1; }

  function basePart(word, gloss) {
    return { type: 'base', text: word, gloss: gloss || '基础词' };
  }

  function baseResult(word, gloss) {
    return { parts: [basePart(word, gloss)], rootKey: null, hasRoot: false, confidence: 0.15 };
  }

  /* 从尾部反复剥离已知后缀，返回 {suffixes, rest} */
  function stripSuffixes(tail) {
    var rest = tail, out = [];
    var guard = 0;
    while (rest.length && out.length < MAX_SUFFIXES && guard++ < 6) {
      var hit = null;
      for (var i = 0; i < SUFFIXES.length; i++) {
        var s = SUFFIXES[i];
        if (rest.length - s.surface.length < 0) continue;
        if (rest.slice(-s.surface.length) === s.surface) { hit = s; break; }
      }
      if (!hit) break;
      out.unshift({ surface: hit.surface, m: hit.m, pos: hit.pos, ex: hit.ex });
      rest = rest.slice(0, -hit.surface.length);
    }
    return { suffixes: out, rest: rest };
  }

  /*
   * 尝试把 segment 解析为「词根 + 连接元音? + 后缀*」。
   * 完全无法消化时返回 null。
   */
  function parseBody(segment) {
    var best = null;
    for (var i = 0; i < ROOTS.length; i++) {
      var root = ROOTS[i];
      for (var j = 0; j < root.vars.length; j++) {
        var v = root.vars[j];
        if (v.length < MIN_FRAGMENT || segment.length < v.length) continue;
        if (segment.slice(0, v.length) !== v) continue;

        var tail = segment.slice(v.length);
        var ps = stripSuffixes(tail);
        var link = ps.rest;
        // 词根与后缀之间：0~2 个字母，且必须是元音（produce 的 duce 里 e）
        if (link.length > 2 || (link.length && !/^[aeiouy]+$/.test(link))) continue;

        var score = v.length * 10 + ps.suffixes.length * 5 - link.length * 2;
        if (link) score -= 2;                       // 少用连接字母的解释
        if (link.length === 1 && link !== 'e' && link !== 'i') score -= 3;
        if (!ps.suffixes.length && link) score -= (link.length === 1 && link === 'e') ? 2 : 14;
        if (v.length === segment.length) score += 6;  // 裸词根（form / case）
        if (!best || score > best.score) {
          best = {
            rootKey: root.k, rootText: v, gloss: root.m, note: root.o, ex: root.ex,
            rootSurface: v, link: link, suffixes: ps.suffixes, score: score
          };
        }
        // 同一词根只取最长变体
        break;
      }
    }
    return best;
  }

  function decompose(word, vocab) {
    var w = String(word == null ? '' : word).trim();
    var low = w.toLowerCase();
    if (!w) return baseResult(w);
    if (!/^[a-z]+$/.test(low)) return baseResult(w, '短语 / 固定搭配');
    if (low.length < MIN_FRAGMENT) return baseResult(w, '基础词');

    var vocabSet = vocab instanceof Set ? vocab : (global.KY_VOCAB_SET || null);

    /* ① / ② 前缀 + 词干，或直接词根 */
    var candidates = [];

    var bodyAlone = parseBody(low);
    if (bodyAlone) candidates.push({ prefix: null, body: bodyAlone, score: bodyAlone.score });

    for (var i = 0; i < PREFIXES.length; i++) {
      var p = PREFIXES[i];
      if (low.slice(0, p.surface.length) !== p.surface) continue;
      var rest = low.slice(p.surface.length);
      if (rest.length < MIN_FRAGMENT) continue;
      var body = parseBody(rest);
      if (!body) continue;
      // 前缀 + 裸词根要给足奖励，否则 observe 会被当成 ob+serv 之外的拆法
      var score = p.surface.length * 8 + body.score + (body.link ? 0 : 4);
      // 前缀吃掉词根首字母的拆法（ab + sorb）给一点补偿
      if (p.surface.length >= 2 && body.rootText.length >= 4 && !body.link) score += 1;
      candidates.push({ prefix: p, body: body, score: score });
    }

    // 前缀拆法优先（真实语言里前缀+词根更常见），但分差要够大才压过整词拆法
    candidates.sort(function (a, b) { return b.score - a.score; });
    var best = null;
    for (var c = 0; c < candidates.length; c++) {
      var cand = candidates[c];
      if (cand.prefix) { best = cand; break; }
      if (!best) best = cand;
    }

    if (best) {
      var parts = [];
      if (best.prefix) {
        parts.push({
          type: 'prefix', text: best.prefix.surface, gloss: best.prefix.m,
          note: best.prefix.o, ex: best.prefix.ex
        });
      }
      parts.push({
        type: 'root', text: best.body.rootText, gloss: best.body.gloss,
        note: best.body.note, key: best.body.rootKey, variant: best.body.rootText,
        ex: best.body.ex
      });
      if (best.body.link) parts.push({ type: 'base', text: best.body.link, gloss: '连接字母' });
      best.body.suffixes.forEach(function (s) {
        parts.push({ type: 'suffix', text: s.surface, gloss: s.m, note: s.pos, ex: s.ex });
      });

      if (parts.map(function (x) { return x.text; }).join('') === low) {
        return {
          parts: parts,
          rootKey: best.body.rootKey,
          hasRoot: true,
          confidence: best.prefix ? 0.9 : 0.85
        };
      }
    }

    /* ③ 前缀 + 词表已知词干 */
    if (vocabSet) {
      for (var pi = 0; pi < PREFIXES.length; pi++) {
        var pp = PREFIXES[pi];
        if (low.slice(0, pp.surface.length) !== pp.surface) continue;
        var rr = low.slice(pp.surface.length);
        if (rr.length < MIN_FRAGMENT) continue;
        var ps = stripSuffixes(rr);
        if (ps.rest.length >= MIN_FRAGMENT && vocabSet.has(ps.rest)) {
          var out = [
            { type: 'prefix', text: pp.surface, gloss: pp.m, note: pp.o, ex: pp.ex },
            { type: 'base', text: ps.rest, gloss: '词干' }
          ];
          ps.suffixes.forEach(function (s) { out.push({ type: 'suffix', text: s.surface, gloss: s.m, note: s.pos }); });
          if (out.map(function (x) { return x.text; }).join('') === low) {
            return { parts: out, rootKey: null, hasRoot: false, confidence: 0.7 };
          }
        }
      }

      /* ④ 词表已知词干 + 后缀 */
      var ps2 = stripSuffixes(low);
      if (ps2.suffixes.length && ps2.rest.length >= MIN_FRAGMENT && vocabSet.has(ps2.rest)) {
        var out2 = [{ type: 'base', text: ps2.rest, gloss: '词干' }];
        ps2.suffixes.forEach(function (s) { out2.push({ type: 'suffix', text: s.surface, gloss: s.m, note: s.pos }); });
        if (out2.map(function (x) { return x.text; }).join('') === low) {
          return { parts: out2, rootKey: null, hasRoot: false, confidence: 0.6 };
        }
      }

      /* ⑤ 合成词 */
      if (low.length >= 6) {
        for (var cut = 3; cut <= low.length - 3; cut++) {
          var a = low.slice(0, cut), b = low.slice(cut);
          if (vocabSet.has(a) && vocabSet.has(b)) {
            return {
              parts: [{ type: 'base', text: a, gloss: '词素' }, { type: 'base', text: b, gloss: '词素' }],
              rootKey: null, hasRoot: false, confidence: 0.55, compound: true
            };
          }
        }
      }
    }

    return baseResult(low);
  }

  var TYPE_LABEL = { prefix: '前缀', root: '词根', suffix: '后缀', base: '词干' };

  /* 拆解结果 → 一句中文串，如 "com（前缀·共同）+ prehens（词根·抓住）+ ion（名词后缀）" */
  function explain(result) {
    if (!result || !result.parts || result.parts.length < 3) return '';
    if (result.confidence < 0.55) return '';
    return result.parts.map(function (p) {
      var label = TYPE_LABEL[p.type] || '';
      return p.text + '（' + (p.gloss ? label + ' · ' + p.gloss : label) + '）';
    }).join(' + ');
  }

  /* 同根词索引：rootKey -> [word] */
  function buildFamilyIndex(words, getWord) {
    var index = {};
    words.forEach(function (item) {
      var w = typeof item === 'string' ? item : (getWord ? getWord(item) : item.w);
      var d = decompose(w);
      if (d.rootKey) (index[d.rootKey] = index[d.rootKey] || []).push(w);
    });
    return index;
  }

  global.KY_MORPH = {
    decompose: decompose,
    explain: explain,
    buildFamilyIndex: buildFamilyIndex,
    prefixes: PREFIXES,
    suffixes: SUFFIXES,
    roots: ROOTS,
    rootByKey: ROOT_MAP
  };
})(typeof window !== 'undefined' ? window : globalThis);
