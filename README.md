# 税码通 · 进出口税则 / 归类 / 申报要素速查

个人关务工具：税则号列查询、智能归类建议、申报要素生成、危化品查询。
**前期全功能免费，仅要求登录（用于云端同步与积累用户）；付费墙后续再定。前端单文件离线可查，账号与同步走独立后端。**

---

## 架构

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | 原生 JS 单文件（数据内嵌） | `site/index.html` 自包含，双击即可查；GitHub Pages 可托管 |
| 后端 | Node + 内置 `node:sqlite` + JWT | `server/`：账号、个人数据跨设备同步、会员标识 |
| 构建 | Python `build/bundle.py` | 把 `data/*.json` 注入 `build/template.html` 生成单文件 |

> 税则数据**前端内嵌**，免费查询无需联网；只有「账号登录 / 云端同步」需要联网。
> 因此「纯离线」指的是查询能力，「账号」必然需要服务端——二者已分层，互不绑架。

---

## 目录结构

```
tariff2026/
├─ build/            # 模板与打包脚本
│  ├─ template.html  # 前端源（在此修改 UI，再 bundle）
│  └─ bundle.py
├─ data/             # 税则/别名/归类决定等 JSON 源数据（构建用）
├─ server/           # 后端：账号 + 同步 + 会员
│  ├─ server.js  db.js  admin.html  package.json
│  └─ data/          # 运行时 SQLite（已 gitignore，含用户隐私）
├─ site/             # 构建产物：网站本体（本地服务就是跑这个目录）
│  ├─ index.html     # 界面（含内联脚本）
│  └─ data.js        # 全部数据，约 18 MB，单独缓存
├─ index.html        # 根跳转页 -> ./site/（GitHub Pages 从根目录发布用）
├─ 更新并推送.bat     # 改完内容双击这个：重新生成 + 提交 + 推送
├─ 修改指南.md        # 怎么改、怎么上线、怎么换电脑
└─ 税码通.html       # 单文件离线版（bundle.py 生成，未入库）
```

---

## 仓库地址

- 仓库：<https://github.com/mosgpt-alt/shuimatong>
- 公开网址：<https://mosgpt-alt.github.io/shuimatong/>（GitHub Pages，`main` 分支根目录）
- 本地预览：双击 `启动本地服务.bat` → <http://127.0.0.1:3001>

---

## 改内容 / 上线（一步）

改数据或界面后，**双击仓库根目录的 `更新并推送.bat`** 就行：

```
build/bundle.py 重新生成 site/  ->  git commit  ->  git push  ->  Pages 自动重新发布
```

只改 `data/*.json` 不会自动生效 —— 网页内容是 `template.html` + `data/*.json` 一起生成的，
必须重跑一次 `bundle.py`（脚本已经替你做了）。

**只想改数据不想碰 JSON**：用 `本地数据/` 里的「1 导出CSV.bat」→ Excel 改 → 「2 回写并重建.bat」。

完整说明见 **[修改指南.md](修改指南.md)**（含：哪个是源哪个是生成物、怎么换电脑、常见坑）。

> 注意：`site/data.js` 是 18 MB 的单文件，每改一次数据提交一次，仓库就多存 18 MB。
> 长期高频更新建议上 Git LFS，或只提交 `data/*.json` 让 `bundle.py` 现生成。

---

## 本地运行后端

```bash
cd server
npm install
PORT=3001 JWT_SECRET=你的随机密钥 FRONTEND_ORIGIN=* node --experimental-sqlite server.js
# 健康检查： http://localhost:3001/api/health
```

> `node:sqlite` 是 Node 22 实验特性，启动需 `--experimental-sqlite` 标志（见 package.json 的 start 脚本）。
> 未设置 `JWT_SECRET` 时后端会自动生成随机密钥并持久化到 `server/data/.jwt_secret`（已无固定默认值）；生产部署仍建议显式指定，并务必设置 `FRONTEND_ORIGIN`（限制可调用前端的域名）。

## 前端对接后端

前端默认假设后端在 `http://localhost:3001`。部署到线上时，二选一告诉前端后端地址：

1. 改 `build/template.html` 里的 `<meta name="zg-api-base" content="">` 填真实后端 URL；
2. 或在页面加载前设置 `window.ZG_API_BASE = 'https://你的后端域名'`。

后端需开启 CORS 允许前端域名（环境变量 `FRONTEND_ORIGIN`）。

---

## 管理后台

后台管理页面位于 `server/admin.html`，由后端直接提供，访问地址：

```
http://<后端域名或localhost:3001>/admin
```

功能：管理员登录、用户总数/会员数/数据库大小概览、用户列表（搜索 + 分页）、切换会员状态、删除用户（连同其个人数据一并清除）。

