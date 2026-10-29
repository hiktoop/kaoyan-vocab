#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
构建考研词库数据 data/words.js

数据来源（均为公开仓库）：
  - 词频排序、释义、例句、分类、CEFR 等级：
      github.com/exam-data/NETEMVocabulary  (CC BY-NC-SA 4.0)
  - 词根 / 词缀 / 助记解析（仅抽取「词根分析」「词缀分析」两节）：
      github.com/vxiaozhi/vocabulary-book-by-deepseek
  - 音标：
      github.com/KyleBing/english-vocabulary

用法：
  python3 scripts/build_words.py \
      --netem /path/netem_full_list.json \
      --roots /path/roots_raw.jsonl \
      --phonetic /path/考研.jsonl \
      --out data/words.js

产物结构：
  window.KY_WORDS = { meta: {...}, words: [ {...}, ... ] }
"""
import argparse
import json
import os
import re
import sys

SECT_ROOT = ['词根分析', '词根词缀分析', '词根与词缀']
SECT_AFFIX = ['词缀分析']
SECT_MEMO = ['记忆辅助', '记忆技巧', '小故事']
SECT_HISTORY = ['发展历史', '文化背景']

MAX_SECTION_LEN = 620


def section(text, names):
    """抽取 markdown 中标题包含 names 的章节正文。"""
    out, capture, level = [], False, 0
    for ln in text.split('\n'):
        m = re.match(r'^(#{2,5})\s*(.+?)\s*$', ln)
        if m:
            title = re.sub(r'[*#]', '', m.group(2)).strip()
            if capture and len(m.group(1)) <= level:
                capture = False
            if any(n in title for n in names) and not capture:
                capture, level, out = True, len(m.group(1)), []
                continue
        if capture:
            out.append(ln)
    return '\n'.join(out).strip()




def cut_repetition(t):
    """清理 AI 生成解析里常见的“复读机”故障。

    典型表现：一句话、一个短语或一个列表项被连续重复十几次，
    例如 sheet 的词缀解析末尾出现“特别之点特别之点…”。
    这里找到最早出现的长重复块，直接截断，保留前面正常的内容。
    """
    if not t:
        return t
    # 零宽字符、连续空格
    t = t.replace('\u200b', '').replace('\xa0', ' ')
    t = re.sub(r'[ \t]{3,}', '  ', t)

    cut = len(t)

    # 1) 短单元循环：2-16 个字符连续重复 4 次以上
    for p in range(2, 17):
        i = 0
        limit = len(t) - 3 * p
        while i <= limit:
            if t[i:i + p] == t[i + p:i + 2 * p] == t[i + 2 * p:i + 3 * p]:
                k = 3
                while i + (k + 1) * p <= len(t) and t[i + k * p:i + (k + 1) * p] == t[i:i + p]:
                    k += 1
                if k * p >= 16:
                    cut = min(cut, i)
                    break
            i += 1

    # 2) 整句 / 整块循环：按句号、分号、换行切分后比较相邻块
    parts = [x for x in re.split(r'(?<=[。！？；])', t) if x]
    offsets = []
    acc = 0
    for x in parts:
        offsets.append(acc)
        acc += len(x)
    for size in (1, 2, 3, 4):
        for i in range(0, len(parts) - 2 * size + 1):
            a = ''.join(parts[i:i + size])
            b = ''.join(parts[i + size:i + 2 * size])
            if len(a.strip()) >= 12 and a == b:
                cut = min(cut, offsets[i])

    if cut < len(t):
        t = t[:cut]
        t = re.sub(r'[，、；,;：:\-\s]+$', '', t).strip()
        if t and t[-1] not in '。！？…”）)':
            t += '……'
        if len(t) < 12:
            return ''
    return t


def clean(t, limit=MAX_SECTION_LEN):
    t = re.sub(r'\*\*|\*|`|###?', '', t)
    # 去掉列表符号与序号
    t = re.sub(r'^\s*(?:[-•●]|\d+[.、)]|\【[^】]*\】)\s*', '', t, flags=re.M)
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'\n{2,}', '\n', t)
    t = cut_repetition(t.strip())
    if not t:
        return ''

    # 「无明显词缀」的说明往往后面开始跑题，只保留前两句
    if re.match(r'^\s*无明显词缀', t):
        sent = re.split(r'(?<=[。！？])', t)
        t = ''.join(sent[:2]).strip()

    # AI 有时会输出一长串没有任何标点的近义词堆砌，在开头处截断
    run = re.search(r'[^。！？；，、,.!?;\n]{80,}', t)
    if run:
        t = t[:run.start()].rstrip('，、；,;：: -')
        if t and t[-1] not in '。！？…”）)':
            t += '……'
    if len(t) > limit:
        cut = t[:limit]
        # 在句号/换行处截断
        pos = max(cut.rfind('。'), cut.rfind('\n'))
        t = cut[:pos + 1] if pos > limit * 0.6 else cut + '……'
    return t


LOW_VALUE = re.compile(
    r'没有(明显|实际)?的词根|不包含词根|无词根|没有词缀|不包含词缀|'
    r'本身就是一个基础|是一个独立的(冠词|介词|连词|代词)|'
    r'不存在词根|不存在前缀|不涉及.*词缀|无明显的词根')


def useful(t):
    """过滤掉“该词没有词根”这类没有信息量的说明。"""
    return bool(t) and len(t) >= 8 and not LOW_VALUE.search(t)


def build(netem_path, roots_path, phonetic_path, out_path):
    data = json.load(open(netem_path, encoding='utf-8'))
    table = next(iter(data.values()))

    roots = {}
    if roots_path and os.path.exists(roots_path):
        for line in open(roots_path, encoding='utf-8'):
            try:
                d = json.loads(line)
            except Exception:
                continue
            roots[d.get('word', '').lower()] = d.get('analysis', '')
    else:
        print('[warn] 未找到词根数据，将只用规则库拆解', file=sys.stderr)

    phones = {}
    if phonetic_path and os.path.exists(phonetic_path):
        for line in open(phonetic_path, encoding='utf-8'):
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            hw = (d.get('headWord') or '').lower()
            ph = d.get('content', {}).get('word', {}).get('content', {}).get('usphone')
            if hw and ph:
                phones[hw] = ph.strip()

    # 智能重排序号（供「按学习优先级」排序，不影响以词频为主序）
    rerank = {}
    rk_path = netem_path.replace('netem_full_list.json', 'netem_reranked.json')
    if os.path.exists(rk_path):
        try:
            rk = json.load(open(rk_path, encoding='utf-8'))
            rows = rk.get('词汇表') or next((v for v in rk.values() if isinstance(v, list)), [])
            for row in rows:
                rerank[row['单词'].lower()] = row.get('序号')
        except Exception as e:
            print('[warn] 读取重排表失败:', e, file=sys.stderr)

    words, seen = [], set()
    for row in table:
        w = (row.get('单词') or '').strip()
        key = w.lower()
        if not w or key in seen:
            continue
        seen.add(key)
        analysis = roots.get(key, '')
        item = {
            'w': w,
            'f': row.get('词频') or 0,
            't': row.get('释义') or '',
            'cat': row.get('分类名称') or '',
            'cefr': row.get('CEFR等级') or '',
            'acad': bool(row.get('学术词汇')),
            'adv': bool(row.get('高级词汇')),
            'ex': row.get('例句') or '',
            'exz': row.get('例句翻译') or '',
            'exs': row.get('例句来源') or '',
            'z': row.get('真题次数') or 0,
            'alt': row.get('其他拼写') or '',
            'ph': phones.get(key, ''),
            'rk': rerank.get(key) or 99999,
        }
        if analysis:
            r = clean(section(analysis, SECT_ROOT))
            a = clean(section(analysis, SECT_AFFIX))
            mem = clean(section(analysis, SECT_MEMO), 300)
            hist = clean(section(analysis, SECT_HISTORY), 400)
            if useful(r):
                item['rt'] = r
            if useful(a):
                item['af'] = a
            if useful(mem) and len(mem) >= 12:
                item['mem'] = mem
            if hist:
                item['hist'] = hist
        words.append(item)

    # 按词频降序即原顺序，这里保持原顺序并补充 id
    for i, w in enumerate(words):
        w['id'] = i

    meta = {
        'title': '考研英语词汇 · 词频智能排序',
        'count': len(words),
        'withRoots': sum(1 for w in words if w.get('rt')),
        'withAffix': sum(1 for w in words if w.get('af')),
        'withPhonetic': sum(1 for w in words if w.get('ph')),
        'highFreq': sum(1 for w in words if w['f'] >= 40),
        'sources': [
            {'name': 'NETEMVocabulary', 'url': 'https://github.com/exam-data/NETEMVocabulary',
             'used': '词表、词频排序、释义、例句、语义分类、CEFR 等级', 'license': 'CC BY-NC-SA 4.0'},
            {'name': 'vocabulary-book-by-deepseek', 'url': 'https://github.com/vxiaozhi/vocabulary-book-by-deepseek',
             'used': '词根 / 词缀 / 助记解析', 'license': '见原仓库'},
            {'name': 'english-vocabulary', 'url': 'https://github.com/KyleBing/english-vocabulary',
             'used': '美式音标', 'license': '见原仓库'},
        ],
        'builtAt': __import__('datetime').date.today().isoformat(),
    }

    os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('/* 自动生成，请勿手改；来源见文件头部注释 */\n')
        f.write('window.KY_WORDS=' + json.dumps({'meta': meta, 'words': words},
                                               ensure_ascii=False, separators=(',', ':')) + ';\n')

    size = os.path.getsize(out_path) / 1024 / 1024
    print('写入 %s: %d 词, %.2f MB, 词根解析 %d, 音标 %d'
          % (out_path, len(words), size, meta['withRoots'], meta['withPhonetic']))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--netem', required=True)
    ap.add_argument('--roots', default='')
    ap.add_argument('--phonetic', default='')
    ap.add_argument('--out', default='data/words.js')
    a = ap.parse_args()
    build(a.netem, a.roots, a.phonetic, a.out)
