// Workspace settings, art style presets and projects.
import fs from 'node:fs';
import {
  p, readJSON, writeJSON, writeFile, listDirs, listFiles, slugify, assertSlug,
  HttpError, now, fileUrl, extOf, IMAGE_EXT, exists, ensureDir, trashFile,
} from './store.js';
import { REGIONS } from './registry.js';

// ---------- workspace ----------
const WS = () => p('workspace.json');

export function getWorkspace() {
  const ws = readJSON(WS());
  if (ws) return ws;
  return writeJSON(WS(), {
    version: 1,
    name: 'Sideplate Studio',
    region: 'EU',
    // Library assets can end up in any project, so by default they are
    // generated as if they were commercial.
    libraryCommercial: true,
    createdAt: now(),
  });
}

export function updateWorkspace(patch) {
  const ws = getWorkspace();
  if (patch.name !== undefined) ws.name = String(patch.name).slice(0, 80) || ws.name;
  if (patch.region !== undefined) {
    if (!REGIONS[patch.region]) throw new HttpError(400, 'Unknown region');
    ws.region = patch.region;
  }
  if (patch.libraryCommercial !== undefined) ws.libraryCommercial = Boolean(patch.libraryCommercial);
  ws.updatedAt = now();
  return writeJSON(WS(), ws);
}

// ---------- styles ----------
const styleDir = (slug) => p('styles', assertSlug(slug));

export const DEFAULT_STYLES = [
  {
    name: 'Anime warm',
    promptPrefix: 'anime style illustration, clean line art, cel shading, soft warm palette',
    promptSuffix: 'high quality, consistent character design',
    negative: 'photorealistic, photo, 3d render, lowres, blurry, extra fingers, deformed hands, watermark, text, logo',
    palette: ['#F4E3C3', '#E07A4F', '#7A4E3A', '#2F4858', '#F7F3EC'],
    notes: 'Default look for Good Company. Tune the prefix until the cast feels right.',
  },
];

function styleSummary(style) {
  const dir = styleDir(style.slug);
  const refs = listFiles(`${dir}/refs`, (f) => IMAGE_EXT.has(f.slice(f.lastIndexOf('.')).toLowerCase()));
  return { ...style, refs: refs.map((f) => ({ file: f, url: fileUrl(`${dir}/refs/${f}`) })) };
}

export function listStyles() {
  return listDirs(p('styles'))
    .map((slug) => readJSON(`${styleDir(slug)}/style.json`))
    .filter(Boolean)
    .map(styleSummary);
}

export function getStyle(slug) {
  const s = readJSON(`${styleDir(slug)}/style.json`);
  if (!s) throw new HttpError(404, `No style called ${slug}`);
  return styleSummary(s);
}

const STYLE_FIELDS = ['name', 'promptPrefix', 'promptSuffix', 'negative', 'notes'];

export function saveStyle(input, existingSlug) {
  const slug = existingSlug ? assertSlug(existingSlug) : slugify(input.name);
  const file = `${styleDir(slug)}/style.json`;
  const prev = readJSON(file);
  if (!existingSlug && prev) throw new HttpError(409, `A style called "${slug}" already exists`);
  if (existingSlug && !prev) throw new HttpError(404, `No style called ${slug}`);
  const style = { ...(prev || { slug, createdAt: now() }) };
  for (const k of STYLE_FIELDS) if (input[k] !== undefined) style[k] = String(input[k]);
  if (input.palette !== undefined) {
    style.palette = [].concat(input.palette).map(String).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 12);
  }
  if (!style.name) throw new HttpError(400, 'A style needs a name');
  style.updatedAt = now();
  writeJSON(file, style);
  return getStyle(slug);
}

export function addStyleRef(slug, filename, buffer) {
  getStyle(slug);
  const ext = extOf(filename, IMAGE_EXT);
  const base = slugify(filename.replace(/\.[^.]+$/, ''));
  writeFile(`${styleDir(slug)}/refs/${base}-${Date.now()}${ext}`, buffer);
  return getStyle(slug);
}

// Text that gets wrapped around every prompt made in this style.
export function composePrompt(styleSlug, ...parts) {
  const style = styleSlug ? getStyle(styleSlug) : null;
  const prompt = [style?.promptPrefix, ...parts, style?.promptSuffix]
    .map((s) => (s || '').trim()).filter(Boolean).join(', ');
  return { prompt, negative: style?.negative || '' };
}

