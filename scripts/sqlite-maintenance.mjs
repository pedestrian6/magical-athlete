import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, lstatSync, chmodSync, renameSync, rmSync, mkdirSync, writeFileSync, readFileSync, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';

// This helper is called by online-ops.sh in an isolated maintenance container.
const dataDir = resolve(process.env.DATA_DIR ?? '/app/data');
const backupDir = resolve(process.env.BACKUP_DIR ?? '/app/backups');
const livePath = join(dataDir, 'rooms.sqlite');
const [operation, name] = process.argv.slice(2);

async function sha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

function fileName(value) {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.sqlite$/.test(value)) {
    throw new Error('备份名必须是以 .sqlite 结尾的普通文件名，不接受路径。');
  }
  return join(backupDir, value);
}

function openChecked(path) {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error('数据库文件不存在或不是普通文件。');
  }
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000;');
  const results = db.prepare('PRAGMA integrity_check').all();
  if (results.length !== 1 || Object.values(results[0])[0] !== 'ok') {
    db.close();
    throw new Error('数据库完整性检查未通过，停止操作。');
  }
  return db;
}

async function makeBackup(source, target) {
  if (existsSync(target) || existsSync(`${target}.json`)) throw new Error('目标备份已存在，拒绝覆盖。');
  const staged = `${target}.partial-${randomUUID()}`;
  const db = openChecked(source);
  try {
    await backup(db, staged);
    const checked = openChecked(staged);
    checked.close();
    chmodSync(staged, 0o600);
    renameSync(staged, target);
    const checksum = await sha256(target);
    writeFileSync(`${target}.json`, JSON.stringify({ format: 'magical-athlete-sqlite-backup-v1', createdAt: new Date().toISOString(), sha256: checksum }, null, 2), { flag: 'wx', mode: 0o600 });
  } finally {
    db.close();
    rmSync(staged, { force: true });
  }
}

try {
  if (!['backup', 'restore', 'verify'].includes(operation)) throw new Error('用法：sqlite-maintenance.mjs backup|verify|restore FILE.sqlite');
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const selected = fileName(name);
  if (operation === 'backup') {
    await makeBackup(livePath, selected);
    console.log(JSON.stringify({ status: 'backed_up', file: name }));
  } else {
    const db = openChecked(selected);
    db.close();
    if (existsSync(`${selected}.json`)) {
      const metadata = JSON.parse(readFileSync(`${selected}.json`, 'utf8'));
      const checksum = await sha256(selected);
      if (metadata.format !== 'magical-athlete-sqlite-backup-v1' || metadata.sha256 !== checksum) throw new Error('备份元数据或 SHA-256 不匹配。');
    }
    if (operation === 'verify') {
      console.log(JSON.stringify({ status: 'verified', file: name }));
    } else {
      if (process.env.GAME_STOPPED_FOR_RESTORE !== 'yes') throw new Error('恢复必须由 online-ops.sh 停止游戏服务后执行。');
      const rollbackName = `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`;
      if (existsSync(livePath)) await makeBackup(livePath, join(backupDir, rollbackName));
      const staged = join(dataDir, `.restoring-${randomUUID()}.sqlite`);
      const source = openChecked(selected);
      try {
        await backup(source, staged);
        chmodSync(staged, 0o600);
        const checked = openChecked(staged);
        checked.close();
        // The game service is stopped. Its old WAL belongs to the old database.
        rmSync(`${livePath}-wal`, { force: true });
        rmSync(`${livePath}-shm`, { force: true });
        renameSync(staged, livePath);
      } finally {
        source.close();
        rmSync(staged, { force: true });
      }
      console.log(JSON.stringify({ status: 'restored', file: name, previousBackup: existsSync(join(backupDir, rollbackName)) ? rollbackName : null }));
    }
  }
} catch (error) {
  console.error(`数据库维护失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
