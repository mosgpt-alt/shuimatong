# -*- coding: utf-8 -*-
"""数据洞察自动搜集器（构建期）

职责：把「首页 · 数据洞察」这一块要展示的东西，全部自动算出来，
      不依赖任何人工填写的演示数据。产物随每次构建自动刷新。

自动搜集两类真实数据：
  A) 真实点击热门 —— 从本机后端 SQLite 的 popular 表读（每次打开税号详情都会 +1）
                    读取只读模式，绝不写库、绝不动用户数据。
  B) 库内真实底数 —— 从 data/ 下的每个真实数据文件自动 count，
                    合并顺序与 bundle.py 完全一致，保证数字与线上页面一致。

幂等性：只有「统计内容」真的变了才刷新 asof（日期戳）；
        内容不变则沿用旧戳，保证重复构建产物逐字节一致（构建可复现）。

用法：
  独立跑：  python build/collect_insights.py            # 写 data/insights.json 供人工查看
  被调用：  bundle.py 在合并完 data 之后 import 本模块，调 collect(data) 拿结果注入。
"""
import io, os, re, sys, json, glob, sqlite3, datetime

B = os.path.dirname(os.path.abspath(__file__))
R = os.path.dirname(B)

# ---------- 真实点击来源：候选数据库路径（按优先级）----------
DB_CANDIDATES = [
    R + '/server/data/zhiguantong.db',
    R + '/../税码通编码网站/server/data/zhiguantong.db',
    R + '/../税码通编码网站_发布/server/data/zhiguantong.db',
    r'G:/税码通编码网站/server/data/zhiguantong.db',
    r'F:/工作空间/hs-declare2026/server/data/zhiguantong.db',
]


def _find_db():
    for p in DB_CANDIDATES:
        p = os.path.abspath(p)
        if os.path.exists(p):
            return p
    hits = []
    for base in (R, os.path.dirname(R)):
        hits += glob.glob(base + '/**/zhiguantong.db', recursive=True)
    return hits[0] if hits else None


def read_popular(limit=16):
    """读本机后端真实点击热门（只读打开，失败返回空列表）。"""
    p = _find_db()
    if not p:
        return [], None
    try:
        con = sqlite3.connect('file:%s?mode=ro' % p.replace('\\', '/'), uri=True)
        rows = con.execute(
            'SELECT hs_code, views FROM popular ORDER BY views DESC, updated_at DESC LIMIT ?',
            (limit,)).fetchall()
        con.close()
        return [{'c': str(c), 'v': int(v)} for c, v in rows], p
    except Exception:
        return [], p


def _load(name):
    p = R + '/data/' + name
    if not os.path.exists(p):
        return None
    try:
        return json.load(io.open(p, encoding='utf-8'))
    except Exception:
        return None


def _n(x):
    return len(x) if x else 0


def fmt(v):
    """千分位；非数字原样返回"""
    try:
        return '{:,}'.format(int(v))
    except Exception:
        return v


def short_name(s, limit=14):
    """把冗长的规范书名压成 chip 上放得下的短名（完整名另存 f 字段给 tooltip）。
    例：'盛装物料用的钢铁囤、柜、罐、桶及类似容器（装压缩气体或液化气体的除外），容积超过300升'
        -> '盛装物料用的钢铁囤'
    """
    s = (s or '').strip()
    orig = s
    s2 = re.sub(r'[（(][^（()）]*[)）]', '', s).strip()
    for sep in ('、', '，', ',', '；', ';', '/', ' '):
        i = s2.find(sep)
        if i >= 6:          # 至少 6 字才截，避免「活、鲜或冷的」被截成「活」
            s2 = s2[:i]
            break
    s2 = s2.strip(' 、，,；;/')
    if len(s2) > limit:
        s2 = s2[:limit] + '…'
    return s2 or orig[:limit]


