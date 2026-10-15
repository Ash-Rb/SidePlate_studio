// Contract tests: every adapter and every registry entry must pass these.
// Adding a new tool = adding an adapter, then making this file pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS, CAPABILITIES } from '../server/adapters/index.js';
import { DEFAULT_MODELS, checkModelUse } from '../server/registry.js';
import { createZip, readZip, crc32 } from '../server/zip.js';

const SUBMIT_STATUSES = new Set(['queued', 'awaiting-upload']);

for (const adapter of ADAPTERS) {
  test(`adapter ${adapter.id}: shape`, () => {
    assert.match(adapter.id, /^[a-z0-9-]+$/);
    assert.ok(adapter.label, 'needs a label');
    assert.ok(['manual', 'batch'].includes(adapter.kind), 'kind is manual or batch');
    assert.ok(adapter.capabilities.length > 0, 'implements at least one capability');
    for (const c of adapter.capabilities) assert.ok(CAPABILITIES[c], `unknown capability ${c}`);
    assert.equal(typeof adapter.submit, 'function');
  });

  test(`adapter ${adapter.id}: submit returns a valid status`, () => {
    const out = adapter.submit({ id: 'job-1', input: { prompt: 'x' } });
    assert.ok(SUBMIT_STATUSES.has(out.status), `status ${out.status}`);
  });

  if (adapter.kind === 'batch') {
    test(`adapter ${adapter.id}: bundle -> results round trip`, () => {
      const ref = Buffer.from('fake-png');
      const jobs = [
        { id: 'job-a', capability: 'image.generate', model: 'm', input: { prompt: 'p', count: 2, width: 1024, height: 1024 } },
        { id: 'job-b', capability: 'image.reference_pack', model: 'm', input: { prompt: 'q', slot: 'front', refImage: '/x/ref.png' } },
      ];
      const { entries, manifest } = adapter.buildBundle(jobs, () => ref);
      assert.equal(manifest.jobs.length, 2);
      const zip = readZip(createZip(entries));
      assert.ok(zip.has('manifest.json'));
      assert.deepEqual(zip.get(manifest.jobs[1].refImage), ref);

      const results = createZip([
        { name: 'results.json', data: JSON.stringify({ format: 'sideplate-results', version: 1, results: [
          { jobId: 'job-a', files: ['outputs/job-a_0.png', 'outputs/job-a_1.png'], seeds: [1, 2] },
          { jobId: 'job-b', error: 'out of memory', files: [] },
          { jobId: 'job-c', files: ['../../evil.png'] },
        ] }) },
        { name: 'outputs/job-a_0.png', data: 'img0' },
        { name: 'outputs/job-a_1.png', data: 'img1' },
      ]);
      const parsed = adapter.parseResults(readZip(results));
      assert.equal(parsed[0].outputs.length, 2);
      assert.equal(parsed[0].outputs[1].seed, 2);
      assert.equal(parsed[1].error, 'out of memory');
      assert.equal(parsed[2].outputs.length, 0, 'paths outside outputs/ are ignored');
    });
  }
}

test('every registry model points at a real adapter and known capabilities', () => {
  for (const m of DEFAULT_MODELS) {
    if (m.status === 'available') assert.ok(ADAPTERS.some((a) => a.id === m.adapter), `${m.id}: no adapter ${m.adapter}`);
    for (const c of m.capabilities) assert.ok(CAPABILITIES[c], `${m.id}: unknown capability ${c}`);
  }
});

test('license guard', () => {
  const by = (id) => DEFAULT_MODELS.find((m) => m.id === id);
  assert.equal(checkModelUse(by('sdxl-base-1.0'), { commercial: true, region: 'EU' }).ok, true);
  assert.equal(checkModelUse(by('flux-1-dev'), { commercial: true, region: 'US' }).ok, false);
  assert.equal(checkModelUse({ ...by('hunyuan3d-2'), status: 'available' }, { commercial: false, region: 'UK' }).ok, false);
  assert.equal(checkModelUse({ ...by('hunyuan3d-2'), status: 'available' }, { commercial: true, region: 'US' }).ok, true);
  assert.equal(checkModelUse({ ...by('flux-1-dev'), status: 'available' }, { commercial: false, region: 'EU' }).ok, true);
});

test('zip: crc32 and deflate round trip', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const text = 'hello '.repeat(1000);
  const out = readZip(createZip([{ name: 'a/b.txt', data: text }, { name: 'c.png', data: Buffer.from([1, 2, 3]) }]));
  assert.equal(out.get('a/b.txt').toString(), text);
  assert.deepEqual([...out.get('c.png')], [1, 2, 3]);
});
