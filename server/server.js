// 税码通后端服务
// 职责：账号（注册/登录/JWT）、个人数据跨设备同步、会员标识。
// 税则查询数据由前端内嵌，本服务不提供税则搜索接口。
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { db, ensureUserData, getMeta, setMeta, getDeclCache, setDeclCache, countDeclCache } = require('./db');
const { smartFillValues } = require('./decl_fill');

const app = express();
const PORT = process.env.PORT || 3001;
/* __JWT_SECRET_PERSIST_V1__ 密钥优先级：环境变量 > server/data/.jwt_secret > 随机生成并落盘
   不再使用固定默认值，避免公开仓库中的常量成为令牌伪造入口 */
const JWT_SECRET = (function () {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const _fs = require('fs'), _path = require('path'), _crypto = require('crypto');
  const _f = _path.join(__dirname, 'data', '.jwt_secret');
  try { const s = String(_fs.readFileSync(_f, 'utf8')).trim(); if (s) return s; } catch (e) {}
  const s = _crypto.randomBytes(32).toString('hex');
  try {
    _fs.mkdirSync(_path.dirname(_f), { recursive: true });
    _fs.writeFileSync(_f, s, { mode: 0o600 });
    console.log('[税码通后端] 未设置 JWT_SECRET，已生成随机密钥 → server/data/.jwt_secret（不纳入版本控制）');
  } catch (e) { console.warn('[税码通后端] 随机密钥落盘失败，本次运行结束后令牌将失效:', e.message); }
  return s;
})();
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

// ---------- AI 申报要素补齐（大模型接口，可选） ----------
// 配置优先级：环境变量 AI_API_KEY/AI_BASE_URL/AI_MODEL > 后台「AI 配置」面板写入 DB 的 ai_config。
// 未配置密钥时禁用，前端自动回退本地规则。
function getAiConfig() {
  const meta = getMeta('ai_config', null) || {};
  const temp = (meta.temperature !== undefined && meta.temperature !== '' && !isNaN(Number(meta.temperature)))
    ? Number(meta.temperature) : 0.3;
  return {
    key: process.env.AI_API_KEY || meta.key || '',
    base: (process.env.AI_BASE_URL || meta.baseURL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: process.env.AI_MODEL || meta.model || 'gpt-4o-mini',
    provider: process.env.AI_PROVIDER || meta.provider || 'openai',
    systemPrompt: meta.systemPrompt || '',
    temperature: temp
  };
}
function aiConfigured() { return !!(getAiConfig().key); }

app.use(cors({ origin: FRONTEND_ORIGIN === '*' ? true : FRONTEND_ORIGIN.split(','), credentials: true }));
app.use(express.json({ limit: '2mb' }));

// ---------- 鉴权中间件 ----------
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已失效' });
  }
}

// ---------- 角色与权限 ----------
// 等级：regular(普通) < member(会员) < admin(管理员) < super_admin(超级管理员)
const ROLE_RANK = { regular: 1, member: 2, admin: 3, super_admin: 4 };
function roleOf(u) {
  return u.role || (u.is_admin ? 'super_admin' : (u.is_member ? 'member' : 'regular'));
}
function rankOf(role) { return ROLE_RANK[role] || 1; }
function rankFromToken(u) {
  if (u.role) return rankOf(u.role);
  return u.isAdmin ? 3 : 1;   // 兼容旧 token（仅带 isAdmin）
}

// 管理员鉴权：rank >= 3（admin / super_admin）
function adminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const u = jwt.verify(token, JWT_SECRET);
    if (rankFromToken(u) < 3) return res.status(403).json({ error: '需要管理员权限' });
    req.user = u;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已失效' });
  }
}

// 超级管理员鉴权：rank >= 4（仅超级管理员可改功能权限 / 分配角色）
function superAdminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const u = jwt.verify(token, JWT_SECRET);
    if (rankFromToken(u) < 4) return res.status(403).json({ error: '需要超级管理员权限' });
    req.user = u;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已失效' });
  }
}

function publicUser(u) {
  const role = roleOf(u);
  const r = rankOf(role);
  return {
    id: u.id, username: u.username, email: u.email,
    role: role,
    isMember: r >= 2,
    isAdmin: r >= 3,
    emailVerified: !!u.email_verified
  };
}

// ---------- 启动播种管理员账号 ----------
// 优先级：环境变量 ADMIN_USERNAME/ADMIN_PASSWORD > 库内无任何管理员时生成一次性随机密码（打印 + 落盘）
function seedAdmin() {
  const au = process.env.ADMIN_USERNAME;
  const ap = process.env.ADMIN_PASSWORD;
  if (au && ap) {
    const existing = db.prepare('SELECT id, is_admin FROM users WHERE username=?').get(au);
    if (existing) {
      if (!existing.is_admin) db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(existing.id);
    } else {
      const hash = bcrypt.hashSync(ap, 10);
      db.prepare('INSERT INTO users (username,email,password_hash,is_admin) VALUES (?,?,?,1)').run(au, null, hash);
      console.log(`[税码通后端] 已创建管理员账号： ${au}`);
    }
    return;
  }
  /* __ADMIN_RANDOM_SEED_V1__ 未配置 env 且库内无管理员时，生成一次性随机强密码
     不再使用固定的默认口令：公开仓库里的默认口令等于把后台交出去 */
  const adminCnt = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin=1').get().n;
  if (adminCnt === 0) {
    const pwd = require('crypto').randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
    const hash = bcrypt.hashSync(pwd, 10);
    try {
      require('fs').writeFileSync(require('path').join(__dirname, 'data', '.admin_password'), pwd, { mode: 0o600 });
    } catch (e) {}
    const bar = '='.repeat(62);
    console.log(bar);
    console.log('[税码通后端] 未设置 ADMIN_USERNAME/ADMIN_PASSWORD，已生成随机管理员账号');
    console.log('            用户名 : admin');
    console.log('            密  码 : ' + pwd);
    console.log('            已写入 : server/data/.admin_password（不纳入版本控制，可随时查看）');
    console.log('            生产部署请用环境变量 ADMIN_USERNAME/ADMIN_PASSWORD 指定');
    console.log(bar);
    db.prepare('INSERT INTO users (username,email,password_hash,is_admin) VALUES (?,?,?,1)').run('admin', null, hash);

  }
}
seedAdmin();