// ---------- projects ----------
const projDir = (slug) => p('projects', assertSlug(slug));

export function listProjects() {
  return listDirs(p('projects')).map((slug) => readJSON(`${projDir(slug)}/project.json`)).filter(Boolean);
}

export function getProject(slug) {
  const proj = readJSON(`${projDir(slug)}/project.json`);
  if (!proj) throw new HttpError(404, `No project called ${slug}`);
  return proj;
}

const FORMATS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
};

const FPS = [24, 25, 30, 50, 60];

export function saveProject(input, existingSlug) {
  const slug = existingSlug ? assertSlug(existingSlug) : slugify(input.name);
  const file = `${projDir(slug)}/project.json`;
  const prev = readJSON(file);
  if (!existingSlug && prev) throw new HttpError(409, `A project called "${slug}" already exists`);
  if (existingSlug && !prev) throw new HttpError(404, `No project called ${slug}`);
  const proj = prev || {
    slug, createdAt: now(), commercial: true,
    linked: { characters: [], sets: [], audio: [] },
  };
  if (input.name !== undefined) proj.name = String(input.name).slice(0, 80);
  if (!proj.name) throw new HttpError(400, 'A project needs a name');
  if (input.channel !== undefined) proj.channel = String(input.channel).slice(0, 80);
  if (input.styleSlug !== undefined) {
    if (input.styleSlug) getStyle(input.styleSlug);
    proj.styleSlug = input.styleSlug || null;
  }
  if (input.aspect !== undefined) {
    if (!FORMATS[input.aspect]) throw new HttpError(400, 'Unknown aspect ratio');
    proj.format = { aspect: input.aspect, ...FORMATS[input.aspect], fps: proj.format?.fps || 24 };
  }
  if (input.fps !== undefined) {
    const fps = Number(input.fps);
    if (!FPS.includes(fps)) throw new HttpError(400, `Frame rate must be one of ${FPS.join(', ')}`);
    proj.format = { ...(proj.format || { aspect: '16:9', ...FORMATS['16:9'] }), fps };
  }
  if (!proj.format) proj.format = { aspect: '16:9', ...FORMATS['16:9'], fps: 24 };
  // Extra output formats made from the same timeline (e.g. 9:16 Shorts from a
  // 16:9 episode). Recorded only; reframing arrives in a later phase. Asset
  // identity never depends on orientation.
  if (input.extraOutputs !== undefined) {
    proj.extraOutputs = [...new Set([].concat(input.extraOutputs).map(String))]
      .filter((a) => FORMATS[a] && a !== proj.format.aspect);
  }
  proj.extraOutputs = (proj.extraOutputs || []).filter((a) => a !== proj.format.aspect);
  if (input.commercial !== undefined) proj.commercial = Boolean(input.commercial);
  if (input.cadence !== undefined) proj.cadence = String(input.cadence).slice(0, 40);
  if (input.episodeLength !== undefined) proj.episodeLength = String(input.episodeLength).slice(0, 40);
  if (input.notes !== undefined) proj.notes = String(input.notes).slice(0, 4000);
  proj.updatedAt = now();
  writeJSON(file, proj);
  ensureDir(`${projDir(slug)}/season-01`);
  return proj;
}

export function setProjectLinks(slug, kind, ids) {
  const proj = getProject(slug);
  if (!['characters', 'sets', 'audio'].includes(kind)) throw new HttpError(400, 'Unknown link kind');
  proj.linked = proj.linked || { characters: [], sets: [], audio: [] };
  proj.linked[kind] = [...new Set(ids.map(String))];
  proj.updatedAt = now();
  return writeJSON(`${projDir(slug)}/project.json`, proj);
}

export function projectExists(slug) {
  return exists(`${projDir(slug)}/project.json`);
}

export function deleteStyleRef(slug, file) {
  const target = `${styleDir(slug)}/refs/${file}`;
  if (!/^[a-z0-9-]+\.[a-z]+$/i.test(file) || !exists(target)) throw new HttpError(404, 'No such reference');
  trashFile(target, `Style reference from ${slug}`);
  return getStyle(slug);
}
