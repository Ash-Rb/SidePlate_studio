// Model registry + license guard.
// Every model the studio can use is listed in models/registry.json with its
// license. The guard refuses models that a project is not allowed to use.
import { p, readJSON, writeJSON, HttpError, now } from './store.js';

export const REGIONS = {
  EU: 'European Union',
  UK: 'United Kingdom',
  KR: 'South Korea',
  US: 'United States',
  OTHER: 'Elsewhere',
};

// Defaults written on first run. Licenses as checked October 2026;
// always re-check a model card before relying on it.
export const DEFAULT_MODELS = [
  {
    id: 'sdxl-base-1.0',
    version: 'stabilityai/stable-diffusion-xl-base-1.0 + h94/IP-Adapter sdxl_models/ip-adapter_sdxl.bin',
    licenseCheckedAt: '2026-10-15',
    label: 'Stable Diffusion XL 1.0',
    capabilities: ['image.generate', 'image.reference_pack'],
    adapter: 'kaggle-bundle',
    license: 'CreativeML Open RAIL++-M (IP-Adapter: Apache 2.0)',
    licenseUrl: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0',
    commercial: true,
    excludedRegions: [],
    status: 'available',
    notes: 'Commercial use allowed, with use-based restrictions (no harmful uses). Reference packs add IP-Adapter (Apache 2.0). Runs on a free Kaggle T4.',
  },
  {
    id: 'chatgpt-images',
    version: 'ChatGPT image generation (version not recorded by the app)',
    licenseCheckedAt: '2026-10-15',
    label: 'ChatGPT image generation (by hand)',
    capabilities: ['image.generate', 'image.reference_pack'],
    adapter: 'manual-import',
    license: 'OpenAI Terms of Use',
    licenseUrl: 'https://openai.com/policies/terms-of-use',
    commercial: true,
    excludedRegions: [],
    status: 'available',
    notes: 'You generate in ChatGPT, then drop the image into the studio. Check the current OpenAI terms yourself.',
  },
  {
    id: 'own-artwork',
    version: '',
    licenseCheckedAt: '2026-10-15',
    label: 'Your own artwork or photos',
    capabilities: ['image.generate', 'image.reference_pack', 'audio.clip'],
    adapter: 'manual-import',
    license: 'Your own work',
    licenseUrl: '',
    commercial: true,
    excludedRegions: [],
    status: 'available',
    notes: 'Anything you drew, painted, photographed or recorded yourself.',
  },
  {
    id: 'kokoro-82m',
    version: 'hexgrad/Kokoro-82M',
    licenseCheckedAt: '2026-10-15',
    label: 'Kokoro 82M text-to-speech',
    capabilities: ['tts'],
    adapter: 'manual-import',
    license: 'Apache 2.0',
    licenseUrl: 'https://huggingface.co/hexgrad/Kokoro-82M',
    commercial: true,
    excludedRegions: [],
    status: 'planned',
    notes: 'Phase 2: runs on a laptop CPU. For now, import clips made with it by hand.',
  },
  {
    id: 'wan-2.2',
    version: 'Wan-AI/Wan2.2-TI2V-5B',
    licenseCheckedAt: '2026-10-15',
    label: 'Wan 2.2 video',
    capabilities: ['video.generate'],
    adapter: 'kaggle-bundle',
    license: 'Apache 2.0',
    licenseUrl: 'https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B',
    commercial: true,
    excludedRegions: [],
    status: 'planned',
    notes: 'Phase 3: per-shot video generation.',
  },
  {
    id: 'trellis-2',
    version: 'microsoft/TRELLIS.2-4B',
    licenseCheckedAt: '2026-10-15',
    label: 'TRELLIS.2 image-to-3D',
    capabilities: ['image_to_3d'],
    adapter: 'kaggle-bundle',
    license: 'MIT',
    licenseUrl: 'https://huggingface.co/microsoft/TRELLIS.2-4B',
    commercial: true,
    excludedRegions: [],
    status: 'planned',
    notes: 'Props for 3D sets. Needs more GPU memory than a free T4; planned via Modal or a paid GPU.',
  },
  {
    id: 'flux-1-dev',
    version: 'black-forest-labs/FLUX.1-dev',
    licenseCheckedAt: '2026-10-15',
    label: 'FLUX.1 [dev]',
    capabilities: ['image.generate'],
    adapter: 'kaggle-bundle',
    license: 'FLUX.1 [dev] Non-Commercial License',
    licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.1-dev',
    commercial: false,
    excludedRegions: [],
    status: 'blocked',
    notes: 'Non-commercial: revenue-generating use (a monetized channel) is not allowed.',
  },
  {
    id: 'hunyuan3d-2',
    version: 'tencent/Hunyuan3D-2',
    licenseCheckedAt: '2026-10-15',
    label: 'Tencent Hunyuan3D 2 / HunyuanWorld',
    capabilities: ['image_to_3d'],
    adapter: 'kaggle-bundle',
    license: 'Tencent Hunyuan Community License',
    licenseUrl: 'https://huggingface.co/tencent/Hunyuan3D-2/blob/main/LICENSE',
    commercial: true,
    excludedRegions: ['EU', 'UK', 'KR'],
    status: 'blocked',
    notes: 'The license does not apply in the EU, UK or South Korea, outputs included.',
  },
];