// 确保种子/默认管理员为超级管理员，解锁后台「功能权限 / 等级管理」面板
try {
  const seedName = process.env.ADMIN_USERNAME || 'admin';
  db.prepare("UPDATE users SET role='super_admin', is_admin=1 WHERE username=? AND role<>'super_admin'").run(seedName);
} catch (e) { console.warn('[seed] 升级种子管理员为超级管理员失败：', e.message); }

// ---------- 注册 ----------
app.post('/api/auth/register', (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  if (!/^[\w一-龥]{3,20}$/.test(username)) return res.status(400).json({ error: '用户名需 3-20 位（中英文或数字）' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });

  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists) return res.status(409).json({ error: '用户名已被占用' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?,?,?)')
    .run(username, email || null, hash);
  const uid = info.lastInsertRowid;
  ensureUserData(uid);

  const token = jwt.sign({ id: uid, username, role: 'regular', isAdmin: false }, JWT_SECRET, { expiresIn: '30d' });
  const user = publicUser({ id: uid, username, email: email || null, is_member: 0, is_admin: 0, role: 'regular' });
  res.json({ token, user, features: perAccountFeatures('regular') });
});

// ---------- 登录 ----------
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const role = roleOf(u);
  const token = jwt.sign({ id: u.id, username: u.username, role: role, isAdmin: rankOf(role) >= 3 }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: publicUser(u), features: perAccountFeatures(role) });
});

// ---------- 当前用户 ----------
app.get('/api/me', auth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const user = publicUser(u);
  res.json({ user: user, features: perAccountFeatures(user.role) });
});

// ---------- 修改密码 ----------
app.post('/api/auth/change-password', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '原密码和新密码都必填' });
  if (String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u || !bcrypt.compareSync(oldPassword, u.password_hash)) {
    return res.status(400).json({ error: '原密码错误' });
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
  res.json({ ok: true });
});

// ---------- 修改资料（邮箱） ----------
app.post('/api/auth/profile', auth, (req, res) => {
  const { email } = req.body || {};
  const e = (email || '').trim();
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return res.status(400).json({ error: '邮箱格式不正确' });
  db.prepare('UPDATE users SET email=? WHERE id=?').run(e || null, req.user.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ ok: true, user: publicUser(u) });
});

// ---------- 功能权限配置（按角色分级，后台可调） ----------
const DEFAULT_FEATURES = {
  roles: ['regular', 'member', 'admin', 'super_admin'],
  roleLabels: { regular: '普通用户', member: '会员', admin: '管理员', super_admin: '超级管理员' },
  // minRole：使用该功能所需的最低角色等级
  features: [
    { key: 'fav_unlimited',   label: '无限收藏',         minRole: 'member' },
    { key: 'ai_unlimited',    label: '无限 AI 归类',      minRole: 'member' },
    { key: 'batch_unlimited', label: '批量查询不限条数',   minRole: 'member' },
    { key: 'batch_export',    label: '批量导出 CSV',      minRole: 'member' },
    { key: 'tax_calc',        label: '税费计算器',         minRole: 'regular' },
    { key: 'cloud_sync',      label: '云端同步',           minRole: 'regular' },
    { key: 'history',         label: '历史记录',           minRole: 'regular' },
    { key: 'feedback',        label: '意见反馈',           minRole: 'regular' },
    { key: 'hazchem',         label: '危化品查询',         minRole: 'regular' },
    { key: 'similar_compare', label: '相似税号 PK 对比',   minRole: 'regular' },
    { key: 'exclusive_rate',  label: '专属税率查询',       minRole: 'regular' },
    { key: 'gtin',            label: 'GTIN 扫码返填',      minRole: 'regular' },
    { key: 'ocr',             label: '识图查码',           minRole: 'regular' }
  ],
  // 限额：仅对 minRole 高于该角色的受限额功能生效（Infinity 表示不限）
  limits: {
    regular:    { fav: 200, ai: 20, batch: 10 },
    member:     { fav: Infinity, ai: Infinity, batch: Infinity },
    admin:      { fav: Infinity, ai: Infinity, batch: Infinity },
    super_admin:{ fav: Infinity, ai: Infinity, batch: Infinity }
  }
};

function getFeatures() {
  const cfg = getMeta('features', null);
  if (!cfg || !cfg.features) return JSON.parse(JSON.stringify(DEFAULT_FEATURES));
  return cfg;
}
function saveFeatures(cfg) {
  if (!cfg || !Array.isArray(cfg.features)) throw new Error('配置格式错误');
  setMeta('features', cfg);
  return cfg;
}
// 某角色是否可使用某功能
function roleCan(role, minRole) { return rankOf(role) >= rankOf(minRole || 'regular'); }

// 计算某角色实际可用的功能矩阵（后端权威，供前端按账号展示 / 门控）
// 返回该账号每项的 enabled、等级标签与限额，使后端成为"按账号授权"的唯一权威源。
function perAccountFeatures(role) {
  const cfg = getFeatures();
  const r = rankOf(role || 'regular');
  const def = {
    regular:     { fav: 200, ai: 20, batch: 10 },
    member:      { fav: Infinity, ai: Infinity, batch: Infinity },
    admin:       { fav: Infinity, ai: Infinity, batch: Infinity },
    super_admin: { fav: Infinity, ai: Infinity, batch: Infinity }
  };
  return {
    role: role || 'regular',
    roleLabel: (cfg.roleLabels && cfg.roleLabels[role || 'regular']) || '普通用户',
    limits: (cfg.limits && cfg.limits[role || 'regular']) || def[role || 'regular'],
    features: cfg.features.map(function (f) {
      const mr = f.minRole || 'regular';
      return { key: f.key, label: f.label, minRole: mr, enabled: r >= rankOf(mr) };
    })
  };
}