def collect(data=None):
    """自动搜集。data 可传 bundle.py 合并后的 dict（数字最准），也可自行加载。"""
    # ---- 合并后的 data 优先；独立跑时读原始文件 ----
    if data is None:
        data = _load('app_data.json') or {}
        folk = _load('alias_folk.json') or {}
        cls = _load('cls_decisions.json') or []
        data.setdefault('declReal', _load('decl_real.json') or {})
        data.setdefault('declExam', _load('decl_exam.json') or {})
        data.setdefault('declDec', _load('decl_decisions.json') or {})
        data.setdefault('declReg', _load('decl_reg.json') or {})
        data['_clsN'] = _n(cls)
        data['_folkN'] = _n(folk.get('folk') if isinstance(folk, dict) else folk)
    else:
        cls = _load('cls_decisions.json') or []
        folk = _load('alias_folk.json') or {}
        data['_clsN'] = _n(cls)
        data['_folkN'] = _n(folk.get('folk') if isinstance(folk, dict) else folk)

    items = data.get('items') or []
    hc = data.get('hc') or []
    hc_chem = [h for h in hc if h.get('src') != 'cls']     # 危化品目录（剔除归类决定）

    stats = [
        {'k': '税目', 'v': fmt(_n(items)), 's': '条'},
        {'k': '章 · 类', 'v': '%d · %d' % (_n(data.get('chapters')), _n(data.get('sections'))), 's': ''},
        {'k': '带申报五要素', 'v': fmt(_n(data.get('declReal'))), 's': '个税号'},
        {'k': '真实填报实例', 'v': fmt(_n(data.get('declExam'))), 's': '条'},
        {'k': '预归类案例', 'v': fmt(_n(data.get('declDec'))), 's': '条'},
        {'k': '监管条件', 'v': fmt(_n(data.get('declReg'))), 's': '个税号'},
        {'k': '归类先例 · 决定', 'v': '%d · %d' % (_n(data.get('precedent')), data.get('_clsN', 0)), 's': ''},
        {'k': '危险化学品', 'v': fmt(_n(hc_chem)), 's': '项'},
        {'k': '民间叫法', 'v': fmt(data.get('_folkN', 0)), 's': '条'},
        {'k': '别名映射', 'v': fmt(_n(data.get('itemAlias'))), 's': '个税号'},
    ]

    # ---- 真实热门：点击统计 → 补真实预归类案例税号做兜底（都是真实存在的税号）----
    hot, db_path = read_popular()
    name_of = {}
    for it in items:
        # 注意：原始 app_data.json 里没有 bn 字段（bn 是前端运行时 it.b || it.n 拼出来的），
        # 早期版本只认 bn 会取到 None -> 热门全部被过滤掉，务必用 b 兜 n。
        nm = it.get('b') or it.get('n') or ''
        name_of[str(it.get('c', ''))] = nm

    def _entry(code, views):
        full = name_of.get(code, '')
        return {'c': code, 'n': short_name(full), 'f': full, 'v': views}

    hot = [_entry(h['c'], h['v']) for h in hot if name_of.get(h['c'])]
    src = 'popular-db' if hot else 'library'

    if len(hot) < 12:
        have = set(h['c'] for h in hot)
        pool = sorted((data.get('declDec') or {}).keys())
        for c in pool:
            c8 = str(c).replace('.', '')
            if len(c8) == 8 and c8 not in have and name_of.get(c8):
                hot.append(_entry(c8, 0))
                have.add(c8)
            if len(hot) >= 12:
                break

    out = {
        'v': '2026',
        'src': src,
        'db': os.path.basename(db_path) if db_path else '',
        'stats': stats,
        'hot': hot[:12],
    }

    # ---- 幂等：内容没变就沿用旧 asof ----
    old = _load('insights.json') or {}
    core_old = dict((k, v) for k, v in old.items() if k != 'asof')
    core_new = dict(out)
    same = json.dumps(core_old, ensure_ascii=False, sort_keys=True) == \
           json.dumps(core_new, ensure_ascii=False, sort_keys=True)
    if same and old.get('asof'):
        out['asof'] = old['asof']
    else:
        out['asof'] = datetime.date.today().isoformat()
    return out


def main():
    ins = collect()
    p = R + '/data/insights.json'
    io.open(p, 'w', encoding='utf-8').write(
        json.dumps(ins, ensure_ascii=False, indent=1))
    print('数据洞察已自动搜集 -> %s' % p)
    print('  时间戳 asof = %s   热门来源 = %s (%s)' % (ins['asof'], ins['src'], ins['db'] or '-'))
    print('  真实底数：' + ' | '.join('%s %s%s' % (s['k'], s['v'], s['s']) for s in ins['stats'][:6]))
    print('  热门税号：' + ' | '.join('%s %s%s' % (h['c'], h['n'][:10], ('×%d' % h['v']) if h['v'] else '') for h in ins['hot'][:6]))


if __name__ == '__main__':
    main()
