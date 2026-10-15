// Job queue. Jobs are plain JSON files in queue/jobs/, so any worker
// (Kaggle, Colab, Modal, a paid API later) can process the same job.
import fs from 'node:fs';
import path from 'node:path';
import {
  p, HOME, readJSON, writeJSON, writeFile, listFiles, newId, HttpError, now, safeJoin, ensureDir,
} from './store.js';
import { getModel, assertModelUse } from './registry.js';
import { getWorkspace, getProject, composePrompt, getStyle } from './workspace.js';
import { getAsset, addAttempt, setLook, castImagePath, slotPrompt, KINDS, assertImageContent } from './library.js';
import { CAPABILITIES, getAdapter } from './adapters/index.js';
import { createZip, readZip } from './zip.js';

const jobFile = (id) => {
  if (!/^job-[a-z0-9-]+$/i.test(id)) throw new HttpError(400, 'Bad job id');
  return p('queue', 'jobs', `${id}.json`);
};

const OPEN = new Set(['queued', 'exported', 'awaiting-upload']);

export function listJobs({ status } = {}) {
  const dir = p('queue', 'jobs');
  return listFiles(dir, (f) => f.endsWith('.json'))
    .map((f) => readJSON(`${dir}/${f}`))
    .filter(Boolean)
    .filter((j) => !status || (status === 'open' ? OPEN.has(j.status) : j.status === status))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getJob(id) {
  const j = readJSON(jobFile(id));
  if (!j) throw new HttpError(404, 'No such job');
  return j;
}

function saveJob(job) {
  job.updatedAt = now();
  return writeJSON(jobFile(job.id), job);
}

// Who may use the output decides which models are allowed.
function useFor(projectSlug) {
  const ws = getWorkspace();
  if (projectSlug) {
    const proj = getProject(projectSlug);
    return { commercial: proj.commercial, region: ws.region, project: proj };
  }
  return { commercial: ws.libraryCommercial, region: ws.region, project: null };
}

export function createJob(spec) {
  const capability = String(spec.capability || '');
  const cap = CAPABILITIES[capability];
  if (!cap) throw new HttpError(400, `Unknown capability: ${capability}`);
  if (cap.phase > 1) throw new HttpError(400, `${cap.label} arrives in phase ${cap.phase}`);

  const model = getModel(spec.model);
  if (!model.capabilities.includes(capability)) throw new HttpError(400, `${model.label} cannot do "${cap.label}"`);
  if (model.status !== 'available') throw new HttpError(400, `${model.label} is ${model.status}, not available yet`);
  const adapter = getAdapter(model.adapter);
  if (!adapter.capabilities.includes(capability)) throw new HttpError(400, `Adapter ${adapter.id} cannot do "${cap.label}"`);

  const use = useFor(spec.projectSlug);
  assertModelUse(model, use);

  const target = spec.target || {};
  if (!KINDS[target.kind]) throw new HttpError(400, 'Jobs need a target: a character or a set');
  const asset = getAsset(target.kind, target.slug);
  const styleSlug = target.styleSlug || use.project?.styleSlug || null;
  if (styleSlug) getStyle(styleSlug);

  const raw = spec.input || {};
  const input = {
    count: Math.max(1, Math.min(8, Number(raw.count) || 1)),
    width: [512, 768, 832, 896, 1024, 1152, 1216, 1344].includes(Number(raw.width)) ? Number(raw.width) : 1024,
    height: [512, 768, 832, 896, 1024, 1152, 1216, 1344].includes(Number(raw.height)) ? Number(raw.height) : 1024,
    // Seeds: whole numbers 0 to 2^32 - 1 (what the worker's generator accepts); anything else means random.
    seed: raw.seed !== '' && raw.seed !== null && raw.seed !== undefined && Number.isInteger(Number(raw.seed)) && Number(raw.seed) >= 0 && Number(raw.seed) <= 0xffffffff ? Number(raw.seed) : null,
    userPrompt: String(raw.prompt || '').slice(0, 2000),
  };

  if (capability === 'image.reference_pack') {
    if (!styleSlug) throw new HttpError(400, 'A reference pack needs an art style');
    const ref = castImagePath(target.kind, target.slug);
    if (!ref) throw new HttpError(400, `Cast a winner for ${asset.name} first`);
    const slot = slotPrompt(target.kind, target.slug, target.slot);
    input.slot = slot.id;
    input.refImage = path.relative(HOME, ref);
    input.refStrength = 0.6;
    input.count = 1;
    Object.assign(input, composePrompt(styleSlug, asset.visual, slot.prompt, input.userPrompt));
  } else {
    if (!input.userPrompt && !asset.visual) throw new HttpError(400, 'Write a prompt (or a visual description on the asset)');
    Object.assign(input, composePrompt(styleSlug, asset.visual, input.userPrompt));
  }
  if (raw.negative) input.negative = [input.negative, String(raw.negative).slice(0, 1000)].filter(Boolean).join(', ');

  const job = {
    id: newId('job-'),
    capability,
    model: model.id,
    adapter: adapter.id,
    projectSlug: spec.projectSlug || null,
    commercial: use.commercial,
    target: { kind: target.kind, slug: target.slug, slot: input.slot || null, styleSlug, name: asset.name },
    input,
    createdAt: now(),
    rev: 1,
    results: [],
  };
  Object.assign(job, adapter.submit(job));
  return saveJob(job);
}

// Open jobs that read this file as their reference image.
export function openJobsUsing(absPath) {
  const rel = path.relative(HOME, absPath);
  return listJobs({ status: 'open' }).filter((j) => j.input?.refImage === rel);
}

export function createReferencePack({ kind, slug, styleSlug, model, slots, projectSlug }) {
  const asset = getAsset(kind, slug);
  const wanted = slots?.length ? slots : asset.slots.map((s) => s.id);
  return wanted.map((slot) => createJob({
    capability: 'image.reference_pack', model, projectSlug,
    target: { kind, slug, styleSlug, slot },
  }));
}

export function cancelJob(id) {
  const job = getJob(id);
  if (!OPEN.has(job.status)) throw new HttpError(400, `Job is already ${job.status}`);
  job.status = 'cancelled';
  return saveJob(job);
}

// A failed or cancelled job goes back into the queue (or back to waiting for upload).
export function retryJob(id) {
  const job = getJob(id);
  if (!['failed', 'cancelled'].includes(job.status)) throw new HttpError(400, `Only failed or cancelled jobs can be retried (this one is ${job.status})`);
  const adapter = getAdapter(job.adapter);
  delete job.error;
  delete job.partial;
  job.bundleIds = [];
  // A new revision: results for the old revision are refused as stale.
  job.rev = (job.rev || 1) + 1;
  Object.assign(job, adapter.submit(job));
  return saveJob(job);
}

// Put a generated image where it belongs: history for new attempts,
// the style's look folder for reference-pack slots.
function applyOutput(job, name, data, seed, source) {
  const record = {
    model: job.model, prompt: job.input.prompt, negative: job.input.negative, seed,
    styleSlug: job.target.styleSlug, jobId: job.id, source, commercial: job.commercial,
  };
  if (job.capability === 'image.reference_pack') {
    return setLook(job.target.kind, job.target.slug, job.target.styleSlug, job.target.slot, name, data, record);
  }
  return addAttempt(job.target.kind, job.target.slug, name, data, record);
}

export function completeManual(id, filename, src) {
  const job = getJob(id);
  if (job.adapter !== 'manual-import') throw new HttpError(400, 'This job is processed by a worker, not by upload');
  if (job.status !== 'awaiting-upload' && job.status !== 'done') throw new HttpError(400, `Job is ${job.status}`);
  const rec = applyOutput(job, filename, src, job.input.seed, 'manual');
  job.results.push({ at: now(), file: rec.file });
  job.status = 'done';
  saveJob(job);
  return { job, result: rec };
}

// ---------- batch bundles ----------
export function exportBundle(adapterId = 'kaggle-bundle') {
  const adapter = getAdapter(adapterId);
  const jobs = listJobs().filter((j) => j.adapter === adapterId && (j.status === 'queued' || j.status === 'exported'));
  if (!jobs.length) throw new HttpError(400, 'Nothing is waiting for the worker');
  const missing = jobs.filter((j) => j.input.refImage && !fs.existsSync(safeJoin(HOME, j.input.refImage)));
  if (missing.length) {
    throw new HttpError(409, `The reference image for ${missing.map((j) => `${j.target.name} (${j.target.slot})`).join(', ')} is gone. Cancel or retry those jobs first.`);
  }
  const bundleId = newId('bundle-');
  const { entries, manifest } = adapter.buildBundle(jobs.map((j) => ({
    ...j, input: { ...j.input, refImage: j.input.refImage ? safeJoin(HOME, j.input.refImage) : undefined },
  })), (abs) => fs.readFileSync(abs), { bundleId });
  const zip = createZip(entries);
  writeFile(p('queue', 'exports', `${bundleId}.zip`), zip);
  for (const j of jobs) {
    j.status = 'exported';
    j.bundleId = bundleId;
    j.bundleIds = [...(j.bundleIds || []), bundleId].slice(-10);
    saveJob(j);
  }
  return { bundleId, zip, count: manifest.jobs.length };
}

// Importing is staged: the whole zip is read and every image is checked
// before anything is saved. Then each job is applied on its own; a result is
// refused (skipped) when it is stale: the job was retried or finished since,
// or it came from a bundle this job was never part of. Importing the same zip
// twice is safe. A log of every import is kept in queue/imports/.
export function importResults(buffer, adapterId = 'kaggle-bundle') {
  const adapter = getAdapter(adapterId);
  let results;
  try {
    results = adapter.parseResults(readZip(buffer));
  } catch (err) {
    throw new HttpError(400, `Could not read results.zip: ${err.message}`);
  }
  // Stage: validate every output before touching the library.
  const seen = new Set();
  for (const r of results) {
    if (seen.has(r.jobId)) throw new HttpError(400, `results.json lists job ${r.jobId} twice`);
    seen.add(r.jobId);
    for (const o of r.outputs) {
      try { assertImageContent(o.data); } catch { throw new HttpError(400, `${o.name} in results.zip is not a valid image; nothing was imported`); }
    }
  }
  const importId = newId('results-');
  ensureDir(p('queue', 'imports'));
  writeFile(p('queue', 'imports', `${importId}.zip`), buffer);
  const summary = { importId, done: 0, failed: 0, skipped: 0, images: 0, messages: [], jobs: [] };
  const note = (job, outcome, message) => {
    summary.jobs.push({ jobId: job?.id || null, name: job?.target?.name || '', outcome, message: message || '' });
    if (message) summary.messages.push(job ? `${job.target.name}${job.target.slot ? ` (${job.target.slot})` : ''}: ${message}` : message);
  };
  for (const r of results) {
    let job;
    try { job = getJob(r.jobId); } catch { summary.skipped++; note(null, 'skipped', `Unknown job ${r.jobId}`); continue; }
    if (job.status === 'done') { summary.skipped++; note(job, 'skipped', ''); continue; }
    if (job.status === 'cancelled') { summary.skipped++; note(job, 'skipped', 'cancelled, result ignored'); continue; }
    if (job.adapter !== adapterId) { summary.skipped++; note(job, 'skipped', 'this job is not a batch job'); continue; }
    if (r.bundleId && !(job.bundleIds || [job.bundleId]).includes(r.bundleId)) {
      summary.skipped++; note(job, 'skipped', `stale result from ${r.bundleId}; this job was not in that bundle`); continue;
    }
    if (r.jobRev !== null && r.jobRev !== (job.rev || 1)) {
      summary.skipped++; note(job, 'skipped', 'stale result: the job was retried after that bundle was exported'); continue;
    }
    if (!r.bundleId && job.status !== 'exported') {
      summary.skipped++; note(job, 'skipped', 'result has no bundle id and the job is not waiting for one'); continue;
    }
    if (r.error || !r.outputs.length) {
      job.status = 'failed';
      job.error = r.error || 'The worker returned no images';
      job.diagnostics = r.diagnostics || undefined;
      saveJob(job);
      summary.failed++;
      note(job, 'failed', job.error);
      continue;
    }
    const outs = job.capability === 'image.reference_pack' ? r.outputs.slice(0, 1) : r.outputs;
    const saved = [];
    try {
      for (const o of outs) {
        const rec = applyOutput(job, o.name, o.data, o.seed, 'kaggle');
        saved.push(rec.file);
        job.results.push({ at: now(), file: rec.file, seed: o.seed, importId });
        summary.images++;
      }
      job.status = 'done';
      job.diagnostics = r.diagnostics || undefined;
      summary.done++;
      note(job, 'done', '');
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      if (saved.length) job.partial = { importId, saved };
      summary.failed++;
      note(job, 'failed', `${err.message}${saved.length ? ` (${saved.length} image(s) were saved before the error and are kept)` : ''}`);
    }
    saveJob(job);
  }
  writeJSON(p('queue', 'imports', `${importId}.json`), { importId, at: now(), ...summary });
  return summary;
}
