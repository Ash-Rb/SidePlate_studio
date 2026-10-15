// Sideplate Studio local server. No dependencies: only Node's standard library.
// Serves the interface from public/ and the workspace files from SideplateStudio/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { HOME, p, HttpError, safeJoin, ensureDir, listDirs, listTrash, restoreTrash, readJSON, writeJSON, now } from './store.js';
import { loadRegistry, listModels, saveModel, checkModelUse, REGIONS } from './registry.js';
import {
  getWorkspace, updateWorkspace, listStyles, getStyle, saveStyle, addStyleRef, deleteStyleRef, DEFAULT_STYLES,
  listProjects, getProject, saveProject, setProjectLinks,
} from './workspace.js';
import {
  listAssets, getAsset, createAsset, updateAsset, addAttempt, starAttempt, castAttempt, setLook,
  updateVoice, addVoiceClip, addSceneFile, removeFile, CHARACTER_SLOTS, VOICE_CONSENT,
  approveLookVersion, rejectLookVersion, updateLookRights, updateAttemptRights,
} from './library.js';
import { auditLinks, auditProject, describeProblems } from './guard.js';
import { REVIEW_LABELS } from './rights.js';
import { createBackup, listBackups, verifyBackup, BACKUP_ROOT } from './backup.js';
import { listAudio, addAudio, updateAudio, deleteAudio } from './audio.js';
import {
  listJobs, getJob, createJob, createReferencePack, cancelJob, retryJob, completeManual, exportBundle, importResults,
  openJobsUsing,
} from './jobs.js';
import { CAPABILITIES, describeAdapters } from './adapters/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '127.0.0.1';
// Upload limits per kind of file. Uploads are streamed to a temp file on
// disk, never held whole in memory.
const LIMITS = {
  image: 50 * 1024 ** 2,
  audio: 500 * 1024 ** 2,
  scene: 2 * 1024 ** 3,
  results: 512 * 1024 ** 2, // results.zip is read into memory to be checked
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.zip': 'application/zip', '.ipynb': 'application/x-ipynb+json',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.txt': 'text/plain; charset=utf-8',
};

// ---------- first run ----------
export function initWorkspace() {
  for (const d of ['library/characters', 'library/sets', 'library/music', 'library/sfx', 'styles', 'projects', 'models', 'queue/jobs', 'queue/exports', 'queue/imports']) {
    ensureDir(p(d));
  }
  // Leftover temp uploads from a crash are safe to clear.
  fs.rmSync(p('.tmp-uploads'), { recursive: true, force: true });
  getWorkspace();
  loadRegistry();
  if (!listDirs(p('styles')).length) for (const s of DEFAULT_STYLES) saveStyle(s);
}

// ---------- tiny router ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler });
};

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Upload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function json(req) {
  const buf = await readBody(req, 5 * 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'Body is not valid JSON'); }
}

// Streams the request body to a temp file inside the workspace (so moving it
// into place later is a cheap rename). Deleted again if anything fails.
async function receive(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new HttpError(413, `Upload too large (limit ${Math.round(limit / 1024 ** 2)} MB)`);
  ensureDir(p('.tmp-uploads'));
  const tmp = p('.tmp-uploads', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  const out = fs.createWriteStream(tmp);
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, `Upload too large (limit ${Math.round(limit / 1024 ** 2)} MB)`);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  if (!size) { fs.rmSync(tmp, { force: true }); throw new HttpError(400, 'Empty upload'); }
  return { tmp, size };
}

// Uploads are sent as the raw file body, with ?filename= and an optional
// ?meta= JSON string. Only the listed meta keys are accepted.
const IMAGE_META = ['model', 'prompt', 'negative', 'seed', 'styleSlug', 'origin', 'rightsDeclared', 'evidence'];
async function upload(req, url, limit, allowedMeta) {
  const filename = url.searchParams.get('filename');
  if (!filename) throw new HttpError(400, 'Missing ?filename=');
  let meta = {};
  if (url.searchParams.get('meta')) {
    try { meta = JSON.parse(url.searchParams.get('meta')); } catch { throw new HttpError(400, 'Bad ?meta= JSON'); }
  }
  if (allowedMeta) meta = Object.fromEntries(Object.entries(meta || {}).filter(([k]) => allowedMeta.includes(k)));
  const { tmp, size } = await receive(req, limit);
  return { filename: path.basename(filename), tmp, size, meta };
}

// Runs a handler with an upload and always removes the temp file afterwards
// (if the handler moved it into place, there is nothing left to remove).
async function withUpload(req, url, limit, allowedMeta, fn) {
  const u = await upload(req, url, limit, allowedMeta);
  try { return await fn(u); } finally { fs.rmSync(u.tmp, { force: true }); }
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(data);
}