// 公开读取（前端据此做功能显隐 / 限额）
app.get('/api/features', (req, res) => { res.json(getFeatures()); });

// 仅超级管理员可修改功能权限
app.put('/api/admin/features', superAdminAuth, (req, res) => {
  try {
    const cfg = saveFeatures(req.body);
    res.json({ ok: true, features: cfg });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- AI 配置（超级管理员在后台填写，持久化到 DB） ----------
app.get('/api/admin/ai-config', superAdminAuth, (req, res) => {
  const c = getAiConfig();
  res.json({ key: c.key ? '******' + c.key.slice(-4) : '', baseURL: c.base, model: c.model, provider: c.provider, systemPrompt: c.systemPrompt || '', temperature: c.temperature, configured: !!c.key });
});
app.put('/api/admin/ai-config', superAdminAuth, (req, res) => {
  const b = req.body || {};
  const cur = getMeta('ai_config', null) || {};
  const next = {
    key: b.clearKey ? '' : (b.key ? String(b.key) : (cur.key || '')),
    baseURL: b.baseURL || cur.baseURL || 'https://api.openai.com/v1',
    model: b.model || cur.model || 'gpt-4o-mini',
    provider: b.provider || cur.provider || 'openai',
    systemPrompt: (b.systemPrompt !== undefined) ? String(b.systemPrompt) : (cur.systemPrompt || ''),
    temperature: (b.temperature !== undefined && b.temperature !== '') ? Number(b.temperature) : (cur.temperature !== undefined ? Number(cur.temperature) : 0.3)
  };
  setMeta('ai_config', next);
  res.json({ ok: true, configured: !!next.key, baseURL: next.baseURL, model: next.model, provider: next.provider, systemPrompt: next.systemPrompt, temperature: next.temperature });
});

// ---------- 税则数据加载（用于 AI 预生成缓存：复现前端 declItems 要素名推导） ----------
let _APP = null;
function loadAppData() {
  if (_APP) return _APP;
  try {
    _APP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'app_data.json'), 'utf8'));
    if (_APP.decl && Array.isArray(_APP.decl.tpl)) {
      // 防御性：模板按前缀长度降序，保证「84」优先于「8」
      _APP.decl.tpl.sort((a, b) => (b.p || '').length - (a.p || '').length);
    }
    _APP._bycode = {};
    (_APP.items || []).forEach(it => { if (it && it.c) _APP._bycode[it.c] = it; });
  } catch (e) {
    console.warn('[appdata] 加载失败：', e.message);
    _APP = { items: [], declReal: {}, decl: { common: [], tpl: [], fallback: [] }, _bycode: {} };
  }
  return _APP;
}
// 复现前端 declItems(code)：真实目录优先 → 章节模板 → 兜底；最后拼通用项
function declItemsServer(code) {
  const app = loadAppData();
  // declReal / decl.common / tpl.e 的元素可能是字符串或对象 {k,h,o}，统一规范为 {k,h,o}
  function normEl(x) {
    if (x && typeof x === 'object') return { k: String(x.k || ''), h: x.h || '', o: Array.isArray(x.o) ? x.o : undefined };
    return { k: String(x || ''), h: '', o: undefined };
  }
  const real = app.declReal && app.declReal[code];
  let base;
  if (real !== undefined && real !== null) {
    base = Array.isArray(real) ? real : [];
  } else {
    const tpl = (app.decl && app.decl.tpl) || [];
    let mt = null;
    for (let i = 0; i < tpl.length; i++) { if (tpl[i] && (tpl[i].p || '') && code.indexOf(tpl[i].p) === 0) { mt = tpl[i]; break; } }
    base = (mt && mt.e) || (app.decl && app.decl.fallback) || [];
  }
  const common = (app.decl && app.decl.common) || [];
  return common.concat(base).map(normEl).filter(e => e.k);
}
// 下拉类要素的标准可选值（与前端 BT_OPTS/EH_OPTS/MAT_OPTS/USE_OPTS 对齐）：预生成时把 AI/本地文本归一化为下拉 option 值，杜绝「乱填」
const DECL_NORM = {
  '品牌类型': [['0', '无品牌'], ['1', '境内自主品牌'], ['2', '境内收购品牌'], ['3', '境外品牌(贴牌)'], ['4', '境外品牌(其他)']],
  '出口享惠情况': [['0', '不享受优惠'], ['1', '享受优惠'], ['2', '不能确定']]
};
const MAT_OPTS = ['不锈钢', '铝合金', '铸铁', '碳钢', '钢材', '铜', '黄铜', '塑料', '塑胶', 'PP', 'PE', 'PVC', '橡胶', '乳胶', '木材', '实木', '竹', '纺织', '棉', '涤纶', '玻璃', '陶瓷', '纸', '皮革', '硅', '钛', '镍', '锌', '镁'];
const USE_OPTS = ['用于工业设备', '用于汽车发动机', '用于机械设备传动', '用于电子设备', '用于家用电器', '用于建筑工程', '用于管道连接', '用于包装', '用于医疗仪器', '用于航空航天', '通用（非专用）'];
// 把任意文本映射到最匹配的标准 option；找不到返回 ''（绝不强行填一个不合适的）
function mapToOption(v, opts) {
  const s = String(v || '').trim();
  if (!s) return '';
  let hit = opts.find(o => o === s);
  if (hit) return hit;
  hit = opts.find(o => s.indexOf(o) >= 0);
  if (hit) return hit;
  hit = opts.find(o => o.indexOf(s) >= 0);
  if (hit) return hit;
  return '';
}
function normalizeDeclValues(values) {
  if (!values || typeof values !== 'object') return values;
  Object.keys(values).forEach(k => {
    const v = String(values[k] == null ? '' : values[k]).trim();
    if (DECL_NORM[k]) {
      const nm = DECL_NORM[k];
      let hit = nm.find(o => o[0] === v);
      if (!hit) hit = nm.find(o => v.indexOf(o[1]) >= 0 || v.indexOf(o[0]) === 0);
      values[k] = hit ? hit[0] : nm[0][0];   // 兜底填最常见默认值，绝不填无效值
    } else if (k === '材质' || k === '材料') {
      values[k] = mapToOption(v, MAT_OPTS);
    } else if (k === '用途') {
      values[k] = mapToOption(v, USE_OPTS);
    }
  });
  return values;
}

