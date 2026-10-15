// Regression tests for the Phase 1 review findings. Each test names the
// finding number it covers (see docs/phase1-review-response.md).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sideplate-reg-'));
process.env.SIDEPLATE_HOME = HOME;
const { createServer, initWorkspace } = await import('../server/index.js');
const { createZip, readZip } = await import('../server/zip.js');
const { testHooks } = await import('../server/store.js');
const library = await import('../server/library.js');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
  '53de0000000c4944415408d763f8cfc0000003010100c9fe92ef0000000049454e44ae426082', 'hex');
const PNG2 = Buffer.concat([PNG, Buffer.from('extra')]); // a different, still valid-looking PNG

let server;
let base;
let port;

async function call(method, p, body, { raw, headers = {} } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'X-Sideplate': '1', ...(raw ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data };
}
const upload = (p, filename, buf, meta) =>
  call('POST', `${p}?${new URLSearchParams({ filename, ...(meta ? { meta: JSON.stringify(meta) } : {}) })}`, undefined, { raw: buf });
const cleared = { model: 'chatgpt-images', rightsDeclared: true };

function rawRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(body);
  });
}

before(async () => {
  initWorkspace();
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  base = `http://localhost:${port}`;
  await call('POST', '/api/library/characters', { name: 'Marco', visual: 'moustache' });
  const a = await upload('/api/library/characters/marco/attempts', 'a.png', PNG, cleared);
  await call('POST', '/api/library/characters/marco/cast', { attemptId: a.data.id });
});
after(() => { server.close(); fs.rmSync(HOME, { recursive: true, force: true }); });

// ---------- P0 ----------

test('#1 a failed replacement never destroys the approved reference image', async () => {
  let r = await upload('/api/library/characters/marco/looks/anime-warm/front', 'front.png', PNG, cleared);
  assert.equal(r.status, 200);
  const approved = r.data;
  const approvedFile = path.join(HOME, 'library/characters/marco/looks/anime-warm', approved.file);
  assert.ok(fs.existsSync(approvedFile));

  // Simulate the disk failing while the new image is written.
  testHooks.beforeWrite = (file) => { if (file.includes('/looks/')) throw new Error('disk full (simulated)'); };
  assert.throws(() => library.setLook('characters', 'marco', 'anime-warm', 'front', 'new.png', PNG2, { ...cleared, source: 'upload' }, { approve: true }), /disk full/);
  testHooks.beforeWrite = null;

  r = await call('GET', '/api/library/characters/marco');
  assert.equal(r.data.looks['anime-warm'].front.id, approved.id, 'approved image is unchanged');
  assert.deepEqual(fs.readFileSync(approvedFile), PNG, 'approved file is intact');
});

test('#1 job results for an approved slot arrive as candidates, then approve / reject / restore', async () => {
  const before = (await call('GET', '/api/library/characters/marco')).data.looks['anime-warm'].front;
  const job = await call('POST', '/api/jobs', { capability: 'image.reference_pack', model: 'chatgpt-images', target: { kind: 'characters', slug: 'marco', styleSlug: 'anime-warm', slot: 'front' } });
  await upload(`/api/jobs/${job.data.id}/upload`, 'cand.png', PNG2);
  let a = (await call('GET', '/api/library/characters/marco')).data;
  assert.equal(a.looks['anime-warm'].front.id, before.id, 'approved image not replaced by a job result');
  const cand = a.lookVersions['anime-warm'].front.find((v) => v.status === 'candidate');
  assert.ok(cand, 'result kept as a candidate');

  let r = await call('POST', `/api/library/characters/marco/looks/anime-warm/front/versions/${cand.id}/approve`);
  assert.equal(r.data.looks['anime-warm'].front.id, cand.id);
  r = await call('POST', `/api/library/characters/marco/looks/anime-warm/front/versions/${before.id}/reject`);
  assert.equal(r.status, 200, 'the old approved image (now superseded) can be rejected');
  r = await call('POST', `/api/library/characters/marco/looks/anime-warm/front/versions/${cand.id}/reject`);
  assert.equal(r.status, 409, 'the approved image cannot be rejected');
  const trash = (await call('GET', '/api/trash')).data;
  assert.ok(trash.some((t) => t.reason.includes('Rejected front')), 'rejected file went to the trash');
});

