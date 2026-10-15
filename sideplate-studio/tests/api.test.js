// End-to-end API test on a throwaway workspace: project, cast, attempts,
// license guard, reference pack via a Kaggle bundle, and results import.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sideplate-test-'));
process.env.SIDEPLATE_HOME = HOME;
const { createServer, initWorkspace } = await import('../server/index.js');
const { createZip, readZip } = await import('../server/zip.js');

let server;
let base;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
  '53de0000000c4944415408d763f8cfc0000003010100c9fe92ef0000000049454e44ae426082', 'hex');

async function call(method, p, body, raw) {
  const res = await fetch(base + p, {
    method,
    headers: { 'X-Sideplate': '1', ...(raw ? {} : { 'Content-Type': 'application/json' }) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data };
}
const upload = (p, filename, buf, meta) =>
  call('POST', `${p}?${new URLSearchParams({ filename, ...(meta ? { meta: JSON.stringify(meta) } : {}) })}`, undefined, buf);

before(async () => {
  initWorkspace();
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(HOME, { recursive: true, force: true }); });

test('first run creates the workspace, a default style and the registry', async () => {
  const { data } = await call('GET', '/api/state');
  assert.equal(data.counts.styles, 1);
  assert.ok(fs.existsSync(path.join(HOME, 'models', 'registry.json')));
  assert.ok(fs.existsSync(path.join(HOME, 'styles', 'anime-warm', 'style.json')));
});

test('full library flow', async () => {
  let r = await call('POST', '/api/projects', { name: 'Good Company', styleSlug: 'anime-warm', commercial: true });
  assert.equal(r.status, 200);
  r = await call('POST', '/api/library/characters', { name: 'Marco', role: 'Head chef', visual: 'thick moustache' });
  assert.equal(r.data.slug, 'marco');

  // license guard on direct uploads
  r = await upload('/api/library/characters/marco/attempts', 'a.png', PNG, { model: 'flux-1-dev' });
  assert.equal(r.status, 403);
  r = await upload('/api/library/characters/marco/attempts', 'a.png', PNG, { model: 'chatgpt-images', prompt: 'hi', rightsDeclared: true });
  assert.equal(r.status, 200);
  const attemptId = r.data.id;

  // reference pack before casting is refused
  r = await call('POST', '/api/library/characters/marco/refpack', { styleSlug: 'anime-warm', model: 'sdxl-base-1.0' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/library/characters/marco/cast', { attemptId });
  assert.equal(r.data.castAttemptId, attemptId);
  r = await call('POST', '/api/library/characters/marco/refpack', { styleSlug: 'anime-warm', model: 'sdxl-base-1.0', slots: ['front', 'side'] });
  assert.equal(r.data.length, 2);
  assert.ok(r.data.every((j) => j.status === 'queued'));
  assert.match(r.data[0].input.prompt, /anime style/);
  assert.match(r.data[0].input.prompt, /thick moustache/);

  // export, fake the worker, import
  r = await call('POST', '/api/jobs/export');
  assert.equal(r.status, 200);
  const bundle = readZip(r.data);
  const manifest = JSON.parse(bundle.get('manifest.json'));
  assert.equal(manifest.jobs.length, 2);
  assert.ok(bundle.get(manifest.jobs[0].refImage));
  const results = createZip([
    { name: 'results.json', data: JSON.stringify({ format: 'sideplate-results', version: 1, results: manifest.jobs.map((j) => ({ jobId: j.id, files: [`outputs/${j.id}_0.png`], seeds: [7] })) }) },
    ...manifest.jobs.map((j) => ({ name: `outputs/${j.id}_0.png`, data: PNG })),
  ]);
  r = await call('POST', '/api/jobs/import', undefined, results);
  assert.deepEqual([r.data.done, r.data.images], [2, 2]);
  r = await call('POST', '/api/jobs/import', undefined, results);
  assert.equal(r.data.skipped, 2, 'importing twice does not duplicate');

  r = await call('GET', '/api/library/characters/marco');
  assert.deepEqual(Object.keys(r.data.looks['anime-warm']).sort(), ['front', 'side']);
  assert.equal(r.data.looks['anime-warm'].front.seed, 7);

  // linking into a commercial project passes the guard
  r = await call('PUT', '/api/projects/good-company/links/characters', { ids: ['marco'] });
  assert.deepEqual(r.data.linked.characters, ['marco']);
});

test('manual job, retry and audio license rules', async () => {
  await call('POST', '/api/library/sets', { name: 'Kitchen', visual: 'copper pans', cameras: [{ name: 'wide', variants: ['day', 'night'] }] });
  let r = await call('GET', '/api/library/sets/kitchen');
  assert.deepEqual(r.data.slots.map((s) => s.id), ['wide--day', 'wide--night']);

  r = await call('POST', '/api/jobs', { capability: 'image.generate', model: 'chatgpt-images', target: { kind: 'sets', slug: 'kitchen', styleSlug: 'anime-warm' }, input: { prompt: 'evening' } });
  assert.equal(r.data.status, 'awaiting-upload');
  const id = r.data.id;
  r = await upload(`/api/jobs/${id}/upload`, 'k.png', PNG);
  assert.equal(r.data.job.status, 'done');
  r = await call('POST', `/api/jobs/${id}/retry`);
  assert.equal(r.status, 400, 'done jobs cannot be retried');

  r = await upload('/api/audio/music', 'theme.wav', Buffer.from('RIFF'), { title: 'Theme' });
  assert.equal(r.status, 400, 'a license is required');
  r = await upload('/api/audio/music', 'theme.wav', Buffer.from('RIFF'), { title: 'Theme', license: 'Unknown blog' });
  const trackId = r.data.id;
  r = await call('PUT', '/api/projects/good-company/links/audio', { ids: [trackId] });
  assert.equal(r.status, 403, 'uncleared track blocked from a commercial project');
});

test('safety: path traversal and foreign hosts are refused', async () => {
  let r = await call('GET', '/files/..%2F..%2Fetc%2Fpasswd');
  assert.ok([400, 404].includes(r.status));
  r = await call('GET', '/api/library/characters/..%2F..');
  assert.ok([400, 404].includes(r.status));
  // fetch() ignores a custom Host header, so use a raw request (as a DNS-rebinding page would arrive)
  const http = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/state', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
  const post = await fetch(`${base}/api/projects`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{"name":"x"}' });
  assert.equal(post.status, 403, 'writes from other websites are refused');
});
