// Music & SFX library. Every file carries its license so rights stay traceable.
import fs from 'node:fs';
import path from 'node:path';
import {
  p, readJSON, writeJSON, writeFile, moveFile, trashFile, listFiles, slugify, HttpError, now, fileUrl, extOf, AUDIO_EXT, exists,
} from './store.js';
import { listProjects } from './workspace.js';

// A track's rights: "commercialOk" is kept for older files, but the review
// state is what counts. Ticking the box means "cleared by you"; adding
// evidence (a license link, a receipt) makes it "evidence on file".
function rightsOf(m) {
  if (m.rights?.review) return m.rights;
  return { review: m.commercialOk ? 'user-cleared' : 'needs-review', evidence: m.evidence || '', legacy: true };
}

const KINDS = { music: 'music', sfx: 'sfx' };
const dirOf = (kind) => {
  if (!KINDS[kind]) throw new HttpError(404, 'Audio kind must be music or sfx');
  return p('library', KINDS[kind]);
};

function cleanMeta(input, prev = {}) {
  const m = { ...prev };
  for (const k of ['title', 'license', 'licenseUrl', 'source', 'use', 'notes']) {
    if (input[k] !== undefined) m[k] = String(input[k]).slice(0, 1000);
  }
  if (input.tags !== undefined) {
    m.tags = [].concat(typeof input.tags === 'string' ? input.tags.split(',') : input.tags)
      .map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
  }
  if (input.evidence !== undefined) m.evidence = String(input.evidence).slice(0, 1000);
  if (input.commercialOk !== undefined) m.commercialOk = Boolean(input.commercialOk);
  if (input.commercialOk !== undefined || input.evidence !== undefined) {
    m.rights = {
      review: m.commercialOk ? (m.evidence?.trim() ? 'evidence-on-file' : 'user-cleared') : 'needs-review',
      evidence: m.evidence || '',
      checkedAt: now(),
    };
  }
  return m;
}

export function listAudio(kind) {
  const dir = dirOf(kind);
  return listFiles(dir, (f) => AUDIO_EXT.has(path.extname(f).toLowerCase())).map((f) => {
    const meta = readJSON(`${dir}/${f}.json`, {});
    return { id: f, kind, url: fileUrl(`${dir}/${f}`), ...meta, rights: rightsOf(meta) };
  });
}

export function addAudio(kind, filename, src, input) {
  const dir = dirOf(kind);
  const ext = extOf(filename, AUDIO_EXT);
  const id = `${slugify(input.title || filename.replace(/\.[^.]+$/, ''))}-${Date.now()}${ext}`;
  const meta = cleanMeta({ title: filename.replace(/\.[^.]+$/, ''), ...input }, { createdAt: now(), tags: [], commercialOk: false, license: '' });
  if (!meta.license) throw new HttpError(400, 'Every track needs its license recorded (e.g. "YouTube Audio Library", "CC BY 4.0", "Own recording").');
  if (!meta.rights) meta.rights = { review: 'needs-review', evidence: meta.evidence || '', checkedAt: now() };
  if (Buffer.isBuffer(src)) writeFile(`${dir}/${id}`, src); else moveFile(src, `${dir}/${id}`);
  writeJSON(`${dir}/${id}.json`, meta);
  return { id, kind, url: fileUrl(`${dir}/${id}`), ...meta, rights: rightsOf(meta) };
}

function checkId(id) {
  if (!/^[a-z0-9-]+\.[a-z0-9]+$/i.test(id)) throw new HttpError(400, 'Bad audio id');
}

export function updateAudio(kind, id, input) {
  checkId(id);
  const dir = dirOf(kind);
  if (!exists(`${dir}/${id}`)) throw new HttpError(404, 'No such audio file');
  const meta = cleanMeta(input, readJSON(`${dir}/${id}.json`, {}));
  meta.updatedAt = now();
  writeJSON(`${dir}/${id}.json`, meta);
  return { id, kind, url: fileUrl(`${dir}/${id}`), ...meta, rights: rightsOf(meta) };
}

// Deleting goes to the trash, and a track still linked to a project is refused.
export function deleteAudio(kind, id) {
  checkId(id);
  const dir = dirOf(kind);
  const usedBy = listProjects().filter((pr) => pr.linked?.audio?.includes(id)).map((pr) => pr.name);
  if (usedBy.length) throw new HttpError(409, `Still linked to ${usedBy.join(', ')}. Unlink it from the project first.`);
  trashFile([`${dir}/${id}`, `${dir}/${id}.json`], `${kind} track`);
  return { ok: true };
}
