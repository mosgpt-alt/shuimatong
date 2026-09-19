// 数据库层：使用 Node 22 内置的实验性 node:sqlite（纯内置、无需原生编译）。
// 只存「账号 + 个人数据」，税则数据不放这里（前端内嵌）。
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'zhiguantong.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  email         TEXT,
  password_hash TEXT NOT NULL,
  is_member     INTEGER NOT NULL DEFAULT 0,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  role          TEXT NOT NULL DEFAULT 'regular',   -- super_admin | admin | member | regular
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 邮箱验证码（6 位，10 分钟有效）
CREATE TABLE IF NOT EXISTS verify_codes (
  user_id     INTEGER PRIMARY KEY,
  code        TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 键值配置（功能权限开关等）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 每个用户一行个人数据；字段均为 JSON 文本，便于前端直接存取。
CREATE TABLE IF NOT EXISTS user_data (
  user_id       INTEGER PRIMARY KEY,
  favs          TEXT NOT NULL DEFAULT '[]',   -- 收藏税号列表
  five          TEXT NOT NULL DEFAULT '[]',   -- 已填申报要素
  ai_history    TEXT NOT NULL DEFAULT '[]',   -- AI 生成历史
  decl_history  TEXT NOT NULL DEFAULT '[]',   -- 历史申报库
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 用户反馈 / 数据纠错（前端意见框入库，管理员可审核）
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  username    TEXT,
  type        TEXT NOT NULL DEFAULT '意见',   -- 意见 | 建议 | 需求 | 数据纠错
  hs_code     TEXT,
  content     TEXT NOT NULL,
  contact     TEXT,
  status      TEXT NOT NULL DEFAULT 'open',   -- open | resolved
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 热门税号浏览计数（用于首页"大家都在查"真实统计）
CREATE TABLE IF NOT EXISTS popular (
  hs_code     TEXT PRIMARY KEY,
  views       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AI 申报要素预生成缓存：code → 该编码各要素填报值（避免每次实时调慢吞吞的 LLM）
CREATE TABLE IF NOT EXISTS decl_ai_cache (
  code        TEXT PRIMARY KEY,
  val_json    TEXT NOT NULL,            -- JSON: { 要素名: 填报值 }
  model       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// 并发安全：WAL 模式让「预生成写入」与「前端读取」互不阻塞；busy_timeout 避免 SQLITE_BUSY
try {
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA busy_timeout=5000;');
  db.exec('PRAGMA synchronous=NORMAL;');
} catch (e) { console.warn('[db] 设置 WAL 失败：', e.message); }

// 确保存在 user_data 行（注册时调用）
function ensureUserData(userId) {
  db.prepare('INSERT OR IGNORE INTO user_data (user_id) VALUES (?)').run(userId);
}

// 旧库兼容：users 表可能缺少 is_admin / role / email_verified 列（历史 db 文件不会自动加）
(function ensureColumns() {
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
    if (!cols.includes('is_admin')) {
      db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
    }
    if (!cols.includes('role')) {
      db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'regular'");
    }
    if (!cols.includes('email_verified')) {
      db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
    }
    // 由旧字段推导 role：is_admin → super_admin；否则 is_member → member；否则 regular
    db.exec("UPDATE users SET role='super_admin' WHERE is_admin=1 AND (role IS NULL OR role='regular')");
    db.exec("UPDATE users SET role='member' WHERE is_admin=0 AND is_member=1 AND (role IS NULL OR role='regular')");
  } catch (e) {
    console.warn('[db] 检查/添加列或推导 role 失败：', e.message);
  }
})();

// 功能权限配置（meta 表读写）
function getMeta(key, def) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    if (!row) return def;
    return JSON.parse(row.value);
  } catch (e) { return def; }
}
function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

// 旧库兼容：decl_ai_cache 曾用保留字 "values" 作列名，迁移为 val_json
try {
  const dc = db.prepare('PRAGMA table_info(decl_ai_cache)').all().map(r => r.name);
  if (dc.includes('values') && !dc.includes('val_json')) {
    db.exec('ALTER TABLE decl_ai_cache RENAME COLUMN "values" TO val_json');
    console.log('[db] 已迁移 decl_ai_cache.values → val_json');
  }
} catch (e) { console.warn('[db] 迁移 decl_ai_cache 失败：', e.message); }

// ---------- 申报要素 AI 预生成缓存读写 ----------
function getDeclCache(code) {
  try {
    const row = db.prepare('SELECT code, val_json, model, created_at FROM decl_ai_cache WHERE code=?').get(code);
    if (!row) return null;
    return { code: row.code, values: JSON.parse(row.val_json), model: row.model, createdAt: row.created_at };
  } catch (e) { return null; }
}
function setDeclCache(code, values, model) {
  db.prepare('INSERT INTO decl_ai_cache (code, val_json, model, created_at) VALUES (?,?,?,datetime(\'now\')) '
    + 'ON CONFLICT(code) DO UPDATE SET val_json=excluded.val_json, model=excluded.model, created_at=datetime(\'now\')')
    .run(code, JSON.stringify(values), model || '');
}
function countDeclCache() {
  try { return db.prepare('SELECT COUNT(*) AS n FROM decl_ai_cache').get().n; } catch (e) { return 0; }
}

module.exports = { db, ensureUserData, getMeta, setMeta, getDeclCache, setDeclCache, countDeclCache };