test('#1 version-1 look.json files are read without moving any files', () => {
  const dir = path.join(HOME, 'library/characters/marco/looks/legacy-style');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'side.png'), PNG);
  fs.writeFileSync(path.join(dir, 'look.json'), JSON.stringify({ style: 'legacy-style', slots: { side: { file: 'side.png', model: 'chatgpt-images', source: 'kaggle', commercial: true } } }));
  const a = library.getAsset('characters', 'marco');
  assert.equal(a.looks['legacy-style'].side.file, 'side.png');
  assert.equal(a.looks['legacy-style'].side.rights.review, 'model-cleared');
  assert.ok(fs.existsSync(path.join(dir, 'side.png')));
});

test('#2 switching a project to commercial re-checks what is already linked', async () => {
  await call('POST', '/api/projects', { name: 'Sketches', styleSlug: 'anime-warm', commercial: false });
  await call('POST', '/api/library/characters', { name: 'Vale', visual: 'glasses' });
  const a = await upload('/api/library/characters/vale/attempts', 'v.png', PNG, { model: 'own-artwork' }); // rights not declared
  await call('POST', '/api/library/characters/vale/cast', { attemptId: a.data.id });
  let r = await call('PUT', '/api/projects/sketches/links/characters', { ids: ['vale'] });
  assert.equal(r.status, 200, 'non-commercial project may use it');

  r = await call('PUT', '/api/projects/sketches', { commercial: true });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Needs review/);
  assert.equal((await call('GET', '/api/projects/sketches')).data.commercial, false, 'project stays non-commercial');

  await call('PUT', `/api/library/characters/vale/attempts/${a.data.id}/rights`, { review: 'user-cleared' });
  r = await call('PUT', '/api/projects/sketches', { commercial: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.commercial, true);
});

test('#3 a model missing from the registry fails closed', async () => {
  await call('POST', '/api/models', { id: 'temp-model', label: 'Temp', capabilities: ['image.generate'], adapter: 'manual-import', license: 'X', commercial: true });
  await call('POST', '/api/library/sets', { name: 'Diner' });
  const a = await upload('/api/library/sets/diner/attempts', 'd.png', PNG, { model: 'temp-model', rightsDeclared: true });
  await call('POST', '/api/library/sets/diner/cast', { attemptId: a.data.id });
  // remove the model from the registry by hand, as a user might
  const regFile = path.join(HOME, 'models/registry.json');
  const reg = JSON.parse(fs.readFileSync(regFile));
  reg.models = reg.models.filter((m) => m.id !== 'temp-model');
  fs.writeFileSync(regFile, JSON.stringify(reg));
  await call('POST', '/api/projects', { name: 'Paid show', styleSlug: 'anime-warm', commercial: true });
  const r = await call('PUT', '/api/projects/paid-show/links/sets', { ids: ['diner'] });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /not in the model registry/);
});

test('#4 direct uploads need a rights declaration; meta cannot switch off the guard', async () => {
  let r = await upload('/api/library/characters/marco/attempts', 'x.png', PNG, { model: 'own-artwork' });
  assert.equal(r.data.rights.review, 'needs-review');
  r = await upload('/api/library/characters/marco/attempts', 'x.png', PNG, { model: 'own-artwork', rightsDeclared: true, evidence: 'drawn by me, sketchbook p.4' });
  assert.equal(r.data.rights.review, 'evidence-on-file');
  r = await upload('/api/library/characters/marco/attempts', 'x.png', PNG, { model: 'flux-1-dev', commercial: false });
  assert.equal(r.status, 403, '"commercial: false" in upload meta is ignored');
  r = await upload('/api/library/characters/marco/attempts', 'x.png', Buffer.from('not an image'), cleared);
  assert.equal(r.status, 400, 'non-image content refused');
});

