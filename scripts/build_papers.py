#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
构建考研英语（二）真题数据 data/papers.js

数据来源：
  github.com/houxinjin774/English2
  （papers/*.json 与 papers/extra-papers.js；原站为懒笔记考研英语真题站）

输出：
  window.KY_PAPERS = { meta: {...}, papers: [...] }
"""
import argparse
import json
import os
import re
import sys

TYPE_MAP = {
    '阅读理解': 'reading',
    '完形填空': 'cloze',
    '新题型': 'newtype',
}


def load_extra(path):
    text = open(path, encoding='utf-8').read()
    m = re.search(r'=\s*(\[.*\])\s*;?\s*$', text, re.S)
    if not m:
        raise ValueError('无法解析 extra-papers.js')
    return json.loads(m.group(1))


def year_of(title):
    m = re.search(r'(20\d{2})', title or '')
    return int(m.group(1)) if m else 0


def norm_item(item, source='extra'):
    typ = item.get('type')
    if typ not in TYPE_MAP:
        return None
    out = {
        'id': item.get('id'),
        'year': year_of(item.get('title')),
        'set': '英语二',
        'type': TYPE_MAP[typ],
        'title': item.get('title') or '',
        'intro': item.get('intro') or '',
        'passage': item.get('passage') or '',
        'passageZh': item.get('passage_zh') or '',
        'minutes': item.get('minutes') or 0,
        'score': item.get('score') or 0,
        'source': source,
        'questions': [],
    }

    if typ == '阅读理解':
        for q in item.get('questions') or []:
            opts = q.get('opts') or []
            if not opts or q.get('ans') is None:
                continue
            out['questions'].append({
                'q': q.get('q') or '',
                'opts': opts,
                'ans': int(q.get('ans')),
                'explain': q.get('explain') or '',
            })
    elif typ == '完形填空':
        for i, b in enumerate(item.get('blanks') or []):
            opts = b.get('opts') or []
            if not opts or b.get('ans') is None:
                continue
            out['questions'].append({
                'q': '第 %d 空' % (i + 1),
                'opts': opts,
                'ans': int(b.get('ans')),
                'explain': b.get('explain') or '',
            })
    else:  # 新题型
        titles = item.get('titles') or []
        for p in item.get('paras') or []:
            if not titles or p.get('ans') is None:
                continue
            out['questions'].append({
                'q': p.get('text') or '',
                'opts': titles,
                'ans': int(p.get('ans')),
                'explain': p.get('explain') or '',
            })

    if not out['questions']:
        return None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='English2 仓库根目录')
    ap.add_argument('--out', default='data/papers.js')
    a = ap.parse_args()

    base = a.src
    items = []
    extra = os.path.join(base, 'papers', 'extra-papers.js')
    if os.path.exists(extra):
        items += load_extra(extra)

    for name in ['2024-reading.json', '2024-other.json',
                 '2025-reading.json', '2025-other.json']:
        p = os.path.join(base, 'papers', name)
        if os.path.exists(p):
            items += json.load(open(p, encoding='utf-8'))

    papers, seen = [], set()
    by_key = set()
    for it in items:
        n = norm_item(it)
        if not n:
            continue
        key = (n['year'], n['type'], re.sub(r'\s+', '', n['title']))
        if n['id'] in seen or key in by_key:
            continue
        seen.add(n['id'])
        by_key.add(key)
        papers.append(n)

    papers.sort(key=lambda p: (-p['year'], p['type'], p['title']))
    for p in papers:
        for i, q in enumerate(p['questions']):
            q['n'] = i + 1

    total_q = sum(len(p['questions']) for p in papers)
    years = sorted(set(p['year'] for p in papers), reverse=True)
    meta = {
        'title': '考研英语（二）历年真题',
        'count': len(papers),
        'questions': total_q,
        'years': years,
        'byType': {
            'reading': sum(1 for p in papers if p['type'] == 'reading'),
            'cloze': sum(1 for p in papers if p['type'] == 'cloze'),
            'newtype': sum(1 for p in papers if p['type'] == 'newtype'),
        },
        'source': {
            'name': 'houxinjin774/English2',
            'url': 'https://github.com/houxinjin774/English2',
            'origin': '懒笔记考研英语真题站',
            'note': '答案与解析由原仓库整理，仅供参考',
        },
        'builtAt': __import__('datetime').date.today().isoformat(),
    }

    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as f:
        f.write('/* 自动生成，请勿手改；来源见 meta.source */\n')
        f.write('window.KY_PAPERS=' + json.dumps({'meta': meta, 'papers': papers},
                                                ensure_ascii=False, separators=(',', ':')) + ';\n')
    print('写入 %s: %d 套, %d 题, %.2f MB' % (
        a.out, len(papers), total_q, os.path.getsize(a.out) / 1024 / 1024))


if __name__ == '__main__':
    main()