// 本地规则填充（纯目录数据，零 AI、零随机）：全部走智能推导，拿不准的留空或按规范填「无/无品牌」
function localFillValues(code, arr, it) {
  return smartFillValues(code, arr, it, loadAppData());
}

// ---------- AI 申报要素精准补齐（需登录；未配置密钥则返回 configured:false） ----------
async function callAIDeclFill(code, name, desc, elements) {
  const cfg = getAiConfig();
  if (!cfg.key) throw new Error('AI 未配置密钥');
  const sys = '你是中国海关《规范申报目录》申报要素填写助手。根据 HS 编码、商品名称和给定要素清单，为每个要素给出准确、简洁的填报值。'
    + '必须只返回一个 JSON 对象：键为要素名（与清单完全一致），值为填报内容，不要任何解释或前后缀。\n'
    + '规则：\n'
    + '1) 若要素标注「可选值：A / B / C」，必须严格从可选值中选一个，禁止自创文本。'
    + '品牌类型选代码：0=无品牌 / 1=境内自主品牌 / 2=境内收购品牌 / 3=境外品牌(贴牌) / 4=境外品牌(其他)。'
    + '出口享惠情况：0=不享受优惠 / 1=享受优惠 / 2=不能确定，无明确信息选 1。是非类（是否过踝、是否中规车等）填“是”或“否”。\n'
    + '2) 英文品名：必须给出该商品准确的英文翻译（如 Bovine meat, fresh；Footwear with outer soles of rubber）。\n'
    + '3) 拉丁学名：属动物/植物给出学名，否则填“按实际物种拉丁名申报”。\n'
    + '4) 牛肉部位/具体部位：给出常见部位示例，如“眼肉/腱子肉/辣椒肉等（按实际部位申报）”。\n'
    + '5) 品牌、品牌名称类：无法确定具体品牌填“无品牌”。型号/货号/规格类：无法确定填“无”。'
    + '签约日期/计价日期类：填“见合同（按实际申报日期填写）”。排气量/座位数/个体重量等需按实际参数的：填“按实际填写（如 …）”。\n'
    + '6) 其它无法确定：填“按实际货物申报”或类似明确指引，绝不要编造具体数值、品牌、日期、序列号。'
    + (cfg.systemPrompt ? ('\n\n补充说明（业务要求）：' + cfg.systemPrompt) : '');
  const elText = (elements || []).map(function (e) {
    let s = '- ' + e.k + (e.h ? ('（' + e.h + '）') : '');
    if (e.opts && e.opts.length) s += ' 可选值：' + e.opts.join(' / ');
    return s;
  }).join('\n');
  const usr = 'HS 编码：' + code + '\n商品名称：' + (name || '') + '\n补充说明：' + (desc || '') + '\n\n申报要素清单：\n' + elText + '\n\n请返回 JSON。';
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 55000);
  try {
    // 兼容：用户可能填了完整 endpoint（含 /chat/completions），也可能只填 base，避免重复拼接
    const url = /\/chat\/completions$/.test(cfg.base) ? cfg.base : cfg.base.replace(/\/$/, '') + '/chat/completions';
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
      body: JSON.stringify({
        model: cfg.model,
        temperature: cfg.temperature,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: usr }
        ]
      })
    });
    if (!r.ok) {
      const tx = await r.text().catch(function () { return ''; });
      throw new Error('HTTP ' + r.status + ' ' + tx.slice(0, 200));
    }
    const j = await r.json();
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!content) throw new Error('模型返回为空');
    const m = content.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}

app.post('/api/ai/decl-fill', auth, async (req, res) => {
  if (!aiConfigured()) return res.json({ configured: false });
  const body = req.body || {};
  const code = body.code, elements = body.elements;
  if (!code || !Array.isArray(elements)) return res.status(400).json({ error: '参数缺失' });
  try {
    const values = await callAIDeclFill(code, body.name || '', body.desc || '', elements);
    res.json({ configured: true, values: values || {} });
  } catch (e) {
    res.status(502).json({ configured: true, error: 'AI 调用失败：' + e.message });
  }
});

// ---------- 申报要素 AI 预生成缓存（查询时直接读库，不再实时调 AI） ----------
// 前端查询：读缓存（毫秒级）。未命中则前端回退本地规则（离线、即时）。
// 仅返回预生成的「建议值」（公开目录数据），不含任何用户隐私，故无需登录即可读。
app.get('/api/ai/decl-cache', (req, res) => {
  const code = (req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: '缺少 code' });
  const row = getDeclCache(code);
  if (!row) return res.json({ cached: false });
  res.json({ cached: true, values: row.values, model: row.model, createdAt: row.createdAt });
});
// 管理员手工写入 / 修正某编码的预生成结果
app.post('/api/ai/decl-cache', superAdminAuth, (req, res) => {
  const b = req.body || {};
  const code = (b.code || '').trim();
  if (!code || !b.values || typeof b.values !== 'object') return res.status(400).json({ error: '参数错误' });
  setDeclCache(code, b.values, b.model || '');
  res.json({ ok: true });
});

