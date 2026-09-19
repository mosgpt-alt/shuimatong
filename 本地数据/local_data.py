# -*- coding: utf-8 -*-
"""税码通 · 本地数据维护工具

网站用到的「真实实例」数据全部以本地文件存在 data/ 下，本工具负责在
【JSON 数据文件】和【可用 Excel / WPS 直接编辑的 CSV】之间双向同步。

用法（在本目录双击对应 .bat 即可，无需记命令）：

    python local_data.py export   导出：data/*.json  -> 本地数据/*.csv
    python local_data.py import   回写：本地数据/*.csv -> data/*.json（写前自动备份）
    python local_data.py check    体检：核对 CSV / JSON 一致性，只读不改
    python local_data.py build    重建站点：调用 build/bundle.py 重新生成
                                  税码通.html + site/index.html + site/data.js

典型流程：改 CSV → 回写 → 重建站点。
"""
import io, os, sys, json, csv, shutil, time, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")

JSON_FILES = {
    "declReal": os.path.join(DATA, "decl_real.json"),       # 编码 -> [要素名]
    "declExam": os.path.join(DATA, "decl_exam.json"),       # 编码 -> [真实示例值]（与 declReal 同序）
    "declDec":  os.path.join(DATA, "decl_decisions.json"),  # 编码 -> [预归类实例]
    "declReg":  os.path.join(DATA, "decl_reg.json"),        # 编码 -> {s,i,u,r,d}
}
CSV_EXAM = os.path.join(HERE, "申报要素示例.csv")
CSV_DEC  = os.path.join(HERE, "预归类实例.csv")
CSV_REG  = os.path.join(HERE, "监管检疫单证.csv")
CSV_DOC  = os.path.join(HERE, "随附单证.csv")

STAMP = time.strftime("%Y%m%d%H%M%S")


# ------------------------------------------------------------------ 基础读写
def read_json(path):
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    """写前备份，保持「一码一行块」的可读缩进，字段名排序，便于人工 diff / 编辑。"""
    if os.path.exists(path):
        shutil.copy2(path, path + ".bak_" + STAMP)
    text = json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=True)
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return len(text)


def open_csv_w(path):
    # utf-8-sig：Excel / WPS 双击就能正确识别中文
    return io.open(path, "w", encoding="utf-8-sig", newline="")


def open_csv_r(path):
    return io.open(path, encoding="utf-8-sig", newline="")


def item_names():
    """编码 -> 品名（仅用于 CSV 里给人看，回写时会忽略该列）"""
    p = os.path.join(DATA, "app_data.json")
    names = {}
    if not os.path.exists(p):
        return names
    try:
        d = read_json(p)
        for it in d.get("items", []):
            c = str(it.get("c", ""))
            if c:
                names[c] = (it.get("bn") or it.get("n") or "").strip()
    except Exception:
        pass
    return names


def bar(msg):
    print(msg)
    sys.stdout.flush()


