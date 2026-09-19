# -*- coding: utf-8 -*-
"""把数据注入模板，产出单文件离线 HTML。
同时写出两个文件名（品牌名 税码通.html + 别名 我的税则本2026.html），保证打开任意一个都有效。

数据来源（均为独立文件，便于维护 / 迁移 / 审核）：
  data/app_data.json        —— 主数据（税则/危化品/章节/手册/原有归类先例 等）
  data/alias_folk.json      —— 民间叫法 / 俗语 → 规范名 + HS章节（搜索扩展用）
  data/cls_decisions.json   —— 海关总署归类决定（来自 official/ 下 8 个文件，构建权威源）
若任一必需数据文件缺失，直接报错退出，避免"静默丢数据"导致网站内容缺失。
"""
import io, os, sys, json
B = os.path.dirname(os.path.abspath(__file__))
R = os.path.dirname(B)

def need(path, what):
    if not os.path.exists(path):
        sys.stderr.write('[FATAL] 缺少必需数据文件：%s （%s）\n' % (path, what))
        sys.exit(2)
    return path

tpl_path = B + '/template.html'
data_path = need(R + '/data/app_data.json', '主数据')
folk_path = need(R + '/data/alias_folk.json', '民间叫法/俗语')
cls_path  = need(R + '/data/cls_decisions.json', '海关总署归类决定')

tpl = io.open(tpl_path, encoding='utf-8').read()
data = json.load(io.open(data_path, encoding='utf-8'))

# ---------- 1) 合并 民间叫法 / 俗语 ----------
# 规则：每个俗称/方言必须精确对应到具体商品编码，不能再按"章"粗分。
# 例如：土豆/洋芋/山药蛋 只能落在所有"马铃薯"条目上，不能出现在洋葱、番茄上。
folk = json.load(io.open(folk_path, encoding='utf-8')).get('folk', [])
af = data.setdefault('aliasFwd', {})
ac = data.setdefault('aliasCode', {})
ag = data.setdefault('aliasGroups', [])
item_alias = {}   # code -> set(俗称)
alias_item = {}   # 俗称 -> set(code)
hint_item = {}    # 俗称(近似/偏差) -> set(code)
item_hint = {}    # code -> set(俗称)
added = 0
hint_added = 0
for e in folk:
    a, n, c = e.get('a'), e.get('n'), e.get('c')
    soft = e.get('soft')
    if not a or not n:
        continue
    # 1) 用显式 codes 最精确
    codes = set()
    if e.get('codes'):
        for cd in e['codes']:
            codes.add(str(cd).replace('.', ''))
    # 2) 否则按规范名匹配，优先只匹配 item 自身书名/原品名（最精确）。
    #    若自身名没有，再 fallback 到完整路径（如 07011000 马铃薯种用）。
    if not codes and n:
        ch = c.replace('.', '')[:2] if c else ''
        for it in data.get('items', []):
            ic = it.get('c', '')
            if ch and not ic.startswith(ch):
                continue
            self_name = (it.get('b', '') or '') + '|' + (it.get('n', '') or '')
            if n in self_name:
                codes.add(ic)
        if not codes:
            for it in data.get('items', []):
                ic = it.get('c', '')
                if ch and not ic.startswith(ch):
                    continue
                full = (it.get('b', '') or '') + '|' + (it.get('n', '') or '') + '|' + ''.join(it.get('p', []))
                if n in full:
                    codes.add(ic)
    # 3) 仍无命中且给出了足够具体的编码前缀，fallback 到前缀匹配
    if not codes and c and len(c.replace('.', '')) >= 4:
        prefix = c.replace('.', '')
        for it in data.get('items', []):
            if it.get('c', '').startswith(prefix):
                codes.add(it['c'])
    if codes:
        # 校正 AF/AC：仅保留规范名作为扩展词，归类建议取首个命中的 4 位税目
        af[a] = [n]
        first_code = sorted(codes)[0]
        ac[a] = first_code[:4]
        if soft:
            # 近似/偏差叫法：只做"可能指"提示，不硬锁、不污染精确结果
            hint_item[a] = sorted(codes)
            for code in codes:
                item_hint.setdefault(code, set()).add(a)
            hint_added += 1
        else:
            alias_item[a] = sorted(codes)
            for code in codes:
                item_alias.setdefault(code, set()).add(a)
            added += 1
    # 简单同义词组仍保留，供模板兜底，但模板优先使用 item_alias
    found = False
    for g in ag:
        if a in g or n in g:
            found = True; break
    if not found:
        ag.append([a, n])
# 写入商品级精确别名 + 近似提示
data['itemAlias'] = {k: sorted(v) for k, v in item_alias.items()}
data['aliasItem'] = alias_item
data['itemHint'] = {k: sorted(v) for k, v in item_hint.items()}
data['aliasHint'] = hint_item
print('合并民间叫法：精确映射 %d 条，近似提示 %d 条（共 %d 条别名→规范名），涉及 %d 个商品编码' % (added, hint_added, len(af), len(item_alias)))

# ---------- 2) 合并 海关总署归类决定（权威源）----------
cls = json.load(io.open(cls_path, encoding='utf-8'))
cls_set = set(c['dec'] for c in cls)
# 先移除旧的 cls 来源条目（precedent 中 dec 命中、或 hc 中 src=='cls'），再由本文件重排，保证幂等
data['precedent'] = [p for p in data['precedent'] if p.get('dec') not in cls_set]
data['hc'] = [h for h in data['hc'] if h.get('src') != 'cls']
# 写回 precedent
for c in cls:
    data['precedent'].append({
        'no': c.get('no', ''), 'dec': c['dec'], 'code': c['code'], 'name': c['name'],
        'spec': c.get('spec', ''), 'desc': c.get('desc', ''), 'decision': c.get('decision', ''),
        'doc': c.get('doc', ''), 'year': c.get('year', ''), 'kind': c.get('kind', '决定'), 'src': 'cls'
    })