test('#4 uncleared music is blocked; clearing with evidence allows it', async () => {
  let r = await upload('/api/audio/music', 'theme.wav', Buffer.from('RIFF....WAVE'), { title: 'Theme', license: 'CC BY 4.0' });
  assert.equal(r.data.rights.review, 'needs-review');
  const id = r.data.id;
  r = await call('PUT', '/api/projects/paid-show/links/audio', { ids: [id] });
  assert.equal(r.status, 403);
  await call('PUT', `/api/audio/music/${id}`, { commercialOk: true, evidence: 'https://creativecommons.org/licenses/by/4.0/' });
  r = await call('PUT', '/api/projects/paid-show/links/audio', { ids: [id] });
  assert.equal(r.status, 200);
  r = await call('DELETE', `/api/audio/music/${id}`);
  assert.equal(r.status, 409, 'a linked track cannot be deleted');
});

// ---------- P1 ----------

test('#5 zip reader refuses bombs, damage, duplicates and unsafe names', () => {
  const good = createZip([{ name: 'a.txt', data: 'x'.repeat(5000) }]);
  assert.equal(readZip(good).get('a.txt').length, 5000);
  // lie about the uncompressed size (central directory field at offset 24)
  const cd = good.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const bomb = Buffer.from(good);
  bomb.writeUInt32LE(10, cd + 24);
  assert.throws(() => readZip(bomb), /expands beyond its declared size/);
  const damaged = Buffer.from(good);
  damaged.writeUInt32LE(123, cd + 16);
  assert.throws(() => readZip(damaged), /checksum/);
  assert.throws(() => readZip(createZip([{ name: 'a', data: '1' }, { name: 'a', data: '2' }])), /twice/);
  assert.throws(() => readZip(createZip([{ name: '../evil', data: '1' }])), /Unsafe/);
  assert.throws(() => readZip(good.subarray(0, good.length - 30)), /zip/i);
});

async function exportBundle() {
  const r = await call('POST', '/api/jobs/export');
  assert.equal(r.status, 200);
  const files = readZip(r.data);
  return JSON.parse(files.get('manifest.json'));
}
function resultsZip(manifest, { jobs = manifest.jobs, image = PNG } = {}) {
  return createZip([
    { name: 'results.json', data: JSON.stringify({ format: 'sideplate-results', version: 1, bundleId: manifest.bundleId, results: jobs.map((j) => ({ jobId: j.id, jobRev: j.rev, files: [`outputs/${j.id}_0.png`], seeds: [1] })) }) },
    ...jobs.map((j) => ({ name: `outputs/${j.id}_0.png`, data: image })),
  ]);
}

test('#6 stale results (job retried after export) are refused; re-import is idempotent', async () => {
  const job = (await call('POST', '/api/jobs', { capability: 'image.generate', model: 'sdxl-base-1.0', target: { kind: 'characters', slug: 'marco', styleSlug: 'anime-warm' }, input: { prompt: 'p' } })).data;
  const m1 = await exportBundle();
  const old = resultsZip(m1);
  await call('POST', `/api/jobs/${job.id}/cancel`);
  await call('POST', `/api/jobs/${job.id}/retry`);
  let r = await call('POST', '/api/jobs/import', undefined, { raw: old });
  assert.equal(r.data.done, 0);
  assert.match(r.data.messages.join(' '), /stale/);

  const m2 = await exportBundle();
  const fresh = resultsZip(m2);
  r = await call('POST', '/api/jobs/import', undefined, { raw: fresh });
  assert.equal(r.data.done, 1);
  const attempts = (await call('GET', '/api/library/characters/marco')).data.attempts.length;
  r = await call('POST', '/api/jobs/import', undefined, { raw: fresh });
  assert.equal(r.data.skipped, 1);
  assert.equal((await call('GET', '/api/library/characters/marco')).data.attempts.length, attempts, 'no duplicates');
});