// ---------- API ----------
route('GET', '/api/state', () => ({
  workspace: getWorkspace(), home: HOME, regions: REGIONS,
  counts: {
    characters: listAssets('characters').length, sets: listAssets('sets').length,
    projects: listProjects().length, styles: listStyles().length,
    openJobs: listJobs({ status: 'open' }).length,
    music: listAudio('music').length, sfx: listAudio('sfx').length,
  },
  characterSlots: CHARACTER_SLOTS,
  reviewLabels: REVIEW_LABELS,
  voiceConsent: VOICE_CONSENT,
}));
route('PUT', '/api/workspace', async (req) => updateWorkspace(await json(req)));

route('GET', '/api/models', () => {
  const ws = getWorkspace();
  return listModels().map((m) => ({ ...m, guard: checkModelUse(m, { commercial: ws.libraryCommercial, region: ws.region }) }));
});
route('POST', '/api/models', async (req) => saveModel(await json(req)));
route('GET', '/api/capabilities', () => ({ capabilities: CAPABILITIES, adapters: describeAdapters() }));

route('GET', '/api/styles', () => listStyles());
route('POST', '/api/styles', async (req) => saveStyle(await json(req)));
route('GET', '/api/styles/:slug', (req, url, { slug }) => getStyle(slug));
route('PUT', '/api/styles/:slug', async (req, url, { slug }) => saveStyle(await json(req), slug));
route('POST', '/api/styles/:slug/refs', (req, url, { slug }) => withUpload(req, url, LIMITS.image, [], (u) => addStyleRef(slug, u.filename, fs.readFileSync(u.tmp))));
route('DELETE', '/api/styles/:slug/refs/:file', (req, url, { slug, file }) => deleteStyleRef(slug, file));

route('GET', '/api/projects', () => listProjects());
route('POST', '/api/projects', async (req) => saveProject(await json(req)));
route('GET', '/api/projects/:slug', (req, url, { slug }) => getProject(slug));
route('PUT', '/api/projects/:slug', async (req, url, { slug }) => {
  const input = await json(req);
  const prev = getProject(slug);
  // Turning a project commercial re-checks everything already linked to it.
  if (input.commercial === true && !prev.commercial) {
    const problems = auditProject(prev, true);
    if (problems.length) throw new HttpError(409, `Cannot make this project commercial yet. License guard: ${describeProblems(problems)}`);
  }
  return saveProject(input, slug);
});
route('GET', '/api/projects/:slug/audit', (req, url, { slug }) => {
  const proj = getProject(slug);
  return { commercial: proj.commercial, problems: auditProject(proj) };
});
route('PUT', '/api/projects/:slug/links/:kind', async (req, url, { slug, kind }) => {
  const { ids = [] } = await json(req);
  if (!['characters', 'sets', 'audio'].includes(kind)) throw new HttpError(400, 'Unknown link kind');
  const proj = getProject(slug);
  // License guard on linking. Fails closed: unknown models and unreviewed
  // rights are problems for a commercial project, never silently skipped.
  const problems = auditLinks(kind, ids.map(String), proj.commercial);
  if (problems.length) throw new HttpError(403, `License guard: ${describeProblems(problems)}`);
  return setProjectLinks(slug, kind, ids);
});

route('GET', '/api/library/:kind', (req, url, { kind }) => listAssets(kind));
route('POST', '/api/library/:kind', async (req, url, { kind }) => createAsset(kind, await json(req)));
route('GET', '/api/library/:kind/:slug', (req, url, { kind, slug }) => getAsset(kind, slug));
route('PUT', '/api/library/:kind/:slug', async (req, url, { kind, slug }) => updateAsset(kind, slug, await json(req)));
route('POST', '/api/library/:kind/:slug/attempts', (req, url, { kind, slug }) => withUpload(req, url, LIMITS.image, IMAGE_META,
  (u) => addAttempt(kind, slug, u.filename, u.tmp, { ...u.meta, source: 'upload' })));
