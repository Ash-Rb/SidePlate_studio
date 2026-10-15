// Mocked notebook round trip: studio export -> worker notebook (with a
// stand-in GPU, worker/mock_run.py) -> studio import. This proves the bundle
// and results formats agree and the notebook's control flow works. It does
// NOT prove the notebook runs on a real GPU; that is a separate manual check.
// Skipped when python3 with Pillow is not installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const python = spawnSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' });
const hasPython = python.status === 0;

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sideplate-nb-'));
process.env.SIDEPLATE_HOME = HOME;
const { createServer, initWorkspace } = await import('../server/index.js');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
  '53de0000000c4944415408d763f8cfc0000003010100c9fe92ef0000000049454e44ae426082', 'hex');
const WORKER = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'worker', 'mock_run.py');

let server;
let base;
async function call(method, p, body, raw) {
  const res = await fetch(base + p, {
    method, headers: { 'X-Sideplate': '1', ...(raw ? {} : { 'Content-Type': 'application/json' }) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

before(async () => {
  initWorkspace();
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(HOME, { recursive: true, force: true }); });

test('mocked notebook round trip (stand-in GPU, not a real GPU test)', { skip: !hasPython && 'python3 with Pillow not installed' }, async () => {
  await call('POST', '/api/library/characters', { name: 'Marco', visual: 'moustache' });
  const q = new URLSearchParams({ filename: 'a.png', meta: JSON.stringify({ model: 'chatgpt-images', rightsDeclared: true }) });
  const a = await call('POST', `/api/library/characters/marco/attempts?${q}`, undefined, PNG);
  await call('POST', '/api/library/characters/marco/cast', { attemptId: a.data.id });
  await call('POST', '/api/jobs', { capability: 'image.generate', model: 'sdxl-base-1.0', target: { kind: 'characters', slug: 'marco', styleSlug: 'anime-warm' }, input: { prompt: 'p', count: 2, seed: 5 } });
  await call('POST', '/api/library/characters/marco/refpack', { styleSlug: 'anime-warm', model: 'sdxl-base-1.0', slots: ['front', 'side'] });

  const bundles = fs.mkdtempSync(path.join(os.tmpdir(), 'sideplate-bundles-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sideplate-work-'));
  const exp = await call('POST', '/api/jobs/export');
  fs.writeFileSync(path.join(bundles, 'bundle-a.zip'), exp.data);

  const log = execFileSync('python3', [WORKER, bundles, work, '--oom-once'], { encoding: 'utf8' });
  assert.match(log, /3 unique jobs, 4 images/);
  // second run: everything is skipped, nothing regenerated
  const log2 = execFileSync('python3', [WORKER, bundles, work], { encoding: 'utf8' });
  assert.equal((log2.match(/already done, skipping/g) || []).length, 3);

  const results = fs.readFileSync(path.join(work, 'results.zip'));
  const r = await call('POST', '/api/jobs/import', undefined, results);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, 3);
  assert.equal(r.data.images, 4);
  const marco = (await call('GET', '/api/library/characters/marco')).data;
  assert.ok(marco.looks['anime-warm'].front && marco.looks['anime-warm'].side);
  const gen = marco.attempts.filter((x) => x.source === 'kaggle');
  assert.deepEqual(gen.map((x) => x.seed).sort(), [5, 6], 'seeds come back');
  const jobs = (await call('GET', '/api/jobs?status=done')).data;
  assert.ok(jobs.some((j) => j.diagnostics?.notes?.some((n) => n.includes('out of memory'))), 'OOM fallback recorded in diagnostics');
  fs.rmSync(bundles, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});