# ------------------------------------------------------------------ 导出
def do_export():
    need = [k for k, v in JSON_FILES.items() if not os.path.exists(v)]
    if need:
        print("[错误] 缺少数据文件：%s" % ", ".join(need))
        return 2
    rl = read_json(JSON_FILES["declReal"])
    ex = read_json(JSON_FILES["declExam"])
    dc = read_json(JSON_FILES["declDec"])
    rg = read_json(JSON_FILES["declReg"])
    names = item_names()
    bar("导出中… 品名表 %d 条" % len(names))

    # 1) 申报要素示例
    n = 0
    with open_csv_w(CSV_EXAM) as f:
        w = csv.writer(f)
        w.writerow(["商品编码", "品名", "序号", "要素名", "真实示例值", "在目录要素内"])
        for code in sorted(ex.keys()):
            elems = rl.get(code) or []
            for i, v in enumerate(ex[code] or [], 1):
                e = elems[i - 1] if i - 1 < len(elems) else ""
                w.writerow([code, names.get(code, ""), i, e, v, "是" if e else "否"])
                n += 1
    bar("  %-22s %6d 行" % ("申报要素示例.csv", n))

    # 2) 预归类实例
    n = 0
    with open_csv_w(CSV_DEC) as f:
        w = csv.writer(f)
        w.writerow(["商品编码", "品名", "决定编号", "商品名称", "英文名", "规格", "关区", "商品描述"])
        for code in sorted(dc.keys()):
            for c in dc[code]:
                w.writerow([code, names.get(code, ""), c.get("no", ""), c.get("n", ""),
                            c.get("e", ""), c.get("s", ""), c.get("cu", ""), c.get("d", "")])
                n += 1
    bar("  %-22s %6d 行" % ("预归类实例.csv", n))

    # 3) 监管检疫
    n = 0
    with open_csv_w(CSV_REG) as f:
        w = csv.writer(f)
        w.writerow(["商品编码", "品名", "监管条件", "检验检疫类别", "法定单位", "政策依据"])
        for code in sorted(rg.keys()):
            v = rg[code]
            w.writerow([code, names.get(code, ""), v.get("s", ""), v.get("i", ""),
                        v.get("u", ""), v.get("r", "")])
            n += 1
    bar("  %-22s %6d 行" % ("监管检疫单证.csv", n))

    # 4) 随附单证
    n = 0
    with open_csv_w(CSV_DOC) as f:
        w = csv.writer(f)
        w.writerow(["商品编码", "单证编号", "单证名称"])
        for code in sorted(rg.keys()):
            for x in (rg[code].get("d") or []):
                w.writerow([code, x.get("no", ""), x.get("name", "")])
                n += 1
    bar("  %-22s %6d 行" % ("随附单证.csv", n))

    bar("\n导出完成，CSV 在：%s" % HERE)
    return 0


# ------------------------------------------------------------------ 回写
def do_import():
    if not os.path.exists(CSV_EXAM):
        print("[错误] 找不到 CSV，请先执行 export")
        return 2
    rl = read_json(JSON_FILES["declReal"]) if os.path.exists(JSON_FILES["declReal"]) else {}
    warn = []

    # ---- 申报要素示例 ----
    ex, bad = {}, 0
    with open_csv_r(CSV_EXAM) as f:
        r = csv.DictReader(f)
        for row in r:
            code = (row.get("商品编码") or "").strip()
            if not code:
                continue
            try:
                idx = int((row.get("序号") or "0").strip() or 0)
            except ValueError:
                bad += 1
                continue
            val = row.get("真实示例值") or ""          # 值逐字保留，不裁空白
            elems = rl.get(code) or []
            if idx < 1:
                bad += 1
                continue
            if idx > len(elems):
                warn.append("%s 序号 %d 超出目录要素数 %d，已忽略" % (code, idx, len(elems)))
                continue
            declared = (row.get("要素名") or "").strip()
            if declared and declared != elems[idx - 1]:
                warn.append("%s 第%d项 要素名「%s」与目录「%s」不一致，按位置保留值" %
                            (code, idx, declared, elems[idx - 1]))
            lst = ex.setdefault(code, [""] * len(elems))
            lst[idx - 1] = val
    ex = {c: v for c, v in ex.items() if any(x.strip() for x in v)}
    bar("申报要素示例.csv -> declExam  %6d 码 / %d 行" % (len(ex), sum(1 for _ in open(CSV_EXAM, encoding="utf-8-sig")) - 1))

    # ---- 预归类实例 ----
    dc = {}
    with open_csv_r(CSV_DEC) as f:
        for row in csv.DictReader(f):
            code = (row.get("商品编码") or "").strip()
            if not code:
                continue
            dc.setdefault(code, []).append({
                # 各字段逐字保留（原数据里有带尾空格的编号，不能裁）
                "no": row.get("决定编号") or "",
                "n": row.get("商品名称") or "",
                "e": row.get("英文名") or "",
                "s": row.get("规格") or "",
                "cu": row.get("关区") or "",
                "d": row.get("商品描述") or "",
            })
    bar("预归类实例.csv   -> declDec    %6d 码 / %d 例" % (len(dc), sum(len(v) for v in dc.values())))

    # ---- 监管检疫 + 随附单证 ----
    rg = {}
    with open_csv_r(CSV_REG) as f:
        for row in csv.DictReader(f):
            code = (row.get("商品编码") or "").strip()
            if not code:
                continue
            rg[code] = {
                # 各字段逐字保留（原数据里有带尾空格的编号，不能裁）
                "s": row.get("监管条件") or "",
                "i": row.get("检验检疫类别") or "",
                "u": row.get("法定单位") or "",
                "r": row.get("政策依据") or "",
                "d": [],
            }
    if os.path.exists(CSV_DOC):
        with open_csv_r(CSV_DOC) as f:
            for row in csv.DictReader(f):
                code = (row.get("商品编码") or "").strip()
                if not code:
                    continue
                rg.setdefault(code, {"s": "", "i": "", "u": "", "r": "", "d": []})
                rg[code]["d"].append({"no": row.get("单证编号") or "",
                                      "name": row.get("单证名称") or ""})
    rg = {c: v for c, v in rg.items() if any([v["s"], v["i"], v["u"], v["r"], v["d"]])}
    bar("监管检疫单证.csv -> declReg  %6d 码 / %d 单证" % (len(rg), sum(len(v["d"]) for v in rg.values())))

    # ---- 写回 ----
    bar("\n写回 JSON（旧文件自动备份为 .bak_%s）：" % STAMP)
    for key, obj in (("declExam", ex), ("declDec", dc), ("declReg", rg)):
        write_json(JSON_FILES[key], obj)
        bar("  %-9s %6d 条" % (key, len(obj)))

    if warn:
        bar("\n提示（%d 条，前 10 条）：" % len(warn))
        for w in warn[:10]:
            bar("  - " + w)
    if bad:
        bar("跳过无法解析的行：%d" % bad)
    bar("\n回写完成。接着执行 build 重建站点即生效。")
    return 0