const FILE = () => p('models', 'registry.json');

export function loadRegistry() {
  const reg = readJSON(FILE());
  if (reg) return reg;
  return writeJSON(FILE(), { version: 1, updatedAt: now(), models: DEFAULT_MODELS });
}

export function listModels() {
  return loadRegistry().models;
}

export function getModel(id) {
  const m = findModel(id);
  if (!m) throw new HttpError(404, `Unknown model: ${id}`);
  return m;
}

// Like getModel, but returns null for a model missing from the registry
// (e.g. removed after an image was made). Callers must treat null as
// "needs review", never as cleared.
export function findModel(id) {
  return listModels().find((x) => x.id === id) || null;
}

export function saveModel(model) {
  const required = ['id', 'label', 'capabilities', 'adapter', 'license'];
  for (const k of required) if (!model[k] || (Array.isArray(model[k]) && !model[k].length)) {
    throw new HttpError(400, `Model is missing "${k}"`);
  }
  if (!/^[a-z0-9][a-z0-9.\-]{0,59}$/.test(model.id)) throw new HttpError(400, 'Model id: lowercase letters, digits, dots and dashes');
  const reg = loadRegistry();
  const clean = {
    id: model.id,
    label: String(model.label),
    capabilities: [].concat(model.capabilities).map(String),
    adapter: String(model.adapter),
    license: String(model.license),
    licenseUrl: String(model.licenseUrl || ''),
    commercial: Boolean(model.commercial),
    excludedRegions: [].concat(model.excludedRegions || []).map(String),
    status: ['available', 'planned', 'blocked'].includes(model.status) ? model.status : 'available',
    notes: String(model.notes || ''),
    version: String(model.version || '').slice(0, 300),
    licenseCheckedAt: /^\d{4}-\d{2}-\d{2}$/.test(model.licenseCheckedAt || '') ? model.licenseCheckedAt : new Date().toISOString().slice(0, 10),
  };
  const i = reg.models.findIndex((m) => m.id === clean.id);
  if (i >= 0) reg.models[i] = clean; else reg.models.push(clean);
  reg.updatedAt = now();
  writeJSON(FILE(), reg);
  return clean;
}

// The license guard. `use` describes where the output may end up.
//   use.commercial  - true if the output may be used in a monetized project
//   use.region      - where the creator lives (workspace setting)
export function checkModelUse(model, use) {
  const reasons = [];
  if (model.status === 'blocked') reasons.push(`${model.label} is marked blocked in the registry: ${model.notes}`);
  if (model.excludedRegions?.includes(use.region)) {
    reasons.push(`${model.label}'s license (${model.license}) does not apply in ${REGIONS[use.region] || use.region}.`);
  }
  if (use.commercial && !model.commercial) {
    reasons.push(`${model.label} is not licensed for commercial use (${model.license}), and this work is marked commercial.`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function assertModelUse(model, use) {
  const { ok, reasons } = checkModelUse(model, use);
  if (!ok) throw new HttpError(403, `License guard: ${reasons.join(' ')}`);
}