route('PUT', '/api/library/:kind/:slug/attempts/:id/rights', async (req, url, { kind, slug, id }) => updateAttemptRights(kind, slug, id, await json(req)));
route('POST', '/api/library/:kind/:slug/attempts/:id/star', async (req, url, { kind, slug, id }) => starAttempt(kind, slug, id, (await json(req)).starred));
route('POST', '/api/library/:kind/:slug/cast', async (req, url, { kind, slug }) => castAttempt(kind, slug, (await json(req)).attemptId));
// Placing an image in a slot by hand makes it the approved one; the previous
// approved image is kept as an older version and can be restored.
route('POST', '/api/library/:kind/:slug/looks/:style/:slot', (req, url, { kind, slug, style, slot }) => withUpload(req, url, LIMITS.image, IMAGE_META,
  (u) => setLook(kind, slug, style, slot, u.filename, u.tmp, { ...u.meta, source: 'upload' }, { approve: true })));
route('POST', '/api/library/:kind/:slug/looks/:style/:slot/versions/:vid/approve', (req, url, { kind, slug, style, slot, vid }) => approveLookVersion(kind, slug, style, slot, vid));
route('POST', '/api/library/:kind/:slug/looks/:style/:slot/versions/:vid/reject', (req, url, { kind, slug, style, slot, vid }) => rejectLookVersion(kind, slug, style, slot, vid));
route('PUT', '/api/library/:kind/:slug/looks/:style/:slot/versions/:vid/rights', async (req, url, { kind, slug, style, slot, vid }) => updateLookRights(kind, slug, style, slot, vid, await json(req)));
route('POST', '/api/library/:kind/:slug/refpack', async (req, url, { kind, slug }) => {
  const b = await json(req);
  return createReferencePack({ kind, slug, styleSlug: b.styleSlug, model: b.model, slots: b.slots, projectSlug: b.projectSlug });
});
route('DELETE', '/api/library/:kind/:slug/files/:area/:file', (req, url, { kind, slug, area, file }) => removeFile(kind, slug, area, file, { openJobsFor: openJobsUsing }));
route('PUT', '/api/library/characters/:slug/voice', async (req, url, { slug }) => updateVoice(slug, await json(req)));
route('POST', '/api/library/characters/:slug/voice/clips', (req, url, { slug }) => withUpload(req, url, LIMITS.audio, ['label', 'kind', 'source', 'consent', 'evidence'],
  (u) => addVoiceClip(slug, u.filename, u.tmp, u.meta)));
route('POST', '/api/library/sets/:slug/scene', (req, url, { slug }) => withUpload(req, url, LIMITS.scene, [],
  (u) => addSceneFile(slug, u.filename, u.tmp)));

route('GET', '/api/audio/:kind', (req, url, { kind }) => listAudio(kind));
route('POST', '/api/audio/:kind', (req, url, { kind }) => withUpload(req, url, LIMITS.audio, ['title', 'license', 'licenseUrl', 'source', 'tags', 'use', 'notes', 'commercialOk', 'evidence'],
  (u) => addAudio(kind, u.filename, u.tmp, u.meta)));
route('PUT', '/api/audio/:kind/:id', async (req, url, { kind, id }) => updateAudio(kind, id, await json(req)));
route('DELETE', '/api/audio/:kind/:id', (req, url, { kind, id }) => deleteAudio(kind, id));

route('GET', '/api/jobs', (req, url) => listJobs({ status: url.searchParams.get('status') || undefined }));
route('POST', '/api/jobs', async (req) => createJob(await json(req)));
route('GET', '/api/jobs/:id', (req, url, { id }) => getJob(id));
route('POST', '/api/jobs/:id/cancel', (req, url, { id }) => cancelJob(id));
route('POST', '/api/jobs/:id/retry', (req, url, { id }) => retryJob(id));
route('POST', '/api/jobs/:id/upload', (req, url, { id }) => withUpload(req, url, LIMITS.image, [], (u) => completeManual(id, u.filename, u.tmp)));
route('POST', '/api/jobs/import', async (req, url) => importResults(await readBody(req, LIMITS.results), url.searchParams.get('adapter') || 'kaggle-bundle'));
route('POST', '/api/jobs/export', (req, url, params, res) => {
  const { bundleId, zip } = exportBundle(url.searchParams.get('adapter') || 'kaggle-bundle');
  res.writeHead(200, {
    'Content-Type': MIME['.zip'],
    'Content-Disposition': `attachment; filename="${bundleId}.zip"`,
    'Content-Length': zip.length,
    'Cache-Control': 'no-store',
  });
  res.end(zip);
  return undefined;
});

route('GET', '/api/trash', () => listTrash());
route('POST', '/api/trash/:id/restore', (req, url, { id }) => restoreTrash(id));
route('GET', '/api/backups', () => ({ folder: BACKUP_ROOT(), backups: listBackups() }));
route('POST', '/api/backups', () => createBackup());
route('POST', '/api/backups/:name/verify', (req, url, { name }) => verifyBackup(name));