// 后台触发批量预生成（AI 真实调用，后台异步跑；查询走缓存，毫秒级）
let prewarmJob = null;
function runPrewarm(codes, job, mode) {
  const useAI = (mode === 'ai');
  if (useAI && !getAiConfig().key) { job.running = false; job.finishedAt = Date.now(); job.error = '未配置 AI 密钥（请先到「AI 配置」填写）'; return; }
  if (!useAI) {
    // 本地规则模式：纯目录数据，零 AI，秒级跑完全部。下拉要素给最常见默认（用户可一键改），自由文本取自权威目录，拿不准留空 —— 绝不乱填
    let i = 0; const CH = 800;
    function step() {
      const end = Math.min(i + CH, codes.length);
      for (; i < end; i++) {
        const code = codes[i];
        try {
          const arr = declItemsServer(code);
          const it = loadAppData()._bycode[code] || {};
          setDeclCache(code, localFillValues(code, arr, it), 'local');
          job.done++;
        } catch (e) { job.failed++; }
      }
      if (i < codes.length) setImmediate(step);
      else { job.running = false; job.finishedAt = Date.now(); }
    }
    step();
    return;
  }
  // AI 模式：逐条调大模型（慢，建议仅做增强补全）；下拉值已归一化，绝不填无效值
  const cfg = getAiConfig();
  const CONC = 3;
  let idx = 0;
  async function worker() {
    while (idx < codes.length) {
      const code = codes[idx++];
      try {
        const arr = declItemsServer(code);
        const it = loadAppData()._bycode[code] || {};
        const name = ((it.bn || '') + ' ' + (it.n || '')).trim();
        const desc = ((it.cont || '') + ' ' + (it.use || '')).trim();
        const elements = arr.map(f => {
          let opts = [];
          if (f.k === '品牌类型') opts = DECL_NORM['品牌类型'].map(o => o[0] + ' ' + o[1]);
          else if (f.k === '出口享惠情况') opts = DECL_NORM['出口享惠情况'].map(o => o[0] + ' ' + o[1]);
          else if (Array.isArray(f.o) && f.o.length) opts = f.o.slice();
          return { k: f.k, h: f.h, opts };
        });
        const values = await callAIDeclFill(code, name, desc, elements);
        if (values && typeof values === 'object') {
          normalizeDeclValues(values);
          setDeclCache(code, values, cfg.model);
        }
        job.done++;
      } catch (e) { job.failed++; }
    }
  }
  const ws = [];
  for (let i = 0; i < CONC; i++) ws.push(worker());
  Promise.all(ws).then(() => { job.running = false; job.finishedAt = Date.now(); });
}
app.post('/api/admin/decl-prewarm', superAdminAuth, (req, res) => {
  if (prewarmJob && prewarmJob.running) return res.status(409).json({ error: '已有预生成任务进行中', job: prewarmJob });
  const b = req.body || {};
  const mode = (b.mode === 'local') ? 'local' : 'ai';
  let codes = (loadAppData().items || []).map(it => it.c).filter(Boolean);
  if (b.scope === 'chapters' && Array.isArray(b.chapters) && b.chapters.length) {
    const set = b.chapters.map(String).map(s => s.replace(/^0+/, ''));
    codes = codes.filter(c => set.some(ch => c.slice(0, 2) === String(ch).padStart(2, '0') || c.indexOf(ch) === 0));
  }
  if (b.onlyMissing !== false && mode === 'ai') {
    const cached = new Set((db.prepare('SELECT code FROM decl_ai_cache').all() || []).map(r => r.code));
    codes = codes.filter(c => !cached.has(c));
  }
  if (b.limit && +b.limit > 0) codes = codes.slice(0, +b.limit);
  prewarmJob = { total: codes.length, done: 0, failed: 0, running: true, startedAt: Date.now(), finishedAt: null, error: null, mode: mode, concurrency: mode === 'ai' ? 3 : 0 };
  runPrewarm(codes, prewarmJob, mode);
  res.json({ ok: true, mode: mode, total: codes.length, message: mode === 'local' ? '已启动本地规则全量预生成（秒级，纯目录数据，零 AI 风险）' : '已启动 AI 预生成任务（较慢，请稍后查看进度）' });
});
app.get('/api/admin/decl-prewarm', superAdminAuth, (req, res) => {
  res.json({ job: prewarmJob, cached: countDeclCache() });
});

// ---------- 邮箱验证（发码 → 校验） ----------
// 当前未配置 SMTP，开发模式下验证码直接回显（devCode）；配置 SMTP_HOST 后改为真实发信。
function sendVerifyEmail(email, code) {
  if (!process.env.SMTP_HOST) return false;
  try {
    const nodemailer = require('nodemailer');
    const tp = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 465, secure: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    tp.sendMail({
      from: process.env.SMTP_USER, to: email,
      subject: '税码通 · 邮箱验证码',
      text: '你的邮箱验证码是：' + code + '（10 分钟内有效）'
    });
    return true;
  } catch (e) { console.warn('[verify] 发信失败：', e.message); return false; }
}

app.post('/api/auth/send-verify', auth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const email = (req.body && req.body.email ? req.body.email.trim() : (u.email || '')).trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: '请先填写有效邮箱' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare('INSERT OR REPLACE INTO verify_codes (user_id, code, expires_at) VALUES (?,?,?)')
    .run(u.id, code, exp);
  // 若用户改了邮箱，先更新（未验证前仅记录待验证邮箱由前端决定；此处直接写入 email 字段，验证状态另算）
  db.prepare('UPDATE users SET email=? WHERE id=?').run(email, u.id);
  const sent = sendVerifyEmail(email, code);
  res.json({ ok: true, sent, devCode: sent ? undefined : code, message: sent ? '验证码已发送到邮箱' : '开发模式：验证码已回显（未配置 SMTP）' });
});

app.post('/api/auth/verify-email', auth, (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: '请填写验证码' });
  const row = db.prepare('SELECT * FROM verify_codes WHERE user_id=?').get(req.user.id);
  if (!row) return res.status(400).json({ error: '请先获取验证码' });
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM verify_codes WHERE user_id=?').run(req.user.id);
    return res.status(400).json({ error: '验证码已过期，请重新获取' });
  }
  if (row.code !== String(code)) return res.status(400).json({ error: '验证码错误' });
  db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(req.user.id);
  db.prepare('DELETE FROM verify_codes WHERE user_id=?').run(req.user.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ ok: true, user: publicUser(u) });
});

