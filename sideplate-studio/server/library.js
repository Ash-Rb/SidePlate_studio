// The library: characters (cast) and sets, with generation history,
// a cast winner, and per-style looks (reference packs / plates).
import fs from 'node:fs';
import path from 'node:path';
import {
  p, readJSON, writeJSON, writeFile, moveFile, trashFile, listDirs, listFiles, slugify, assertSlug, newId,
  HttpError, now, fileUrl, extOf, IMAGE_EXT, AUDIO_EXT, SCENE_EXT, exists, ensureDir,
} from './store.js';
import { getModel, findModel, assertModelUse } from './registry.js';
import { getWorkspace, getStyle } from './workspace.js';
import { rightsForImage, effectiveRights, updatedRights } from './rights.js';

// Accepts either a Buffer or the path of a streamed upload on disk.
function place(src, dest) {
  return Buffer.isBuffer(src) ? writeFile(dest, src) : moveFile(src, dest);
}

// Refuse files that only pretend to be images (checks the first bytes).
export function assertImageContent(src) {
  let head;
  if (Buffer.isBuffer(src)) head = src.subarray(0, 12);
  else {
    const fd = fs.openSync(src, 'r');
    head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    fs.closeSync(fd);
  }
  const png = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const webp = head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
  if (!png && !jpg && !webp) throw new HttpError(400, 'That file is not a PNG, JPEG or WebP image');
}

export const CHARACTER_SLOTS = [
  { id: 'front', label: 'Front', prompt: 'front view, standing, full head and shoulders, neutral expression, plain background' },
  { id: 'three-quarter', label: 'Three-quarter', prompt: 'three-quarter view, upper body, neutral expression, plain background' },
  { id: 'side', label: 'Side', prompt: 'side profile view, upper body, neutral expression, plain background' },
  { id: 'full-body', label: 'Full body', prompt: 'full body, standing pose, whole outfit visible, plain background' },
  { id: 'expr-happy', label: 'Happy', prompt: 'close-up portrait, big happy smile, plain background' },
  { id: 'expr-angry', label: 'Angry', prompt: 'close-up portrait, angry expression, furrowed brows, plain background' },
  { id: 'expr-surprised', label: 'Surprised', prompt: 'close-up portrait, surprised expression, plain background' },
  { id: 'expr-sad', label: 'Sad', prompt: 'close-up portrait, sad expression, plain background' },
];

const BIBLE_FIELDS = ['personality', 'backstory', 'speech', 'catchphrases', 'relationships', 'wardrobe'];

export const KINDS = {
  characters: { dir: 'characters', meta: 'identity.json', label: 'character' },
  sets: { dir: 'sets', meta: 'set.json', label: 'set' },
};

function kindOf(kind) {
  const k = KINDS[kind];
  if (!k) throw new HttpError(404, `Unknown library section: ${kind}`);
  return k;
}

const assetDir = (kind, slug) => p('library', kindOf(kind).dir, assertSlug(slug));
const metaFile = (kind, slug) => `${assetDir(kind, slug)}/${kindOf(kind).meta}`;

function readMeta(kind, slug) {
  const m = readJSON(metaFile(kind, slug));
  if (!m) throw new HttpError(404, `No ${kindOf(kind).label} called ${slug}`);
  return m;
}

