// Folder + JSON sidecar storage. The folders on disk are the source of truth:
// nothing is kept in the browser or in a database.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = path.resolve(process.env.SIDEPLATE_HOME || path.join(process.cwd(), 'SideplateStudio'));

export function p(...parts) {
  return safeJoin(HOME, ...parts);
}

// Join paths and refuse anything that escapes the base folder.
export function safeJoin(base, ...parts) {
  const full = path.resolve(base, ...parts.map(String));
  const rel = path.relative(base, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new HttpError(400, 'Path escapes the workspace');
  }
  return full;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function slugify(name) {
  const s = String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'untitled';
}

export function assertSlug(slug) {
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(String(slug))) throw new HttpError(400, `Invalid name: ${slug}`);
  return slug;
}

export function newId(prefix = '') {
  const t = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${prefix}${t}-${crypto.randomBytes(3).toString('hex')}`;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function exists(file) {
  return fs.existsSync(file);
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${file}: ${err.message}`);
  }
}

// Test hooks: lets tests simulate a failed write. Never set in normal use.
export const testHooks = { beforeWrite: null };

// Replace-by-rename write: the new content is written to a uniquely named
// temp file, flushed to disk (fsync), then renamed over the target. A crash
// mid-save leaves either the old file or the new one, not a half-written one.
// This protects single files; it is not a backup (see backup.js) and cannot
// prevent conflicts from a cloud-sync app editing the same folder.
function atomicWrite(file, content) {
  ensureDir(path.dirname(file));
  testHooks.beforeWrite?.(file);
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function writeJSON(file, data) {
  atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
  return data;
}

export function writeFile(file, buffer) {
  atomicWrite(file, buffer);
  return file;
}

// Move a file that is already on disk (e.g. a streamed upload) into place.
export function moveFile(src, dest) {
  ensureDir(path.dirname(dest));
  testHooks.beforeWrite?.(dest);
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
  return dest;
}

// Recoverable delete: files go to SideplateStudio/.trash with a note of where
// they came from, and can be restored from Settings. Pass several paths to
// keep a file and its sidecar together as one trash item.
export function trashFile(paths, reason = '') {
  const list = [].concat(paths).filter((f) => fs.existsSync(f));
  if (!list.length) return null;
  const id = newId('trash-');
  const dir = p('.trash', id);
  ensureDir(dir);
  const items = list.map((abs, i) => {
    const stored = `${i}-${path.basename(abs)}`;
    moveFile(abs, path.join(dir, stored));
    return { stored, originalPath: path.relative(HOME, abs) };
  });
  writeJSON(path.join(dir, 'trash.json'), {
    id, name: path.basename(list[0]), items, deletedAt: now(), reason,
  });
  return id;
}

export function listTrash() {
  return listDirsAll(p('.trash'))
    .map((id) => readJSON(p('.trash', id, 'trash.json')))
    .filter(Boolean)
    .sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
}

export function restoreTrash(id) {
  if (!/^trash-[a-z0-9-]+$/i.test(id)) throw new HttpError(400, 'Bad trash id');
  const rec = readJSON(p('.trash', id, 'trash.json'));
  if (!rec) throw new HttpError(404, 'Nothing in the trash with that id');
  const targets = rec.items.map((it) => ({ ...it, dest: p(...it.originalPath.split(/[\\/]/)) }));
  const clash = targets.find((t) => fs.existsSync(t.dest));
  if (clash) throw new HttpError(409, `Cannot restore: ${clash.originalPath} exists again. Move it aside first.`);
  for (const t of targets) moveFile(p('.trash', id, t.stored), t.dest);
  fs.rmSync(p('.trash', id), { recursive: true, force: true });
  return rec;
}

function listDirsAll(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

export function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

export function listFiles(dir, filter = () => true) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.') && !d.name.endsWith('.tmp') && filter(d.name))
    .map((d) => d.name)
    .sort();
}

// Path of a workspace file as the browser should request it.
export function fileUrl(absPath) {
  const rel = path.relative(HOME, absPath).split(path.sep).map(encodeURIComponent).join('/');
  return `/files/${rel}`;
}

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
export const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a']);
export const SCENE_EXT = new Set(['.blend', '.glb', '.gltf', '.fbx', '.obj', '.ply', '.spz']);

export function extOf(filename, allowed) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (allowed && !allowed.has(ext)) {
    throw new HttpError(400, `File type ${ext || '(none)'} is not allowed here. Allowed: ${[...allowed].join(', ')}`);
  }
  return ext;
}

export function now() {
  return new Date().toISOString();
}
