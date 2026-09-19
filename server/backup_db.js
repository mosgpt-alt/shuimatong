/* __BACKUP_DB_V1__ 正确的 SQLite 备份
   数据库是 WAL 模式，最新写入可能还在 zhiguantong.db-wal 里。
   直接拷 zhiguantong.db 会丢数据 —— VACUUM INTO 产出的是单文件一致性快照。 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, 'data');
const src = path.join(dataDir, 'zhiguantong.db');
if (!fs.existsSync(src)) {
  console.error('[备份] 找不到数据库：' + src);
  console.error('[备份] 后端至少启动过一次才会生成。');
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const out = path.join(dataDir, 'backup_' + stamp + '.db');
const db = new DatabaseSync(src);
db.exec("VACUUM INTO '" + out.replace(/\\/g, '/').replace(/'/g, "''") + "'");
db.close();
console.log('[备份] 完成 → ' + out);
console.log('[备份]         ' + (fs.statSync(out).size / 1048576).toFixed(2) + ' MB，单文件快照，可直接拷走');