// ---------- static files ----------
function serveFile(req, res, file, { download = false } = {}) {
  let stat;
  try { stat = fs.statSync(file); } catch { return send(res, 404, { error: 'Not found' }); }
  if (!stat.isFile()) return send(res, 404, { error: 'Not found' });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(file).pipe(res);
}

// Only answer requests addressed to this machine (blocks DNS-rebinding),
// and only accept changes from the studio's own page:
//  - the Host must be localhost / 127.0.0.1 / [::1];
//  - writes must carry the X-Sideplate header, which a web page on another
//    site cannot add without a CORS preflight this server never approves;
//  - if an Origin is sent, it must be this exact host and port.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
function trusted(req, port) {
  const hostHeader = String(req.headers.host || '');
  const m = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/.exec(hostHeader);
  if (!m) return false;
  if (m[2] && Number(m[2]) !== port) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  if (req.headers['x-sideplate'] !== '1') return false;
  const origin = req.headers.origin;
  if (origin) {
    let o;
    try { o = new URL(origin); } catch { return false; }
    if (!LOCAL_HOSTS.includes(o.hostname) || Number(o.port || 80) !== port) return false;
  }
  return true;
}

// Workspace files served to the browser: media and 3D files only. JSON
// sidecars, the registry and job files are never served raw (the API serves
// what the interface needs). Symlinks pointing outside the workspace are refused.
const SERVABLE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.wav', '.mp3', '.ogg', '.flac', '.m4a', '.glb', '.gltf', '.blend', '.fbx', '.obj', '.ply', '.spz']);
function workspaceFile(rel) {
  const file = safeJoin(HOME, ...rel);
  if (!SERVABLE.has(path.extname(file).toLowerCase())) throw new HttpError(404, 'Not found');
  let real;
  try { real = fs.realpathSync(file); } catch { throw new HttpError(404, 'Not found'); }
  const home = fs.realpathSync(HOME);
  if (real !== home && !real.startsWith(home + path.sep)) throw new HttpError(404, 'Not found');
  if (rel.some((part) => part.startsWith('.'))) throw new HttpError(404, 'Not found');
  return real;
}

export function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!trusted(req, server.address()?.port)) return send(res, 403, { error: 'Sideplate Studio only answers requests from its own page on this computer' });
      if (url.pathname.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const out = await r.handler(req, url, params, res);
          if (out !== undefined) send(res, 200, out);
          return;
        }
        return send(res, 404, { error: `No API route for ${req.method} ${url.pathname}` });
      }
      if (url.pathname.startsWith('/files/')) {
        const rel = url.pathname.slice('/files/'.length).split('/').map(decodeURIComponent);
        return serveFile(req, res, workspaceFile(rel));
      }
      if (url.pathname === '/worker/sideplate_worker.ipynb') {
        return serveFile(req, res, path.join(ROOT, 'worker', 'sideplate_worker.ipynb'), { download: true });
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = safeJoin(PUBLIC, ...rel.split('/').map(decodeURIComponent));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(req, res, file);
      return serveFile(req, res, path.join(PUBLIC, 'index.html'));
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: err.message || 'Something went wrong' });
      else res.end();
    }
  });
  return server;
}

// One studio per workspace: two copies writing the same folders could
// overwrite each other's changes.
function takeLock() {
  const lock = p('.studio.lock');
  const held = readJSON(lock);
  if (held?.pid && held.pid !== process.pid) {
    let alive = false;
    try { process.kill(held.pid, 0); alive = true; } catch (err) { alive = err.code === 'EPERM'; }
    if (alive) {
      console.error(`\n  Sideplate Studio is already running for this folder (process ${held.pid}).`);
      console.error('  Use that window, or close it first.\n');
      process.exit(1);
    }
  }
  writeJSON(lock, { pid: process.pid, startedAt: now() });
  const release = () => { try { if (readJSON(lock)?.pid === process.pid) fs.rmSync(lock, { force: true }); } catch { /* ignore */ } };
  process.on('exit', release);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* open it by hand */ }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  initWorkspace();
  takeLock();
  createServer().listen(PORT, HOST, () => {
    console.log('');
    console.log('  Sideplate Studio is running.');
    console.log(`  Open:      http://localhost:${PORT}`);
    console.log(`  Your data: ${HOME}`);
    console.log('  Stop:      press Ctrl+C');
    console.log('');
    if (!process.env.NO_OPEN) openBrowser(`http://localhost:${PORT}`);
  });
  process.on('SIGINT', () => { console.log('\n  Sideplate Studio stopped. Your work is saved.'); process.exit(0); });
}