# ------------------------------------------------------------------ 体检
def do_check():
    rl = read_json(JSON_FILES["declReal"])
    ex = read_json(JSON_FILES["declExam"])
    dc = read_json(JSON_FILES["declDec"])
    rg = read_json(JSON_FILES["declReg"])
    print("JSON 现状：")
    print("  declReal %6d 码（申报要素字段名）" % len(rl))
    print("  declExam %6d 码（真实示例值）" % len(ex))
    print("  declDec  %6d 码 / %d 例（预归类实例）" % (len(dc), sum(len(v) for v in dc.values())))
    print("  declReg  %6d 码 / %d 单证（监管检疫）" % (len(rg), sum(len(v.get("d") or []) for v in rg.values())))
    bad = [c for c, v in ex.items() if c in rl and len(v) != len(rl[c])]
    print("\n对齐检查：")
    print("  declExam 与 declReal 长度不一致：%d 码" % len(bad))
    for c in bad[:5]:
        print("    %s exam=%d real=%d" % (c, len(ex[c]), len(rl[c])))
    miss = [c for c in ex if c not in rl]
    print("  declExam 中存在但 declReal 无的编码：%d 个" % len(miss))
    for c in miss[:5]:
        print("    %s" % c)
    if os.path.isdir(DATA):
        print("\n文件：")
        for p in (JSON_FILES["declReal"], JSON_FILES["declExam"],
                  JSON_FILES["declDec"], JSON_FILES["declReg"]):
            if os.path.exists(p):
                print("  %8.0f KB  %s" % (os.path.getsize(p) / 1024, os.path.relpath(p, ROOT)))
    return 0


# ------------------------------------------------------------------ 重建
def do_build():
    b = os.path.join(ROOT, "build", "bundle.py")
    if not os.path.exists(b):
        print("[错误] 找不到 build/bundle.py")
        return 2
    print("调用构建：%s" % b)
    r = subprocess.run([sys.executable, b], cwd=ROOT)
    print("\n构建退出码：%d" % r.returncode)
    if r.returncode == 0:
        print("已重新生成：税码通.html / site/index.html / site/data.js")
    return r.returncode


# ------------------------------------------------------------------ 入口
def main():
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    cmd = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
    if cmd == "export":
        return do_export()
    if cmd == "import":
        return do_import()
    if cmd == "check":
        return do_check()
    if cmd == "build":
        return do_build()
    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
