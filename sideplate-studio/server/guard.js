// The license guard for projects. Fails closed: anything it cannot confirm
// (a model missing from the registry, rights nobody has reviewed) is reported
// as a problem for commercial projects, never treated as cleared.
import { getWorkspace } from './workspace.js';
import { checkModelUse } from './registry.js';
import { assetImageRecords, modelOf } from './library.js';
import { listAudio } from './audio.js';
import { effectiveRights, blocksCommercial, REVIEW_LABELS } from './rights.js';

// Problems that would stop `kind/id` being used in a project with `commercial`.
export function auditAsset(kind, id, commercial) {
  const ws = getWorkspace();
  const problems = [];
  if (kind === 'characters' || kind === 'sets') {
    let images;
    try { ({ images } = assetImageRecords(kind, id)); } catch (err) {
      return [{ kind, id, where: '', problem: `Cannot read this asset: ${err.message}` }];
    }
    for (const { where, record } of images) {
      const model = modelOf(record);
      if (!model) {
        problems.push({ kind, id, where, problem: `Made with "${record.model}", which is not in the model registry. Review its license and add it back, or replace this image.` });
        continue;
      }
      const check = checkModelUse(model, { commercial, region: ws.region });
      if (!check.ok) problems.push({ kind, id, where, problem: check.reasons.join(' ') });
      const rights = effectiveRights(record);
      if (commercial && blocksCommercial(rights)) {
        problems.push({ kind, id, where, problem: `Rights: ${REVIEW_LABELS[rights.review]}. Mark it as cleared once you have checked you may use it.` });
      }
    }
  } else if (kind === 'audio') {
    const all = [...listAudio('music'), ...listAudio('sfx')];
    const track = all.find((a) => a.id === id);
    if (!track) problems.push({ kind, id, where: '', problem: 'This track no longer exists in the library.' });
    else if (commercial && blocksCommercial(track.rights)) {
      problems.push({ kind, id, where: track.title || id, problem: 'Not cleared for commercial use yet. Check its license, then mark it as cleared.' });
    }
  }
  return problems;
}

export function auditLinks(kind, ids, commercial) {
  return ids.flatMap((id) => auditAsset(kind, id, commercial));
}

export function auditProject(proj, commercial = proj.commercial) {
  const linked = proj.linked || {};
  return ['characters', 'sets', 'audio'].flatMap((kind) => auditLinks(kind, linked[kind] || [], commercial));
}

export function describeProblems(problems) {
  return problems.map((x) => `${x.id}${x.where ? ` · ${x.where}` : ''}: ${x.problem}`).join(' | ');
}