// ---------- 个人数据同步（拉取） ----------
app.get('/api/sync', auth, (req, res) => {
  const row = db.prepare('SELECT favs, five, ai_history, decl_history FROM user_data WHERE user_id=?')
    .get(req.user.id);
  if (!row) return res.json({ favs: [], five: [], aiHistory: [], declHistory: [] });
  const safe = (x) => { try { return JSON.parse(x); } catch { return []; } };
  res.json({
    favs: safe(row.favs),
    five: safe(row.five),
    aiHistory: safe(row.ai_history),
    declHistory: safe(row.decl_history),
  });
});

// ---------- 个人数据同步（保存） ----------
app.post('/api/sync', auth, (req, res) => {
  const b = req.body || {};
  const asJson = (v, fallback) => {
    if (v === undefined || v === null) return fallback;
    try { return JSON.stringify(v); } catch { return fallback; }
  };
  db.prepare(`
    INSERT INTO user_data (user_id, favs, five, ai_history, decl_history, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      favs=excluded.favs, five=excluded.five, ai_history=excluded.ai_history,
      decl_history=excluded.decl_history, updated_at=excluded.updated_at
  `).run(
    req.user.id,
    asJson(b.favs, '[]'),
    asJson(b.five, '[]'),
    asJson(b.aiHistory, '[]'),
    asJson(b.declHistory, '[]')
  );
  res.json({ ok: true });
});

// ---------- 会员升级（当前为演示，无支付；生产需接支付回调） ----------
app.post('/api/membership/upgrade', auth, (req, res) => {
  db.prepare('UPDATE users SET is_member=1, role=? WHERE id=?').run('member', req.user.id);
  res.json({ ok: true, isMember: true });
});

app.post('/api/membership/cancel', auth, (req, res) => {
  const u = db.prepare('SELECT role FROM users WHERE id=?').get(req.user.id);
  if (u && (u.role === 'admin' || u.role === 'super_admin')) {
    return res.status(400).json({ error: '管理员账号不可取消会员' });
  }
  db.prepare('UPDATE users SET is_member=0, role=? WHERE id=?').run('regular', req.user.id);
  res.json({ ok: true, isMember: false });
});

// ================= 业务服务接口（让后端不只是"查看"，真正服务于前端） =================

// 税费计算器：到岸成本测算（关税 + 消费税 + 增值税）。
// 设计原则：税率数据由前端内嵌提供（单一数据源，避免后端再存一份漂移），后端只负责统一公式。
function round2(n) { return Math.round((n || 0) * 100) / 100; }
app.post('/api/calc/duty', (req, res) => {
  const b = req.body || {};
  const num = (v, d) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
  let cifCNY = num(b.cif, NaN);
  const fxOn = !!(b.fx && b.fx.on);
  if (fxOn) {
    const foreign = num(b.fx.foreign, NaN);
    const rate = num(b.fx.rate, NaN);
    if (!isFinite(foreign) || !isFinite(rate) || rate <= 0) return res.status(400).json({ error: '外币金额与汇率需为有效正数' });
    cifCNY = foreign * rate;
  }
  if (!isFinite(cifCNY) || cifCNY < 0) return res.status(400).json({ error: '成交价格（到岸价）需为有效非负数' });
  const mf = num(b.mfRate, 0), vat = num(b.vatRate, 0), cons = num(b.consRate, 0);
  if (mf < 0 || vat < 0 || cons < 0 || cons >= 100) return res.status(400).json({ error: '税率需为 0–100 的合法数值' });
  const tariff = cifCNY * mf / 100;
  const consumption = cons > 0 ? (cifCNY + tariff) / (1 - cons / 100) * (cons / 100) : 0;
  const vatTax = (cifCNY + tariff + consumption) * vat / 100;
  const total = tariff + consumption + vatTax;
  const effective = cifCNY > 0 ? total / cifCNY * 100 : 0;
  res.json({
    ok: true, currency: fxOn ? 'CNY(折算)' : 'CNY',
    cifCNY: round2(cifCNY), tariff: round2(tariff), consumption: round2(consumption),
    vat: round2(vatTax), total: round2(total), effectiveRate: round2(effective)
  });
});

// 反馈 / 数据纠错入库（需登录）
app.post('/api/feedback', auth, (req, res) => {
  const { type, hsCode, content, contact } = req.body || {};
  if (!content || !String(content).trim()) return res.status(400).json({ error: '反馈内容不能为空' });
  const t = (type && ['意见', '建议', '需求', '数据纠错'].includes(type)) ? type : '意见';
  const code = (hsCode || '').toString().replace(/[.\s]/g, '');
  const info = db.prepare('INSERT INTO feedback (user_id,username,type,hs_code,content,contact,status) VALUES (?,?,?,?,?,?,?)')
    .run(req.user.id, req.user.username, t, code, String(content).trim().slice(0, 2000), (contact || '').toString().slice(0, 200), 'open');
  res.json({ ok: true, id: info.lastInsertRowid });
});

// 浏览埋点（公开，无需登录）：统计真实热门税号
app.post('/api/track/view', (req, res) => {
  const code = (req.body && req.body.hsCode || '').toString().replace(/[.\s]/g, '');
  if (!/^\d{4,8}$/.test(code)) return res.status(400).json({ error: '无效的税则号列' });
  db.prepare("INSERT INTO popular (hs_code, views) VALUES (?, 1) ON CONFLICT(hs_code) DO UPDATE SET views=views+1, updated_at=datetime('now')").run(code);
  res.json({ ok: true });
});

// 热门税号（公开）：供首页"大家都在查"真实展示
app.get('/api/popular', (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '12', 10) || 12));
  const rows = db.prepare('SELECT hs_code AS code, views FROM popular ORDER BY views DESC, updated_at DESC LIMIT ?').all(limit);
  res.json({ items: rows });
});

// ---------- 健康检查 ----------
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ================= 管理后台接口（需管理员令牌） =================