test('#6 an import with one invalid image saves nothing (staged)', async () => {
  const job = (await call('POST', '/api/jobs', { capability: 'image.generate', model: 'sdxl-base-1.0', target: { kind: 'characters', slug: 'marco', styleSlug: 'anime-warm' }, input: { prompt: 'q' } })).data;
  const m = await exportBundle();
  const before = (await call('GET', '/api/library/characters/marco')).data.attempts.length;
  const r = await call('POST', '/api/jobs/import', undefined, { raw: resultsZip(m, { image: Buffer.from('garbage') }) });
  assert.equal(r.status, 400);
  assert.equal((await call('GET', '/api/library/characters/marco')).data.attempts.length, before);
  assert.equal((await call('GET', `/api/jobs/${job.id}`)).data.status, 'exported', 'job untouched, can be imported again');
  const dup = createZip([{ name: 'results.json', data: JSON.stringify({ format: 'sideplate-results', results: [{ jobId: job.id, files: [] }, { jobId: job.id, files: [] }] }) }]);
  assert.equal((await call('POST', '/api/jobs/import', undefined, { raw: dup })).status, 400, 'duplicate job ids refused');
  await call('POST', `/api/jobs/${job.id}/cancel`);
});

test('#7 re-uploading a scene file keeps the previous version', async () => {
  await upload('/api/library/sets/diner/scene', 'kitchen.blend', Buffer.from('v1'));
  const r = await upload('/api/library/sets/diner/scene', 'kitchen.blend', Buffer.from('v2'));
  assert.equal(r.data.keptPrevious, true);
  const dir = path.join(HOME, 'library/sets/diner/scene');
  assert.equal(fs.readFileSync(path.join(dir, 'kitchen.blend'), 'utf8'), 'v2');
  const versions = fs.readdirSync(path.join(dir, 'versions'));
  assert.equal(fs.readFileSync(path.join(dir, 'versions', versions[0]), 'utf8'), 'v1');
});

test('#8 backup copies the workspace and verifies it', async () => {
  const r = await call('POST', '/api/backups');
  assert.equal(r.status, 200);
  assert.equal(r.data.verified, true);
  assert.ok(r.data.checked > 5);
  fs.rmSync(path.join(r.data.path, 'workspace.json'));
  const v = await call('POST', `/api/backups/${r.data.name}/verify`);
  assert.equal(v.data.verified, false);
  assert.match(v.data.problems.join(' '), /workspace.json/);
  fs.rmSync(`${HOME}-backups`, { recursive: true, force: true });
});

test('#9 writes need the studio header and its exact origin; files are allowlisted', async () => {
  assert.equal(await rawRequest({ method: 'POST', path: '/api/projects', headers: { Host: `localhost:${port}`, 'Content-Type': 'application/json' } }, '{"name":"x"}'), 403, 'no X-Sideplate header');
  assert.equal(await rawRequest({ method: 'POST', path: '/api/projects', headers: { Host: `localhost:${port}`, 'X-Sideplate': '1', Origin: 'http://localhost:3000' } }, '{"name":"x"}'), 403, 'other local port');
  assert.equal(await rawRequest({ method: 'GET', path: '/api/state', headers: { Host: `localhost:${port + 1}` } }), 403, 'wrong port in Host');
  assert.equal(await rawRequest({ method: 'GET', path: '/api/state', headers: { Host: 'evil.example' } }), 403, 'DNS rebinding');
  assert.equal((await call('GET', '/files/workspace.json')).status, 404, 'JSON sidecars are not served raw');
  assert.equal((await call('GET', '/files/models/registry.json')).status, 404);
  fs.symlinkSync('/etc/hostname', path.join(HOME, 'library/escape.png'));
  assert.equal((await call('GET', '/files/library/escape.png')).status, 404, 'symlink escape refused');
});

test('#10 uploads stream to disk and over-limit uploads are refused', async () => {
  const status = await rawRequest({ method: 'POST', path: '/api/library/characters/marco/attempts?filename=a.png', headers: { Host: `localhost:${port}`, 'X-Sideplate': '1', 'Content-Length': String(60 * 1024 ** 2) } }, '');
  assert.equal(status, 413);
  assert.deepEqual(fs.readdirSync(path.join(HOME, '.tmp-uploads')), [], 'no temp files left behind');
});

