// Rights records. A generator's license is not the same thing as the right to
// use a particular file, so every image and track records where it came from
// and how far its rights have been checked:
//
//   needs-review      nobody has confirmed the rights yet (blocks commercial use)
//   model-cleared     made by a model whose registry entry allows commercial use;
//                     the content itself has not been reviewed
//   user-cleared      you declared you have the rights
//   evidence-on-file  you declared it and recorded evidence (link, receipt, note)
import { HttpError, now } from './store.js';

export const REVIEW_STATES = ['needs-review', 'model-cleared', 'user-cleared', 'evidence-on-file'];
export const ORIGINS = ['generated', 'own-work', 'third-party', 'unknown'];

export const REVIEW_LABELS = {
  'needs-review': 'Needs review',
  'model-cleared': 'Cleared via model license',
  'user-cleared': 'Cleared by you',
  'evidence-on-file': 'Evidence on file',
};

// Rights for a new image. `source` is how it arrived: 'kaggle' / 'manual'
// (through a job) or 'upload' (dropped in directly).
export function rightsForImage({ model, source, meta = {} }) {
  const viaJob = source === 'kaggle' || source === 'manual';
  if (viaJob) {
    return {
      origin: 'generated',
      basis: model ? `${model.label}: ${model.license}` : 'unknown model',
      evidence: model?.licenseUrl || '',
      review: model?.commercial ? 'model-cleared' : 'needs-review',
      checkedAt: now(),
    };
  }
  let origin = ORIGINS.includes(meta.origin) ? meta.origin : null;
  if (!origin) origin = model?.id === 'own-artwork' ? 'own-work' : model ? 'generated' : 'unknown';
  const evidence = String(meta.evidence || '').slice(0, 1000);
  return {
    origin,
    basis: origin === 'own-work' ? 'Your own work' : model ? `${model.label}: ${model.license}` : '',
    evidence,
    review: meta.rightsDeclared === true ? (evidence ? 'evidence-on-file' : 'user-cleared') : 'needs-review',
    checkedAt: now(),
  };
}

// Records made before rights tracking existed are read conservatively:
// direct uploads need review; job outputs follow their model's license flag.
export function effectiveRights(record) {
  if (record?.rights?.review && REVIEW_STATES.includes(record.rights.review)) return record.rights;
  const viaJob = record?.source === 'kaggle' || record?.source === 'manual';
  return {
    origin: viaJob ? 'generated' : 'unknown',
    basis: record?.license || '',
    evidence: '',
    review: viaJob && record?.commercial ? 'model-cleared' : 'needs-review',
    legacy: true,
  };
}

// A person updating rights by hand (e.g. "Mark as cleared").
export function updatedRights(prev, input) {
  const review = String(input.review || '');
  if (!['needs-review', 'user-cleared', 'evidence-on-file'].includes(review)) {
    throw new HttpError(400, 'Review must be needs-review, user-cleared or evidence-on-file');
  }
  const evidence = input.evidence !== undefined ? String(input.evidence).slice(0, 1000) : (prev?.evidence || '');
  if (review === 'evidence-on-file' && !evidence.trim()) throw new HttpError(400, 'Add the evidence (a link or a note) first');
  const origin = ORIGINS.includes(input.origin) ? input.origin : (prev?.origin || 'unknown');
  return { ...(prev || {}), origin, evidence, review, checkedAt: now(), legacy: undefined };
}

export function blocksCommercial(rights) {
  return !rights || rights.review === 'needs-review';
}