// 概览统计
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const members = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_member=1').get().n;
  const admins = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin=1').get().n;
  const verified = db.prepare('SELECT COUNT(*) AS n FROM users WHERE email_verified=1').get().n;
  const roleCounts = {};
  db.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role').all().forEach(r => { roleCounts[r.role] = r.n; });
  const dataRows = db.prepare('SELECT COUNT(*) AS n FROM user_data').get().n;
  let dbSize = 0;
  try { dbSize = fs.statSync(path.join(__dirname, 'data', 'zhiguantong.db')).size; } catch (e) {}
  res.json({ total, members, admins, verified, roleCounts, dataRows, dbSizeBytes: dbSize });
});

// 后台概览：反馈分布 + 热门税号榜（含名称）+ 近期注册
let _codeNameCache = null;
function codeNameMap(){
  if (_codeNameCache) return _codeNameCache;
  try {
    const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'app_data.json'), 'utf8'));
    const m = {}; (app.items || []).forEach(it => { m[it.c] = it.bn || it.n; });
    _codeNameCache = m;
  } catch (e) { _codeNameCache = {}; }
  return _codeNameCache;
}
app.get('/api/admin/overview', adminAuth, (req, res) => {
  const fbByType = {};
  db.prepare('SELECT type, COUNT(*) AS n FROM feedback GROUP BY type').all().forEach(r => { fbByType[r.type] = r.n; });
  const fbOpen = db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status='open'").get().n;
  const fbResolved = db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status='resolved'").get().n;
  const fbTotal = db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n;
  const top = db.prepare('SELECT hs_code AS code, views FROM popular ORDER BY views DESC, updated_at DESC LIMIT 12').all();
  const nm = codeNameMap();
  const topPopular = top.map(r => ({ code: r.code, views: r.views, name: nm[r.code] || '' }));
  let reg7d = 0;
  try { reg7d = db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= datetime('now','-7 days')").get().n; } catch (e) {}
  res.json({ fbByType, fbOpen, fbResolved, fbTotal, topPopular, reg7d });
});

// 用户列表（支持关键字搜索与分页）
app.get('/api/admin/users', adminAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const size = Math.min(200, parseInt(req.query.size || '50', 10) || 50);
  const like = `%${q}%`;
  const total = db.prepare('SELECT COUNT(*) AS n FROM users WHERE username LIKE ? OR email LIKE ?').get(like, like).n;
  const rows = db.prepare(`
    SELECT id, username, email, is_member, is_admin, role, email_verified, created_at
    FROM users WHERE username LIKE ? OR email LIKE ?
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(like, like, size, (page - 1) * size);
  res.json({ total, page, size, users: rows });
});

// 切换会员状态（仅对普通/会员账号生效，不影响管理员）
app.post('/api/admin/users/:id/member', adminAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const val = req.body && req.body.value ? 1 : 0;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const cur = roleOf(u);
  if (cur === 'admin' || cur === 'super_admin') return res.status(400).json({ error: '管理员账号角色不可在会员开关中修改' });
  db.prepare('UPDATE users SET is_member=?, role=? WHERE id=?').run(val ? 1 : 0, val ? 'member' : 'regular', id);
  res.json({ ok: true, isMember: !!val, role: val ? 'member' : 'regular' });
});

// 分配角色（仅超级管理员）
app.put('/api/admin/users/:id/role', superAdminAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const role = (req.body && req.body.role) || '';
  if (!ROLE_RANK[role]) return res.status(400).json({ error: '无效角色' });
  if (id === req.user.id && role !== 'super_admin') return res.status(400).json({ error: '不能降低自己的超级管理员角色' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const r = rankOf(role);
  db.prepare('UPDATE users SET role=?, is_member=?, is_admin=? WHERE id=?')
    .run(role, r >= 2 ? 1 : 0, r >= 3 ? 1 : 0, id);
  res.json({ ok: true, role, user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
});

// 手动核验邮箱（仅超级管理员）
app.put('/api/admin/users/:id/verify-email', superAdminAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const info = db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: '用户不存在' });
  res.json({ ok: true, emailVerified: true });
});

// 删除用户（同时删除其个人数据；禁止删除自己）
app.delete('/api/admin/users/:id', adminAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: '不能删除当前登录的管理员账号' });
  const info = db.prepare('DELETE FROM users WHERE id=?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: '用户不存在' });
  db.prepare('DELETE FROM user_data WHERE user_id=?').run(id);
  res.json({ ok: true });
});

// 反馈列表（管理员审核）
app.get('/api/admin/feedback', adminAuth, (req, res) => {
  const status = (req.query.status || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const size = Math.min(200, parseInt(req.query.size || '50', 10) || 50);
  const where = status ? 'WHERE status=?' : '';
  const params = status ? [status] : [];
  const total = db.prepare('SELECT COUNT(*) AS n FROM feedback ' + where).get(...params).n;
  const rows = db.prepare('SELECT id, user_id, username, type, hs_code, content, contact, status, created_at FROM feedback ' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...params, size, (page - 1) * size);
  res.json({ total, page, size, items: rows });
});

// 用户查看自己的反馈及处理状态（需登录）
app.get('/api/feedback/mine', auth, (req, res) => {
  const rows = db.prepare('SELECT id, type, hs_code, content, contact, status, created_at FROM feedback WHERE user_id=? ORDER BY id DESC').all(req.user.id);
  res.json({ items: rows });
});

// 标记反馈已处理 / 重新打开
app.post('/api/admin/feedback/:id/resolve', adminAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const val = (req.body && req.body.resolve) ? 'resolved' : 'open';
  const info = db.prepare('UPDATE feedback SET status=? WHERE id=?').run(val, id);
  if (info.changes === 0) return res.status(404).json({ error: '反馈不存在' });
  res.json({ ok: true, status: val });
});

// __HTML_REVALIDATE_V1__ HTML 用 no-cache（可缓存但每次校验）：既保证「改完刷新即见」，
// 又允许内容未变时返回 304（0 字节），避免每次打开都重下整个首页。
function noCacheHtml(res){
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}
// 管理后台页面
app.get(['/admin', '/admin.html'], (req, res) => {
  noCacheHtml(res);
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// 托管前端构建产物（同源部署：页面与 /api 同端口，避免跨机/跨源连不上账号服务）
const SITE_DIR = path.join(__dirname, '..', 'site');

/* __GZIP_STATIC_V2__ 静态资源：gzip 压缩 + ETag 校验（零依赖，不引入任何 npm 包）
   - data.js 近 20MB，压缩后约 2MB，首次传输即省 ~88%
   - ETag(体积+修改时间) 做 304 校验：内容没变不重传，重复打开几乎零流量
   - 压缩结果按 ETag 缓存在内存（上限 GZ_CACHE_MAX），避免每次请求重复压缩
   - 首页 `/` 与 SPA 回退同样走本中间件（否则会绕过压缩，首页仍是最慢的那一页）
   - HTML 用 no-cache + ETag：改完刷新即见，内容未变则 304 */
const zlib = require('zlib');
const COMPRESSIBLE = /\.(js|mjs|css|json|svg|txt|map|html?)$/i;
const GZ_TYPES = {
  '.js': 'application/javascript; charset=UTF-8',
  '.mjs': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=UTF-8',
  '.map': 'application/json',
  '.html': 'text/html; charset=UTF-8',
  '.htm': 'text/html; charset=UTF-8'
};
const GZ_CACHE_MAX = 12;
const _gzCache = new Map();          // etag -> Buffer(已压缩)

function fileETag(st) {
  return 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
}

function gzipStaticMiddleware(root) {
  const ROOT_INDEX = path.join(root, 'index.html');

  function statFile(p) {
    try { const st = fs.statSync(p); return st.isFile() ? st : null; } catch (e) { return null; }
  }
  function resolveTarget(rel) {
    const fp = path.resolve(root, '.' + rel);
    if (fp !== root && !fp.startsWith(root + path.sep)) return null;   // 防目录穿越
    const st = statFile(fp);
    if (st) return { fp: fp, st: st };
    try {                                                             // 目录 → 其 index.html
      if (fs.statSync(fp).isDirectory()) {
        const ip = path.join(fp, 'index.html');
        const s2 = statFile(ip);
        if (s2) return { fp: ip, st: s2 };
      }
    } catch (e) {}
    return null;
  }

  return function (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel;
    try { rel = decodeURIComponent(req.path || '/'); } catch (e) { return next(); }
    if (/^\/api\//.test(rel) || rel === '/admin' || rel === '/admin.html') return next();

    let tgt = resolveTarget(rel);
    if (!tgt) {
      // SPA 回退：页面类请求找不到实体文件时按根 index.html 返回（与下方 catch-all 一致）
      const ext = path.extname(rel).toLowerCase();
      const pageLike = rel.endsWith('/') || ext === '' || ext === '.html' || ext === '.htm';
      if (pageLike) {
        const st = statFile(ROOT_INDEX);
        if (st) tgt = { fp: ROOT_INDEX, st: st };
      }
    }
    if (!tgt) return next();
    if (!COMPRESSIBLE.test(tgt.fp)) return next();

    const fp = tgt.fp, st = tgt.st;
    const etag = fileETag(st);
    const isHtml = /\.html?$/i.test(fp);
    res.setHeader('ETag', etag);
    res.setHeader('Vary', 'Accept-Encoding');
    if (isHtml) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }

    const wantsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    if (!wantsGzip) return next();          // 不支持 gzip 的客户端交给 express.static

    const ext = path.extname(fp).toLowerCase();

    function send(buf) {
      res.setHeader('Content-Type', GZ_TYPES[ext] || 'application/octet-stream');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', buf.length);
      res.setHeader('X-Uncompressed-Size', String(st.size));
      if (req.method === 'HEAD') return res.end();
      return res.end(buf);
    }

    const cached = _gzCache.get(etag);
    if (cached) return send(cached);

    fs.readFile(fp, function (err, raw) {          // 未命中：异步压缩，不阻塞事件循环
      if (err) return next();
      zlib.gzip(raw, { level: 6 }, function (err2, gz) {
        if (err2) return next();
        if (_gzCache.size >= GZ_CACHE_MAX) _gzCache.clear();
        _gzCache.set(etag, gz);
        send(gz);
      });
    });
  };
}

// 启动后异步预热：把大文件先压好，避免第一个访问者等压缩
function prewarmGzip(rels) {
  rels.forEach(function (rel) {
    const fp = path.join(SITE_DIR, rel);
    fs.stat(fp, function (err, st) {
      if (err || !st.isFile()) return;
      const etag = fileETag(st);
      if (_gzCache.has(etag)) return;
      fs.readFile(fp, function (e, raw) {
        if (e) return;
        zlib.gzip(raw, { level: 6 }, function (e2, gz) {
          if (e2) return;
          if (_gzCache.size >= GZ_CACHE_MAX) _gzCache.clear();
          _gzCache.set(etag, gz);
          console.log('[静态压缩预热] ' + rel + '  ' + (raw.length / 1048576).toFixed(2) + 'MB -> ' +
                      (gz.length / 1048576).toFixed(2) + 'MB  (省 ' + (100 - gz.length * 100 / raw.length).toFixed(0) + '%)');
        });
      });
    });
  });
}

if (fs.existsSync(SITE_DIR)) {
  app.use(gzipStaticMiddleware(SITE_DIR));
  app.use(express.static(SITE_DIR, { index: false, etag: true, lastModified: true, setHeaders: function (res, filePath) {
    // HTML 用 no-cache + ETag 校验（改完即见 且 重复打开走 304）；其余静态资源同理
    if (/\.html?$/i.test(filePath)) noCacheHtml(res);
    else res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  }}));
  app.get(/^\/(?!api\/|admin$|admin\.html$).*/, (req, res) => {
    noCacheHtml(res);
    res.sendFile(path.join(SITE_DIR, 'index.html'));
  });
  prewarmGzip(['index.html', 'data.js']);
}

app.listen(PORT, () => {
  console.log(`[税码通后端] 监听 http://localhost:${PORT}  (FRONTEND_ORIGIN=${FRONTEND_ORIGIN})`);
});
