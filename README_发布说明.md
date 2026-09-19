# 税码通 · 发布包说明

生成时间：2026-09-19 14:42 ｜ 包体积：87.0 MB

## 这是什么

`税码通编码网站` 的**纯净发布包**。数据 100% 内嵌本机，开箱即用，不依赖任何外部接口。

- 税则号列 **8,978** 条（2026 版）
- 申报要素真实示例 **6,921** 条
- 海关预归类真实实例 **837** 条
- 监管条件 / 检验检疫 / 随附单证 **8,970** 条
- 民间叫法 / 俗语 → 规范名 **13,009** 条
- 危化品目录 **2,922** 项

## 怎么用

### 1) 本机跑起来

双击 **`启动本地服务.bat`** → 浏览器自动打开 `http://localhost:3001/`

脚本自动探测 Node；缺依赖自动 `npm install`；端口已在跑就直接复用。
停止：关掉标题为「税码通后端」的窗口。

### 2) 不装任何东西，双击即用

打开 **`离线单文件\税码通.html`** —— 单文件，数据全内嵌，双击就能查。

### 3) 上线（部署静态托管）

把 **`site\`** 整个目录传上去即可（Vercel / Netlify / Nginx / 对象存储都行）：

| 文件 | 说明 |
|---|---|
| `site\index.html` | 0.48MB，已按 gzip + ETag 优化（服务端支持时重复打开走 304） |
| `site\data.js` | 税则数据 17.9MB，gzip 后约 2.2MB |

后端 `server\` 只在需要**账号登录 / 跨设备同步收藏**时才部署；不部署也能跑（自动进免登录模式）。

## 目录结构

| 路径 | 作用 |
|---|---|
| `site\` | 线上版（`index.html` + `data.js`），整目录即可部署 |
| `离线单文件\税码通.html` | 离线单文件版，双击即用 |
| `server\` | 后端账号 / 同步服务（Node 22 + express，含 `node_modules`，免装依赖） |
| `data\` | 构建输入：`decl_real / decl_exam / decl_decisions / decl_reg / app_data / alias_folk / cls_decisions` |
| `本地数据\` | **改数据就改这里**：CSV + `local_data.py` + 3 个一键 bat |
| `build\` | 构建源：`template.html`（页面）+ `bundle.py`（注入数据出产物）+ `发布.bat` |

## 改数据 / 改页面后重新出包

1. `本地数据\1 导出CSV.bat` → 拿到 CSV，用 Excel 改
2. `本地数据\2 回写并重建.bat` → 回写 JSON 并重跑构建
3. 或直接 `build\发布.bat` → 重新生成 `site\index.html`、`site\data.js`、`离线单文件\税码通.html`

## 已做的本地化改造

| 项 | 状态 |
|---|---|
| 前端补齐申报要素 | **纯本地**，零接口调用（`__AIFILL_LOCAL_V2__`） |
| 登录门禁 | **已去掉**，打开直接进应用；登录入口降级为首页右上角按钮（`__NO_LOGIN_GATE_V1__` / `__HOME_LOGIN_ENTRY_V1__`） |
| 首屏启动 | 懒加载计数（`__AF_COUNT_LAZY__`），DCL 由 55.6s 降到约 1s |
| 传输 | gzip 预热 + ETag；首屏 19.1MB → 2.4MB，重复打开 304 |
| 「真实实例」标记 | 只标真正来自实例库的（`__RV_MARK_REAL_ONLY__`） |

## 没打进包里的东西（源工程里都还在）

| 项 | 原因 |
|---|---|
| `site\data\`（13MB） | 旧 SQLite 版遗留，模板全站无引用 |
| `data\export\`（13MB） | 同上，旧导出 |
| `build\node_modules\`（25MB） | 旧测试脚本用；`bundle.py` 只用 Python 标准库 |
| `.bak` / `_backups\`（229MB） | 历史快照，已移入 `G:\_回收_税码通_20260919\` |

## 回滚

- 补丁脚本（幂等，可重复跑）：`F:\工作空间\hs-declare2026\patch_no_login_gate.py`、`patch_home_login_entry.py`
- 备份还原：`G:\_回收_税码通_20260919\_rollback.bat`