// ---------- history (every attempt is kept) ----------
function listAttempts(kind, slug) {
  const dir = `${assetDir(kind, slug)}/history`;
  return listFiles(dir, (f) => f.endsWith('.json'))
    .map((f) => readJSON(`${dir}/${f}`))
    .filter(Boolean)
    .map((a) => ({ ...a, rights: effectiveRights(a), url: fileUrl(`${dir}/${a.file}`) }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function getAttempt(kind, slug, id) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new HttpError(400, 'Bad attempt id');
  const a = readJSON(`${assetDir(kind, slug)}/history/${id}.json`);
  if (!a) throw new HttpError(404, 'No such attempt');
  return a;
}

// ---------- looks (per art style) ----------
// Removing a camera or a lighting variant that still has plates would silently
// disconnect them, so it is refused with an explanation instead.
function assertNoOrphanedPlates(slug, meta, nextCameras) {
  const { looks } = readLooks('sets', slug);
  const nextSlots = new Set(slotsFor('sets', { cameras: nextCameras }).map((s) => s.id));
  const lost = [];
  for (const [style, slots] of Object.entries(looks)) {
    for (const slotId of Object.keys(slots)) if (!nextSlots.has(slotId)) lost.push(`${slotId} (${style})`);
  }
  if (lost.length) {
    throw new HttpError(409, `These plates would be disconnected: ${lost.join(', ')}. Renaming a camera is fine; to remove a camera or rename a lighting variant, delete its plates first.`);
  }
}

function slotsFor(kind, meta) {
  if (kind === 'characters') return CHARACTER_SLOTS;
  const cams = meta.cameras || [];
  const out = [];
  for (const c of cams) for (const v of c.variants?.length ? c.variants : ['default']) {
    out.push({ id: `${c.id}--${slugify(v)}`, label: `${c.name} · ${v}`, prompt: `${c.prompt || c.name}, ${v} lighting`, camera: c.id, variant: v });
  }
  return out;
}

// look.json (version 2): every image ever placed in a slot is kept as an
// immutable version file; `current` points at the approved one. New results
// for a slot that already has an approved image arrive as candidates and
// never replace it until you approve them. Version-1 files (one record per
// slot) are read as a slot with a single approved version, without moving files.
function readLookIndex(dir, styleSlug) {
  const raw = readJSON(`${dir}/look.json`, null);
  if (!raw) return { style: styleSlug, version: 2, slots: {} };
  if (raw.version === 2) return raw;
  const slots = {};
  for (const [slotId, rec] of Object.entries(raw.slots || {})) {
    const id = 'v-legacy';
    slots[slotId] = { current: id, versions: [{ ...rec, id, status: 'approved' }] };
  }
  return { style: raw.style || styleSlug, version: 2, slots, migratedFrom: 1 };
}

function withUrl(dir, v) {
  return { ...v, rights: effectiveRights(v), url: fileUrl(`${dir}/${v.file}`), missing: !exists(`${dir}/${v.file}`) };
}

function readLooks(kind, slug) {
  const base = `${assetDir(kind, slug)}/looks`;
  const looks = {};
  const lookVersions = {};
  for (const style of listDirs(base)) {
    const dir = `${base}/${style}`;
    const index = readLookIndex(dir, style);
    const slots = {};
    const versions = {};
    for (const [slotId, entry] of Object.entries(index.slots || {})) {
      const all = (entry.versions || []).map((v) => withUrl(dir, v));
      const cur = all.find((v) => v.id === entry.current && !v.missing);
      if (cur) slots[slotId] = cur;
      versions[slotId] = all.filter((v) => v.id !== entry.current && v.status !== 'rejected' && !v.missing)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }
    looks[style] = slots;
    lookVersions[style] = versions;
  }
  return { looks, lookVersions };
}

// ---------- public API ----------
export function listAssets(kind) {
  const k = kindOf(kind);
  return listDirs(p('library', k.dir)).map((slug) => {
    const meta = readJSON(metaFile(kind, slug));
    if (!meta) return null;
    let thumb = null;
    if (meta.castAttemptId) {
      const a = readJSON(`${assetDir(kind, slug)}/history/${meta.castAttemptId}.json`);
      if (a) thumb = fileUrl(`${assetDir(kind, slug)}/history/${a.file}`);
    }
    const attempts = listFiles(`${assetDir(kind, slug)}/history`, (f) => f.endsWith('.json')).length;
    return { slug, name: meta.name, role: meta.role, status: meta.status, description: meta.description, thumb, attempts, updatedAt: meta.updatedAt };
  }).filter(Boolean);
}

export function getAsset(kind, slug) {
  const meta = readMeta(kind, slug);
  const dir = assetDir(kind, slug);
  const { looks, lookVersions } = readLooks(kind, slug);
  const out = { kind, ...meta, attempts: listAttempts(kind, slug), looks, lookVersions, slots: slotsFor(kind, meta) };
  if (kind === 'characters') {
    out.voice = readJSON(`${dir}/voice/profile.json`, defaultVoice());
    out.voice.clips = listFiles(`${dir}/voice/clips`, (f) => AUDIO_EXT.has(path.extname(f).toLowerCase()) )
      .map((f) => ({ file: f, url: fileUrl(`${dir}/voice/clips/${f}`), ...(readJSON(`${dir}/voice/clips/${f}.json`, {})) }));
  }
  if (kind === 'sets') {
    out.sceneFiles = listFiles(`${dir}/scene`, (f) => SCENE_EXT.has(path.extname(f).toLowerCase()))
      .map((f) => ({
        file: f, url: fileUrl(`${dir}/scene/${f}`), size: fs.statSync(`${dir}/scene/${f}`).size,
        previousVersions: listFiles(`${dir}/scene/versions`, (v) => v.startsWith(`${f}.`)).length,
      }));
  }
  return out;
}

function defaultVoice() {
  return { mode: 'mix', ttsProvider: '', ttsVoiceId: '', filterNotes: '', settings: {}, notes: '' };
}

export function createAsset(kind, input) {
  const name = String(input.name || '').trim();
  if (!name) throw new HttpError(400, 'A name is needed');
  const slug = slugify(name);
  if (exists(metaFile(kind, slug))) throw new HttpError(409, `"${name}" already exists`);
  const base = { slug, name, createdAt: now(), updatedAt: now(), castAttemptId: null, visual: '' };
  const meta = kind === 'characters'
    ? { ...base, role: '', status: 'recurring', episodes: [], bible: Object.fromEntries(BIBLE_FIELDS.map((f) => [f, ''])) }
    : { ...base, description: '', cameras: [] };
  writeJSON(metaFile(kind, slug), meta);
  return updateAsset(kind, slug, input);
}

export function updateAsset(kind, slug, input) {
  const meta = readMeta(kind, slug);
  if (input.name !== undefined && String(input.name).trim()) meta.name = String(input.name).trim().slice(0, 80);
  if (input.visual !== undefined) meta.visual = String(input.visual).slice(0, 2000);
  if (kind === 'characters') {
    if (input.role !== undefined) meta.role = String(input.role).slice(0, 120);
    if (input.status !== undefined) {
      if (!['recurring', 'guest'].includes(input.status)) throw new HttpError(400, 'Status must be recurring or guest');
      meta.status = input.status;
    }
    if (input.episodes !== undefined) {
      meta.episodes = [].concat(input.episodes).map((e) => String(e).trim().toUpperCase()).filter((e) => /^S\d{2}E\d{2}$/.test(e));
    }
    if (input.bible) for (const f of BIBLE_FIELDS) if (input.bible[f] !== undefined) meta.bible[f] = String(input.bible[f]).slice(0, 4000);
  } else {
    if (input.description !== undefined) meta.description = String(input.description).slice(0, 4000);
    if (input.cameras !== undefined) {
      const next = cleanCameras(input.cameras, meta.cameras || []);
      assertNoOrphanedPlates(slug, meta, next);
      meta.cameras = next;
    }
  }
  meta.updatedAt = now();
  writeJSON(metaFile(kind, slug), meta);
  // set.json is the single source of truth for cameras. cameras.json is a
  // read-only copy for other tools (e.g. a Blender script); the studio never reads it.
  if (kind === 'sets') {
    writeJSON(`${assetDir(kind, slug)}/cameras.json`, {
      generatedFrom: 'set.json', note: 'Read-only copy. Edit cameras in Sideplate Studio.', cameras: meta.cameras,
    });
  }
  return getAsset(kind, slug);
}

// Camera ids are stable: renaming a camera keeps its id, so its plates stay
// connected. A new camera gets an id from its name, unique within the set.
function cleanCameras(cams, previous) {
  const known = new Set(previous.map((c) => c.id));
  const used = new Set();
  const rows = [].concat(cams)
    .map((c) => ({ c, name: String(c?.name || '').trim().slice(0, 60) }))
    .filter((r) => r.name);
  for (const r of rows) {
    const id = String(r.c.id || '');
    if (id && known.has(id) && !used.has(id)) { r.id = id; used.add(id); }
  }
  for (const r of rows) {
    if (r.id) continue;
    const base = slugify(r.name);
    let id = base;
    for (let n = 2; used.has(id) || known.has(id); n++) id = `${base}-${n}`;
    r.id = id;
    used.add(id);
  }
  return rows.map(({ c, name, id }) => {
    return {
      id, name,
      prompt: String(c.prompt || '').slice(0, 500),
      variants: [].concat(c.variants || []).map((v) => String(v).trim()).filter(Boolean).slice(0, 6),
      lens: String(c.lens || '').slice(0, 40),
      notes: String(c.notes || '').slice(0, 500),
    };
  });
}

// Record of where an image came from. Checked by the license guard.
function provenance(record) {
  const model = getModel(record.model);
  const ws = getWorkspace();
  assertModelUse(model, { commercial: record.commercial ?? ws.libraryCommercial, region: ws.region });
  const source = record.source || 'upload';
  return {
    model: model.id,
    modelLabel: model.label,
    modelVersion: model.version || '',
    license: model.license,
    licenseUrl: model.licenseUrl || '',
    licenseCheckedAt: model.licenseCheckedAt || '',
    commercial: model.commercial,
    rights: rightsForImage({ model, source, meta: record }),
    prompt: String(record.prompt || '').slice(0, 4000),
    negative: String(record.negative || '').slice(0, 2000),
    seed: record.seed ?? null,
    styleSlug: record.styleSlug || null,
    jobId: record.jobId || null,
    source: record.source || 'upload',
    createdAt: now(),
  };
}

export function addAttempt(kind, slug, filename, src, record) {
  readMeta(kind, slug);
  const ext = extOf(filename, IMAGE_EXT);
  assertImageContent(src);
  const id = newId('att-');
  const attempt = { id, file: `${id}${ext}`, starred: false, ...provenance(record) };
  place(src, `${assetDir(kind, slug)}/history/${attempt.file}`);
  writeJSON(`${assetDir(kind, slug)}/history/${id}.json`, attempt);
  return attempt;
}

export function updateAttemptRights(kind, slug, id, input) {
  const a = getAttempt(kind, slug, id);
  a.rights = updatedRights(effectiveRights(a), input);
  writeJSON(`${assetDir(kind, slug)}/history/${id}.json`, a);
  return { ...a, rights: a.rights };
}

export function starAttempt(kind, slug, id, starred) {
  const a = getAttempt(kind, slug, id);
  a.starred = Boolean(starred);
  writeJSON(`${assetDir(kind, slug)}/history/${id}.json`, a);
  return a;
}

export function castAttempt(kind, slug, id) {
  const meta = readMeta(kind, slug);
  const a = getAttempt(kind, slug, id);
  meta.castAttemptId = a.id;
  meta.updatedAt = now();
  writeJSON(metaFile(kind, slug), meta);
  if (!a.starred) starAttempt(kind, slug, id, true);
  return getAsset(kind, slug);
}

export function castImagePath(kind, slug) {
  const meta = readMeta(kind, slug);
  if (!meta.castAttemptId) return null;
  const a = getAttempt(kind, slug, meta.castAttemptId);
  return `${assetDir(kind, slug)}/history/${a.file}`;
}

// Adds a new version to a slot. Existing files are never overwritten or deleted:
// the image is written to its own new file first, and only then is look.json
// updated (atomically). If the write fails, the slot is exactly as it was.
//   - empty slot: the new image becomes the approved one
//   - slot with an approved image: the new image is a candidate, unless
//     `approve` is true (you placed it there by hand on purpose)
export function setLook(kind, slug, styleSlug, slotId, filename, src, record, { approve = false } = {}) {
  const meta = readMeta(kind, slug);
  getStyle(styleSlug);
  const slot = slotsFor(kind, meta).find((s) => s.id === slotId);
  if (!slot) throw new HttpError(400, `Unknown slot ${slotId}`);
  const ext = extOf(filename, IMAGE_EXT);
  assertImageContent(src);
  const dir = `${assetDir(kind, slug)}/looks/${assertSlug(styleSlug)}`;
  const prov = provenance({ ...record, styleSlug });
  const id = newId('v-');
  const file = `${slotId}/${id}${ext}`;
  place(src, `${dir}/${file}`);

  const index = readLookIndex(dir, styleSlug);
  const entry = index.slots[slotId] || { current: null, versions: [] };
  const hasCurrent = entry.versions.some((v) => v.id === entry.current && exists(`${dir}/${v.file}`));
  const makeCurrent = approve || !hasCurrent;
  const version = { id, file, slot: slotId, label: slot.label, status: makeCurrent ? 'approved' : 'candidate', ...prov };
  if (makeCurrent) {
    for (const v of entry.versions) if (v.id === entry.current) v.status = 'superseded';
    entry.current = id;
  }
  entry.versions.push(version);
  index.slots[slotId] = entry;
  index.version = 2;
  index.updatedAt = now();
  writeJSON(`${dir}/look.json`, index);
  return { ...version, url: fileUrl(`${dir}/${file}`), becameCurrent: makeCurrent };
}

function lookEntry(kind, slug, styleSlug, slotId, versionId) {
  readMeta(kind, slug);
  const dir = `${assetDir(kind, slug)}/looks/${assertSlug(styleSlug)}`;
  const index = readLookIndex(dir, styleSlug);
  const entry = index.slots[slotId];
  const version = entry?.versions.find((v) => v.id === versionId);
  if (!version) throw new HttpError(404, 'No such version in this slot');
  return { dir, index, entry, version };
}

// Make a candidate (or an older version) the approved image for the slot.
export function approveLookVersion(kind, slug, styleSlug, slotId, versionId) {
  const { dir, index, entry, version } = lookEntry(kind, slug, styleSlug, slotId, versionId);
  if (!exists(`${dir}/${version.file}`)) throw new HttpError(409, 'That image file is missing');
  for (const v of entry.versions) if (v.id === entry.current) v.status = 'superseded';
  version.status = 'approved';
  entry.current = version.id;
  index.updatedAt = now();
  writeJSON(`${dir}/look.json`, index);
  return getAsset(kind, slug);
}

// Reject a candidate: it is hidden from the slot and its file goes to the trash.
export function rejectLookVersion(kind, slug, styleSlug, slotId, versionId) {
  const { dir, index, entry, version } = lookEntry(kind, slug, styleSlug, slotId, versionId);
  if (entry.current === versionId) throw new HttpError(409, 'This is the approved image. Approve another version first.');
  version.status = 'rejected';
  version.trashId = trashFile(`${dir}/${version.file}`, `Rejected ${slotId} version`);
  index.updatedAt = now();
  writeJSON(`${dir}/look.json`, index);
  return getAsset(kind, slug);
}

export function updateLookRights(kind, slug, styleSlug, slotId, versionId, input) {
  const { dir, index, version } = lookEntry(kind, slug, styleSlug, slotId, versionId);
  version.rights = updatedRights(effectiveRights(version), input);
  writeJSON(`${dir}/look.json`, index);
  return getAsset(kind, slug);
}

export function slotPrompt(kind, slug, slotId) {
  const meta = readMeta(kind, slug);
  const slot = slotsFor(kind, meta).find((s) => s.id === slotId);
  if (!slot) throw new HttpError(400, `Unknown slot ${slotId}`);
  return slot;
}

export function slotsOf(kind, slug) {
  return slotsFor(kind, readMeta(kind, slug));
}

// Every image of this asset that a project would actually use: the cast
// winner and the approved image of each look slot. Used by the license guard.
export function assetImageRecords(kind, slug) {
  const asset = getAsset(kind, slug);
  const out = [];
  const cast = asset.attempts.find((a) => a.id === asset.castAttemptId);
  if (cast) out.push({ where: kind === 'characters' ? 'cast image' : 'concept image', record: cast });
  for (const [style, slots] of Object.entries(asset.looks)) {
    for (const [slotId, rec] of Object.entries(slots)) out.push({ where: `${slotId} (${style})`, record: rec });
  }
  return { asset, images: out };
}

// Used by the guard to explain a model that is missing from the registry.
export function modelOf(record) {
  return findModel(record.model);
}

// ---------- characters: voice ----------
export function updateVoice(slug, input) {
  readMeta('characters', slug);
  const file = `${assetDir('characters', slug)}/voice/profile.json`;
  const v = readJSON(file, defaultVoice());
  for (const k of ['ttsProvider', 'ttsVoiceId', 'filterNotes', 'notes']) if (input[k] !== undefined) v[k] = String(input[k]).slice(0, 2000);
  if (input.mode !== undefined) {
    if (!['tts', 'filter', 'mix'].includes(input.mode)) throw new HttpError(400, 'Voice mode must be tts, filter or mix');
    v.mode = input.mode;
  }
  v.updatedAt = now();
  writeJSON(file, v);
  return getAsset('characters', slug).voice;
}

export const VOICE_CONSENT = {
  'own-voice': 'My own voice',
  'written-consent': 'Another person, written consent on file',
  synthetic: 'Synthetic voice (TTS), no real person',
  unknown: 'Not sure yet',
};

export function addVoiceClip(slug, filename, src, meta) {
  readMeta('characters', slug);
  const ext = extOf(filename, AUDIO_EXT);
  const name = `${slugify(meta.label || filename.replace(/\.[^.]+$/, ''))}-${Date.now()}${ext}`;
  const dir = `${assetDir('characters', slug)}/voice/clips`;
  const consent = VOICE_CONSENT[meta.consent] ? meta.consent : 'unknown';
  place(src, `${dir}/${name}`);
  writeJSON(`${dir}/${name}.json`, {
    label: String(meta.label || '').slice(0, 120),
    kind: ['reference', 'tts-sample', 'filtered-take'].includes(meta.kind) ? meta.kind : 'reference',
    source: String(meta.source || 'your recording').slice(0, 200),
    consent,
    rights: { review: consent === 'unknown' ? 'needs-review' : consent === 'written-consent' && meta.evidence ? 'evidence-on-file' : 'user-cleared', evidence: String(meta.evidence || '').slice(0, 1000), checkedAt: now() },
    createdAt: now(),
  });
  return getAsset('characters', slug).voice;
}

// ---------- sets: scene files ----------
// Uploading a scene file with the same name keeps the old one in
// scene/versions/<name>.<timestamp> instead of overwriting it.
export function addSceneFile(slug, filename, src) {
  readMeta('sets', slug);
  const ext = extOf(filename, SCENE_EXT);
  const name = `${slugify(filename.replace(/\.[^.]+$/, ''))}${ext}`;
  const dir = `${assetDir('sets', slug)}/scene`;
  let keptPrevious = false;
  if (exists(`${dir}/${name}`)) {
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
    moveFile(`${dir}/${name}`, `${dir}/versions/${name}.${stamp}`);
    keptPrevious = true;
  }
  place(src, `${dir}/${name}`);
  return { ...getAsset('sets', slug), keptPrevious };
}

// Deleting moves files to the trash (restorable from Settings). The current
// cast winner cannot be deleted: cast another attempt first. `openJobsFor`
// is supplied by the caller to avoid deleting images that queued jobs need.
export function removeFile(kind, slug, area, file, { openJobsFor = () => [] } = {}) {
  const meta = readMeta(kind, slug);
  const allowed = { history: true, clips: kind === 'characters', scene: kind === 'sets' };
  if (!allowed[area]) throw new HttpError(400, 'Cannot remove files here');
  if (!/^[a-z0-9.-]+$/i.test(file)) throw new HttpError(400, 'Bad file name');
  const dir = area === 'clips' ? `${assetDir(kind, slug)}/voice/clips` : `${assetDir(kind, slug)}/${area}`;
  if (area === 'history') {
    const id = file.replace(/\.[^.]+$/, '');
    if (meta.castAttemptId === id) {
      throw new HttpError(409, `This is the ${kind === 'characters' ? 'cast winner' : 'concept image'}. Cast another attempt first, then delete this one.`);
    }
    const jobs = openJobsFor(`${dir}/${file}`);
    if (jobs.length) throw new HttpError(409, `${jobs.length} open job(s) use this image. Cancel them first.`);
    trashFile([`${dir}/${file}`, `${dir}/${id}.json`], `Attempt from ${meta.name}`);
  } else {
    trashFile([`${dir}/${file}`, `${dir}/${file}.json`], `${area} file from ${meta.name}`);
  }
  return getAsset(kind, slug);
}
