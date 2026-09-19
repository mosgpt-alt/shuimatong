# 本地数据（可直接编辑）

网站用到的**全部真实实例数据都存在本地文件里**，不依赖任何外部接口，断网照样用。
想改数据，就改这个目录里的 CSV。

---

## 数据流

```
data/decl_real.json        ┐
data/decl_exam.json        │  ①导出            ②改CSV           ③回写           ④重建
data/decl_decisions.json   ├────────→  本地数据\*.csv  ────────→  data\*.json  ────────→  税码通.html
data/decl_reg.json         ┘                                                             site\index.html
                                                                                         site\data.js
```

只有一条链路、一个数据源：`data\decl_*.json`。
**改完 CSV 必须回写 + 重建，页面才会变。**

---

## 四个 CSV 分别是什么

| 文件 | 行数 | 内容 | 回写到 |
|---|---|---|---|
| 申报要素示例.csv | 30941 | 每个编码、每个要素的**真实填报实例** | data\decl_exam.json |
| 预归类实例.csv | 2034 | 海关预归类决定的**真实商品案例** | data\decl_decisions.json |
| 监管检疫单证.csv | 8970 | 监管条件 / 检验检疫类别 / 法定单位 / 政策依据 | data\decl_reg.json |
| 随附单证.csv | 14214 | 每个编码对应的随附单证清单 | data\decl_reg.json 里的 d 字段 |

---

## 怎么改

1. 双击 **1 导出CSV.bat**（第一次不用做，CSV 已经生成好）
2. 用 Excel / WPS 打开 CSV，直接改
3. 双击 **2 回写并重建.bat** —— 自动回写 JSON 并重建站点
4. 刷新网站页面即生效

---

## 改的时候注意

- **不要改「商品编码」列**：它是主键，改了等于新增/删除一条编码。
- **「序号」列别打乱**：`申报要素示例.csv` 的示例值是**按序号跟要素名一一对应**的，
  序号 1 就是该编码的第 1 个要素。
- **「品名」列是给人看的**，回写时会被忽略，随便改不影响数据。
- **不要在单元格里敲回车**去造多行（回写会当成一整个值，页面显示会挤）。
- 分号 `;`、竖线 `|` 都当普通字符，不需要转义。
- Excel 保存时如果问「保持 CSV 格式」，选**是**。
- 回写前，脚本会**自动把 data\*.json 备份**成 `.bak_<时间戳>`，改坏了可以从备份还原。

---

## 常用命令（本目录内）

```
python local_data.py export    # data/*.json  -> 本地数据/*.csv
python local_data.py import    # 本地数据/*.csv -> data/*.json（自动备份）
python local_data.py check     # 体检：条数、对齐情况，只读不改
python local_data.py build     # 只重建站点（不碰数据）
```

---

## 相关文件在哪

| 位置 | 作用 |
|---|---|
| `data\decl_*.json` | **唯一数据源**（本目录 CSV 回写的目标） |
| `build\template.html` | 页面模板（HTML/CSS/JS 源码，改界面改这里） |
| `build\bundle.py` | 构建脚本：模板 + 数据 → 产物 |
| `build\发布.bat` | 一键重建（等同于 `python local_data.py build`） |
| `税码通.html` | 离线单文件版（数据内联，双击即用） |
| `site\index.html` | 线上版页面 |
| `site\data.js` | 线上版外置数据 |

---

## 数据现状

| 键 | 编码数 | 说明 |
|---|---|---|
| declReal | 8978 | 申报要素字段名 |
| declExam | 6921 | 真实示例值（约 78% 的编码有） |
| declDec | 837 | 预归类实例，共 2034 例 |
| declReg | 8970 | 监管检疫，共 14214 条随附单证 |

> 约 22% 的编码来源库里本来就没有填报示例（如部分「改良种用」等），
> 页面会保持原有的通用提示，不虚构数据。