test('#11 deleting is safe: cast winner protected, files go to trash and can be restored', async () => {
  const a = (await call('GET', '/api/library/characters/marco')).data;
  const cast = a.attempts.find((x) => x.id === a.castAttemptId);
  let r = await call('DELETE', `/api/library/characters/marco/files/history/${cast.file}`);
  assert.equal(r.status, 409);
  const other = a.attempts.find((x) => x.id !== a.castAttemptId);
  r = await call('DELETE', `/api/library/characters/marco/files/history/${other.file}`);
  assert.equal(r.status, 200);
  assert.ok(!r.data.attempts.some((x) => x.id === other.id));
  const item = (await call('GET', '/api/trash')).data.find((t) => t.name === other.file);
  r = await call('POST', `/api/trash/${item.id}/restore`);
  assert.equal(r.status, 200);
  assert.ok((await call('GET', '/api/library/characters/marco')).data.attempts.some((x) => x.id === other.id), 'restored with its record');
});

// ---------- P2 ----------

test('#18 renaming a camera keeps its plates; removing a camera with plates is refused', async () => {
  let r = await call('POST', '/api/library/sets', { name: 'Kitchen', cameras: [{ name: 'wide', variants: ['day'] }] });
  const camId = r.data.cameras[0].id;
  await upload('/api/library/sets/kitchen/attempts', 'k.png', PNG, cleared).then((x) => call('POST', '/api/library/sets/kitchen/cast', { attemptId: x.data.id }));
  await upload(`/api/library/sets/kitchen/looks/anime-warm/${camId}--day`, 'p.png', PNG, cleared);
  r = await call('PUT', '/api/library/sets/kitchen', { cameras: [{ id: camId, name: 'Kitchen wide (renamed)', variants: ['day'] }] });
  assert.equal(r.status, 200);
  assert.equal(r.data.cameras[0].id, camId, 'id kept');
  assert.ok(r.data.looks['anime-warm'][`${camId}--day`], 'plate still connected');
  r = await call('PUT', '/api/library/sets/kitchen', { cameras: [] });
  assert.equal(r.status, 409);
  r = await call('PUT', '/api/library/sets/kitchen', { cameras: [{ id: camId, name: 'wide', variants: ['daytime'] }] });
  assert.equal(r.status, 409, 'renaming a variant with plates is refused');
});

test('#19 cameras.json is a generated copy of set.json', () => {
  const cams = JSON.parse(fs.readFileSync(path.join(HOME, 'library/sets/kitchen/cameras.json')));
  const set = JSON.parse(fs.readFileSync(path.join(HOME, 'library/sets/kitchen/set.json')));
  assert.equal(cams.generatedFrom, 'set.json');
  assert.deepEqual(cams.cameras, set.cameras);
});

test('#20 frame rate and output formats are validated', async () => {
  for (const fps of [-5, 0, 1e9, 'abc']) {
    assert.equal((await call('PUT', '/api/projects/paid-show', { fps })).status, 400, `fps ${fps}`);
  }
  const r = await call('PUT', '/api/projects/paid-show', { fps: 25, extraOutputs: ['9:16', '16:9', 'bogus'] });
  assert.equal(r.data.format.fps, 25);
  assert.deepEqual(r.data.extraOutputs, ['9:16'], 'primary format and unknown formats are dropped');
  for (const [seed, want] of [[42, 42], [-1, null], [1e20, null], ['7', 7]]) {
    const j = await call('POST', '/api/jobs', { capability: 'image.generate', model: 'chatgpt-images', target: { kind: 'characters', slug: 'marco', styleSlug: 'anime-warm' }, input: { prompt: 'x', seed } });
    assert.equal(j.data.input.seed, want, `seed ${seed}`);
    await call('POST', `/api/jobs/${j.data.id}/cancel`);
  }
});