**管理员账号播种规则**（服务启动时执行 `seedAdmin()`）：

- 设置了环境变量 `ADMIN_USERNAME` + `ADMIN_PASSWORD` → 以此创建/确保该账号为管理员（推荐，生产必用）；
- 未设置 env 且库内**尚无任何管理员** → 生成**一次性随机强密码**创建 `admin` 账号：密码会打印在启动日志里，同时写入 `server/data/.admin_password`（不纳入版本控制）。
- 普通注册用户**不会**自动成为管理员；访问 `/api/admin/*` 会被中间件拦截返回 403。

```bash
# 生产示例：用强密码指定管理员，避免默认账号
PORT=3001 JWT_SECRET=你的随机密钥 FRONTEND_ORIGIN=你的前端域名 \
ADMIN_USERNAME=your_admin ADMIN_PASSWORD=超强密码 \
node --experimental-sqlite server.js
```

> 安全提醒：仓库里**不含任何默认口令**，也**不含数据库文件**（`server/data/` 已被 `.gitignore` 排除，首次启动自动重建）。忘了随机密码就看 `server/data/.admin_password`。生产部署仍建议用 `ADMIN_USERNAME/ADMIN_PASSWORD` 显式指定。
>
> ⚠️ **备份要注意 WAL**：数据库开的是 WAL 模式，最新写入可能还在 `zhiguantong.db-wal` 里（本机实测一份库里 WAL 就积了 8 MB）。**只拷 `zhiguantong.db` 会丢数据** —— 要么先停服务，再把 `.db` / `.db-wal` / `.db-shm` 三个一起拷，要么直接跑仓库根目录的 `备份数据库.bat`（走 `VACUUM INTO`，产出单文件一致性快照）。

---

## 部署

- **前端（静态）**：GitHub Pages → Settings → Pages → Source 选 `main` 分支、目录 `/ (root)`。仓库根已放好 `.nojekyll` 和跳转用的 `index.html`（自动进 `/site/`）。约 1 分钟出 `https://<你>.github.io/<仓库>/`。
  > GitHub 的发布目录**只能选 root 或 `/docs`**，选不到 `/site`；想省掉跳转就把 `site/` 改名成 `docs/` 再把 Source 指向 `/docs`。
- **后端（必须独立托管）**：GitHub Pages **不能**跑 Node。选 Render / Railway / 任意 VPS，暴露 HTTPS 域名，把该域名填到前端的 `zg-api-base`。务必设置环境变量 `JWT_SECRET`、`FRONTEND_ORIGIN`、`PORT`。

---

## 账号 / 会员（前期策略：全功能免费）

- **运营策略**：网站刚上线，优先积累用户与反馈。前期所有功能免费开放，仅要求**登录**（登录用于云端同步你的收藏/已填要素/历史，并帮助我们了解用户最需要什么）。付费墙（哪些功能收费、价格）将在收集足够反馈后再决定，届时再开放升级入口。
- 注册 / 登录：JWT 鉴权，密码用 bcrypt 哈希。
- 个人数据（收藏、已填申报要素、AI 历史、申报历史）登录后自动同步到后端，换设备登录即可恢复；未登录时仅存本机浏览器。
- 数据安全：除登录态所需的账号信息外，个人填报数据**默认仅在你本机与你的账号云端之间**，不上传给任何第三方。
- 会员：`/api/membership/upgrade` 接口保留但**暂不启用**（前端已移除升级入口）。上线收费前需接入支付回调并做真实订单校验。

---

## 数据来源与免责

数据整理自《中华人民共和国进出口税则》《海关进出口商品涉税规范申报目录》《报关单填制规范》《危险化学品目录》及海关总署归类决定等官方公开资料，**仅供个人归类参考**。
本工具查询结果**不构成法律或行政建议**，最终归类请以海关认定为准。
仓库含官方整理数据，如用于分发请注意相关版权与用途限制；建议补充 `LICENSE` 明确授权范围。

---

## 待办 / 已知项

- [ ] 收集用户反馈，决定付费墙位置（前期全功能免费）
- [ ] 会员收费接入真实支付与订单校验（接口已预留，暂不启用）
- [ ] 后端增加速率限制、HTTPS 强制、定期备份策略
- [ ] 前端会员专属功能本体（批量一键申报 / 历史申报库调用 / GTIN 扫码返填）：GTIN 暂留不开发；批量申报与历史库待需求明确后实现
- [ ] OCR 识别走 CDN（Tesseract.js），已在 OCR 页注明「联网首次加载识别包」
- [x] 个人数据导入/恢复（导出/导入完整备份 JSON）
- [x] 启动加载遮罩（6.85MB 解析期间不再白屏）
- [x] 收敛 AI 措辞（移除「92% 准确率」等无来源表述）
