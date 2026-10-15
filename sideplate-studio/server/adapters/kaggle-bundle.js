// Kaggle bundle: jobs are exported as one zip, processed by the free
// worker notebook on Kaggle (or Colab), and the results zip is imported back.
// The same bundle format works for any batch worker, so swapping Kaggle for
// another GPU host only means running the notebook somewhere else.
import path from 'node:path';

export const BUNDLE_FORMAT = 'sideplate-bundle';
export const RESULTS_FORMAT = 'sideplate-results';
const IMAGE = /\.(png|jpe?g|webp)$/i;

export default {
  id: 'kaggle-bundle',
  label: 'Kaggle worker (free GPU, weekly batch)',
  kind: 'batch',
  capabilities: ['image.generate', 'image.reference_pack'],
  help: 'Queued jobs are exported as bundle.zip. Run the worker notebook on Kaggle, then import its results.zip.',

  submit() {
    return { status: 'queued', instructions: 'Waiting for the next Kaggle batch: export the bundle from Jobs.' };
  },

  // jobs: job objects; readFile(absPath) -> Buffer for reference images.
  // Returns zip entries + the manifest (pure: no disk writes).
  // `bundleId` and each job's `rev` are echoed back by the worker, so the
  // importer can tell which export a result belongs to and refuse stale ones.
  buildBundle(jobs, readFile, { bundleId = null } = {}) {
    const entries = [];
    const manifest = { format: BUNDLE_FORMAT, version: 2, bundleId, createdAt: new Date().toISOString(), jobs: [] };
    for (const job of jobs) {
      const i = job.input || {};
      const item = {
        id: job.id,
        rev: job.rev || 1,
        capability: job.capability,
        model: job.model,
        prompt: i.prompt || '',
        negative: i.negative || '',
        width: i.width || 1024,
        height: i.height || 1024,
        count: Math.max(1, Math.min(8, Number(i.count) || 1)),
        seed: Number.isInteger(i.seed) ? i.seed : null,
        steps: i.steps || 30,
        guidance: i.guidance || 6.5,
      };
      if (i.slot) item.slot = i.slot;
      if (i.refImage) {
        const ext = path.extname(i.refImage).toLowerCase() || '.png';
        item.refImage = `inputs/${job.id}${ext}`;
        item.refStrength = i.refStrength ?? 0.6;
        entries.push({ name: item.refImage, data: readFile(i.refImage) });
      }
      manifest.jobs.push(item);
    }
    entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });
    return { entries, manifest };
  },

  // files: Map(name -> Buffer) from the results zip.
  // Returns [{ jobId, error, outputs: [{ name, data, seed }] }].
  parseResults(files) {
    const raw = files.get('results.json');
    if (!raw) throw new Error('results.zip has no results.json. Was it made by the Sideplate worker notebook?');
    let doc;
    try { doc = JSON.parse(raw.toString('utf8')); } catch { throw new Error('results.json is not valid JSON'); }
    if (doc.format !== RESULTS_FORMAT) throw new Error('results.json is not a Sideplate results file');
    if (!Array.isArray(doc.results)) throw new Error('results.json has no results list');
    return (doc.results || []).map((r) => {
      const outputs = [];
      (r.files || []).forEach((name, idx) => {
        if (!name.startsWith('outputs/') || name.includes('..') || !IMAGE.test(name)) return;
        const data = files.get(name);
        if (data) outputs.push({ name: path.basename(name), data, seed: r.seeds?.[idx] ?? null });
      });
      return {
        jobId: String(r.jobId),
        bundleId: r.bundleId || doc.bundleId || null,
        jobRev: Number.isInteger(r.jobRev) ? r.jobRev : null,
        error: r.error || null,
        outputs,
        diagnostics: r.diagnostics || null,
      };
    });
  },
};