# 写回 hc（危化品栏"归类决定（海关）"子标签展示用）
for i, c in enumerate(cls):
    data['hc'].append({
        'idx': 9000 + i, 'name': c['name'], 'alias': c['dec'], 'cas': '',
        'note': '归类决定 · ' + c.get('doc', ''), 'src': 'cls', 'hs': c['code'], 'sl': ''
    })
print('合并归类决定：%d 条（precedent 现 %d 条，hc 现 %d 条）' % (len(cls), len(data['precedent']), len(data['hc'])))

# ---------- 2.5) 合并本地申报数据（本地可编辑数据源 · 一等输入）----------
# 这 4 个文件就是网站的「本地数据」：可直接用记事本/Excel 编辑，
# 也可以用 本地数据/local_data.py 导出成 CSV 改完再回写。
# 改完重跑本脚本即生效；文件缺失立刻报错，避免静默丢数据。
LOCAL_DECL = [
    ('declReal', R + '/data/decl_real.json',      '申报要素字段名（8位码 → [要素名]）'),
    ('declExam', R + '/data/decl_exam.json',      '申报要素真实示例值（与 declReal 顺序一一对应）'),
    ('declDec',  R + '/data/decl_decisions.json', '海关预归类真实申报实例'),
    ('declReg',  R + '/data/decl_reg.json',       '监管条件 / 检验检疫 / 随附单证'),
]
for _key, _path, _what in LOCAL_DECL:
    _p = need(_path, _what)
    _obj = json.load(io.open(_p, encoding='utf-8'))
    if not isinstance(_obj, dict):
        sys.stderr.write('[FATAL] %s 结构异常：应为「编码 → 值」的对象\n' % _p)
        sys.exit(3)
    data[_key] = _obj
    print('合并本地数据 %-9s %6d 条  <- %s' % (_key, len(_obj), os.path.basename(_p)))

# ---------- 2.9) 数据洞察：构建期自动搜集 ----------
# 把「首页 · 数据洞察」要展示的真实统计（库内真实底数 + 真实访问热门）自动算出来注入，
# 替代原先写死在模板里的演示数据。搜集逻辑见 build/collect_insights.py。
# 幂等：统计内容不变时沿用旧时间戳，保证重复构建产物逐字节一致（构建可复现）。
try:
    if B not in sys.path:
        sys.path.insert(0, B)
    import collect_insights as _ci
    data['insight'] = _ci.collect(data)
    _ins = data['insight']
    print('数据洞察自动搜集：底数 %d 项、热门 %d 条（来源 %s，截止 %s）'
          % (len(_ins['stats']), len(_ins['hot']), _ins['src'], _ins['asof']))
except Exception as _e:
    sys.stderr.write('[WARN] 数据洞察自动搜集失败（不阻断构建）：%r\n' % (_e,))
    data.setdefault('insight', {'v': '2026', 'asof': '', 'src': '', 'db': '', 'stats': [], 'hot': []})

# ---------- 注入 ----------
# 紧凑序列化：去掉分隔符空格，原始体积省约 0.8MB
data_str = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
data_str = data_str.replace('</', '<\\/')   # 防止 </script> 提前闭合

# 离线版：数据内联，单文件可直接双击打开
out_inline = tpl.replace('/*__DATA__*/', data_str)
io.open(R + '/税码通.html', 'w', encoding='utf-8').write(out_inline)
print('生成(离线内联):', R + '/税码通.html', '%.2f MB' % (os.path.getsize(R + '/税码通.html') / 1024 / 1024))

# 线上版：数据外置为 data.js —— HTML 与数据分别缓存、可并行下载；
# 以后只改税则/别名数据，重跑本脚本后只需重传 site/data.js（浏览器按文件名缓存，老用户秒开）
site_dir = R + '/site'
if not os.path.isdir(site_dir):
    os.makedirs(site_dir)
# __JSON_PARSE_LOAD_V2__ 解析优化：用 JSON.parse 装载而非对象字面量。
# V8 实测（每轮加唯一前缀强制重编译、取 5 轮中位）：
#   对象字面量 window.DB={...}      17.85MB / gzip 2.18MB / 解析 495ms
#   JSON.parse("…") 双引号包裹      19.28MB / gzip 2.23MB / 解析 342ms   ← 体积反而涨 1.4MB
#   JSON.parse('…') 单引号包裹      17.86MB / gzip 2.19MB / 解析 347ms   ← 采用：体积与解析双优
# 双引号包裹必须转义每一个 "，所以体积膨胀；单引号只需转义 \ 和 '。
# 注意：务必关掉 eval 编译缓存再测（同一源码串会被 V8 缓存，测出的只是执行耗时）。
_js_literal = "'" + data_str.replace("\\", "\\\\").replace("'", "\\'") + "'"
# U+2028 / U+2029 在旧解析器里被当作换行，显式转义以策万全
_js_literal = _js_literal.replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
io.open(site_dir + '/data.js', 'w', encoding='utf-8').write(
    'window.DB=JSON.parse(' + _js_literal + ');')
out_site = tpl.replace(
    '<script id="DATA" type="application/json">/*__DATA__*/</script>',
    '<script src="./data.js"></script>')
io.open(site_dir + '/index.html', 'w', encoding='utf-8').write(out_site)
print('生成(线上外置):', site_dir + '/index.html', '%.2f MB' % (os.path.getsize(site_dir + '/index.html') / 1024 / 1024))
print('数据外置:', site_dir + '/data.js', '%.2f MB' % (os.path.getsize(site_dir + '/data.js') / 1024 / 1024))
