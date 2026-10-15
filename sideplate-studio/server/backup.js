// One-click backups: a full copy of the workspace folder next to it, in
// <workspace>-backups/<date-time>/, with a manifest of every file and its size
// so the copy can be verified later. Restoring is a manual, documented step
// (see README) so nothing is ever overwritten automatically.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, HttpError, now, readJSON, writeJSON } from './store.js';

export const BACKUP_ROOT = () => `${HOME}-backups`;
const SKIP = new Set(['.tmp-uploads', '.studio.lock']);

function walk(dir, base = dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(d.name) || d.name.endsWith('.tmp')) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) walk(full, base, out);
    else if (d.isFile()) out.push({ path: path.relative(base, full).split(path.sep).join('/'), size: fs.statSync(full).size });
  }
  return out;
}

export function createBackup() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const dest = path.join(BACKUP_ROOT(), stamp);
  if (fs.existsSync(dest)) throw new HttpError(409, 'A backup was made this second already');
  fs.mkdirSync(dest, { recursive: true });
  const files = walk(HOME);
  for (const f of files) {
    const target = path.join(dest, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(HOME, f.path), target);
  }
  const manifest = {
    createdAt: now(), source: HOME, fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + f.size, 0), files,
  };
  writeJSON(path.join(dest, 'backup-manifest.json'), manifest);
  return { name: stamp, path: dest, ...verifyBackup(stamp) };
}

export function listBackups() {
  if (!fs.existsSync(BACKUP_ROOT())) return [];
  return fs.readdirSync(BACKUP_ROOT(), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const m = readJSON(path.join(BACKUP_ROOT(), d.name, 'backup-manifest.json'));
      return m ? { name: d.name, path: path.join(BACKUP_ROOT(), d.name), createdAt: m.createdAt, fileCount: m.fileCount, totalBytes: m.totalBytes } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

// Checks every file listed in the manifest is present with the right size.
export function verifyBackup(name) {
  if (!/^\d{8}-\d{6}$/.test(name)) throw new HttpError(400, 'Bad backup name');
  const dir = path.join(BACKUP_ROOT(), name);
  const m = readJSON(path.join(dir, 'backup-manifest.json'));
  if (!m) throw new HttpError(404, 'No backup with that name (or its manifest is missing)');
  const problems = [];
  for (const f of m.files) {
    const full = path.join(dir, f.path);
    if (!fs.existsSync(full)) problems.push(`missing: ${f.path}`);
    else if (fs.statSync(full).size !== f.size) problems.push(`size differs: ${f.path}`);
  }
  return { verified: problems.length === 0, checked: m.files.length, problems: problems.slice(0, 50) };
}
