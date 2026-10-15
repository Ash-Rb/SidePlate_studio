// Sideplate Studio interface. Plain JavaScript, no build step.
// Everything is saved through the local server into the SideplateStudio folders.

const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ui = { tabs: {}, starredOnly: {} };
let STATE = null;

// ---------- server calls ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Sideplate': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}
const get = (p) => api('GET', p);

async function uploadTo(path, file, meta) {
  const q = new URLSearchParams({ filename: file.name });
  if (meta) q.set('meta', JSON.stringify(meta));
  const res = await fetch(`${path}?${q}`, { method: 'POST', body: file, headers: { 'X-Sideplate': '1' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

// ---------- small UI helpers ----------
function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), bad ? 9000 : 3200);
}

// Runs an action, shows errors as toasts, re-renders on success.
async function act(fn, okMsg, { rerender = true } = {}) {
  try {
    const out = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(out) : okMsg);
    if (rerender) await render();
    return out;
  } catch (err) {
    toast(err.message, true);
    return null;
  }
}

function drop(id, label, accept = '', multiple = false) {
  return `<label class="drop" id="${id}"><input type="file" ${accept ? `accept="${accept}"` : ''} ${multiple ? 'multiple' : ''}><span>${label}</span></label>`;
}

function bindDrop(id, onFiles, root = app) {
  const el = $(`#${id}`, root);
  if (!el) return;
  const input = $('input', el);
  input.addEventListener('change', () => input.files.length && onFiles([...input.files]));
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('over');
    if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
  });
}

function lightbox(url) {
  const el = document.createElement('div');
  el.className = 'lightbox';
  el.innerHTML = `<img src="${esc(url)}" alt="">`;
  el.addEventListener('click', () => el.remove());
  document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { el.remove(); document.removeEventListener('keydown', onKey); } });
  document.body.append(el);
}

function on(sel, event, fn, root = app) {
  $$(sel, root).forEach((el) => el.addEventListener(event, (e) => fn(e, el)));
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const initials = (name) => esc((name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase());
const opt = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
const pillFor = (status) => {
  const cls = { done: 'good', failed: 'bad', cancelled: '', queued: 'accent', exported: 'warn', 'awaiting-upload': 'warn' }[status] ?? '';
  const label = { 'awaiting-upload': 'waiting for your upload', exported: 'exported: upload to Kaggle', queued: 'queued for next export' }[status] || status;
  return `<span class="pill ${cls}">${esc(label)}</span>`;
};

// Rights review state of an image or track (see server/rights.js).
const RIGHTS_CLASS = { 'needs-review': 'bad', 'model-cleared': 'warn', 'user-cleared': 'good', 'evidence-on-file': 'good' };
const rightsPill = (rights) => {
  const review = rights?.review || 'needs-review';
  const label = STATE?.reviewLabels?.[review] || review;
  const title = [rights?.basis, rights?.evidence && `Evidence: ${rights.evidence}`].filter(Boolean).join(' · ');
  return `<span class="pill ${RIGHTS_CLASS[review] || ''}" title="${esc(title)}">${esc(label)}</span>`;
};

// The rights declaration shown wherever an image is added by hand.
function rightsFields(prefix) {
  return `
    <div class="form" style="gap:8px;margin-top:10px">
      <label class="field"><span>Where it comes from</span><select id="${prefix}-origin">
        ${opt('generated', 'Made with an AI model (picked above)')}${opt('own-work', 'My own work')}${opt('third-party', 'Someone else\'s work')}</select></label>
      <label class="check"><input type="checkbox" id="${prefix}-declared"><span>I have checked I may use this in a monetized video.</span></label>
      <label class="field"><span>Evidence (optional)</span><input id="${prefix}-evidence" placeholder="License link, receipt, or a note"></label>
      <p class="tiny" style="margin:0">Unticked, the image is saved but marked <strong>Needs review</strong>, and commercial projects cannot use it until you clear it.</p>
    </div>`;
}
const rightsMeta = (prefix) => ({
  origin: $(`#${prefix}-origin`)?.value,
  rightsDeclared: Boolean($(`#${prefix}-declared`)?.checked),
  evidence: $(`#${prefix}-evidence`)?.value || '',
});

// Mark something as cleared after checking it.
async function clearRights(path) {
  const evidence = prompt('You are confirming you may use this in a monetized video.\n\nEvidence (a license link, receipt or note). Leave empty to just mark it cleared:', '');
  if (evidence === null) return;
  await act(() => api('PUT', path, { review: evidence.trim() ? 'evidence-on-file' : 'user-cleared', evidence: evidence.trim() }), 'Marked as cleared');
}

function tabs(key, list) {
  const current = ui.tabs[key] && list.some((t) => t[0] === ui.tabs[key]) ? ui.tabs[key] : list[0][0];
  ui.tabs[key] = current;
  return {
    current,
    html: `<div class="tabs" role="tablist">${list.map(([id, label]) => `<button role="tab" data-tab="${id}" class="${id === current ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`,
    bind() { on('[data-tab]', 'click', (e, el) => { ui.tabs[key] = el.dataset.tab; render(); }); },
  };
}

// ---------- router ----------
const ROUTES = [
  [/^\/$/, viewHome, ''],
  [/^\/projects$/, viewProjects, 'projects'],
  [/^\/projects\/([a-z0-9-]+)$/, viewProject, 'projects'],
  [/^\/cast$/, () => viewAssets('characters'), 'cast'],
  [/^\/cast\/([a-z0-9-]+)$/, (s) => viewAsset('characters', s), 'cast'],
  [/^\/sets$/, () => viewAssets('sets'), 'sets'],
  [/^\/sets\/([a-z0-9-]+)$/, (s) => viewAsset('sets', s), 'sets'],
  [/^\/voices$/, viewVoices, 'voices'],
  [/^\/audio$/, viewAudio, 'audio'],
  [/^\/styles$/, viewStyles, 'styles'],
  [/^\/styles\/([a-z0-9-]+)$/, viewStyle, 'styles'],
  [/^\/jobs$/, viewJobs, 'jobs'],
  [/^\/models$/, viewModels, 'models'],
  [/^\/settings$/, viewSettings, 'settings'],
];

let lastPath = null;
async function render() {
  const path = location.hash.replace(/^#/, '') || '/';
  const scroll = path === lastPath ? window.scrollY : 0;
  const match = ROUTES.map(([re, fn, nav]) => [re.exec(path), fn, nav]).find(([m]) => m);
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === match?.[2]));
  try {
    STATE = await get('/api/state');
    const badge = $('#jobs-badge');
    badge.hidden = !STATE.counts.openJobs;
    badge.textContent = STATE.counts.openJobs;
    if (!match) { app.innerHTML = '<div class="empty">Page not found. <a href="#/">Go home</a></div>'; return; }
    await match[1](...match[0].slice(1));
  } catch (err) {
    app.innerHTML = `<div class="notice bad"><strong>Could not load this page.</strong> ${esc(err.message)}<br><span class="small">Is the studio server still running? Start it with <span class="mono">npm start</span>.</span></div>`;
  }
  if (path !== lastPath) app.focus({ preventScroll: true });
  window.scrollTo(0, scroll);
  lastPath = path;
}
window.addEventListener('hashchange', render);

// ---------- home ----------
async function viewHome() {
  const [projects, chars, sets, styles] = await Promise.all([get('/api/projects'), get('/api/library/characters'), get('/api/library/sets'), get('/api/styles')]);
  const c = STATE.counts;
  const hasCast = chars.some((x) => x.thumb);
  let hasPack = false;
  for (const ch of chars.filter((x) => x.thumb).slice(0, 5)) {
    const full = await get(`/api/library/characters/${ch.slug}`);
    if (Object.values(full.looks).some((l) => Object.keys(l).length >= 4)) { hasPack = true; break; }
  }
  const todo = [
    [styles.length > 0, 'Set up an art style', '#/styles'],
    [projects.length > 0, 'Create your first project (e.g. Good Company)', '#/projects'],
    [chars.length > 0, 'Add a character to the cast', '#/cast'],
    [hasCast, 'Generate attempts and cast a winner', '#/cast'],
    [hasPack, 'Build a reference pack for a cast member', '#/cast'],
    [sets.length > 0, 'Add a set with named cameras', '#/sets'],
  ];
  app.innerHTML = `
    <div class="page-head"><div>
      <h1>${esc(STATE.workspace.name)}</h1>
      <p class="lead">Build your cast, sets, voices and music once, then reuse them in every episode and every project.</p>
    </div></div>
    <div class="tiles" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">
      ${[[c.projects, 'Projects', '#/projects'], [c.characters, 'Cast members', '#/cast'], [c.sets, 'Sets', '#/sets'], [c.styles, 'Art styles', '#/styles'], [c.music + c.sfx, 'Music & SFX', '#/audio'], [c.openJobs, 'Open jobs', '#/jobs']]
        .map(([n, l, href]) => `<a class="card stat" href="${href}" style="text-decoration:none;color:inherit"><div class="n">${n}</div><div class="l">${l}</div></a>`).join('')}
    </div>
    <div class="grid grid-2" style="margin-top:20px">
      <div class="card"><h2>Getting started</h2>
        <ul class="todo">${todo.map(([done, label, href]) => `<li class="${done ? 'done' : ''}"><span class="tick">${done ? '✓' : ''}</span><span><a href="${href}" style="color:inherit">${esc(label)}</a></span></li>`).join('')}</ul>
      </div>
      <div class="card"><h2>How generation works</h2>
        <ol class="steps small">
          <li><strong>By hand (instant):</strong> pick "ChatGPT image generation", copy the prompt the studio writes, generate in ChatGPT, drop the image back in.</li>
          <li><strong>Kaggle batch (free GPU):</strong> queue jobs all week, then on batch day export one bundle, run the worker notebook on Kaggle, and import the results.</li>
          <li>Every attempt is kept with its prompt, model and license. Star the good ones and <strong>cast</strong> the winner.</li>
          <li>From the winner, build a <strong>reference pack</strong> per art style: views and expressions that keep the character consistent.</li>
        </ol>
        <p class="tiny">Your data lives in <span class="mono">${esc(STATE.home)}</span></p>
      </div>
    </div>`;
}

// ---------- projects ----------
async function viewProjects() {
  const [projects, styles] = await Promise.all([get('/api/projects'), get('/api/styles')]);
  app.innerHTML = `
    <div class="page-head"><div><h1>Projects</h1><p class="lead">Each show is a project with its own art style and format. Cast and sets are linked from the shared library, never copied.</p></div></div>
    <div class="grid grid-3">
      ${projects.map((pr) => `
        <a class="card" href="#/projects/${pr.slug}" style="text-decoration:none;color:inherit">
          <div class="spread"><h2 style="margin:0">${esc(pr.name)}</h2>${pr.commercial ? '<span class="pill accent">commercial</span>' : '<span class="pill">personal</span>'}</div>
          <p class="small muted" style="margin:8px 0 0">${esc(styles.find((s) => s.slug === pr.styleSlug)?.name || 'No style yet')} · ${esc(pr.format?.aspect || '16:9')} · ${esc(pr.cadence || 'no cadence')}</p>
          <p class="tiny">${pr.linked?.characters?.length || 0} cast · ${pr.linked?.sets?.length || 0} sets · ${pr.linked?.audio?.length || 0} tracks</p>
        </a>`).join('')}
    </div>
    <div class="card" style="margin-top:20px">
      <h2>New project</h2>
      <form id="new-project" class="form-2">
        <label class="field"><span>Name</span><input name="name" required placeholder="Good Company"></label>
        <label class="field"><span>Channel</span><input name="channel" placeholder="Side Plate"></label>
        <label class="field"><span>Art style</span><select name="styleSlug">${styles.map((s) => opt(s.slug, s.name)).join('')}</select></label>
        <label class="field"><span>Format</span><select name="aspect">${['16:9', '9:16', '1:1', '4:5'].map((a) => opt(a, a)).join('')}</select></label>
        <label class="check"><input type="checkbox" name="commercial" checked><span>Commercial (monetized). Only commercially licensed models and tracks are allowed.</span></label>
        <div class="row" style="align-self:end"><button class="primary">Create project</button></div>
      </form>
    </div>`;
  on('#new-project', 'submit', (e, form) => {
    e.preventDefault();
    act(async () => {
      const pr = await api('POST', '/api/projects', formData(form));
      location.hash = `#/projects/${pr.slug}`;
    }, 'Project created', { rerender: false });
  });
}

async function viewProject(slug) {
  const [pr, styles, chars, sets, music, sfx, audit] = await Promise.all([
    get(`/api/projects/${slug}`), get('/api/styles'), get('/api/library/characters'), get('/api/library/sets'), get('/api/audio/music'), get('/api/audio/sfx'),
    get(`/api/projects/${slug}/audit`),
  ]);
  const extra = pr.extraOutputs || [];
  const linkList = (kind, items, label) => `
    <div class="card">
      <div class="spread"><h2 style="margin:0">${label}</h2><button data-save-links="${kind}">Save ${label.toLowerCase()}</button></div>
      ${items.length ? `<div class="stack" style="margin-top:12px">${items.map((it) => `
        <label class="check"><input type="checkbox" data-link="${kind}" value="${esc(it.id)}" ${pr.linked?.[kind]?.includes(it.id) ? 'checked' : ''}>
          <span>${esc(it.label)} ${it.extra || ''}</span></label>`).join('')}</div>` : `<p class="muted small">Nothing in the library yet.</p>`}
    </div>`;
  app.innerHTML = `
    <div class="crumb"><a href="#/projects">Projects</a></div>
    <div class="page-head"><div><h1>${esc(pr.name)}</h1><p class="lead">${esc(pr.channel ? `Channel: ${pr.channel}` : 'Project settings and what it uses from the library.')}</p></div></div>
    <div class="grid grid-2">
      <div class="card">
        <h2>Settings</h2>
        <form id="proj-form" class="form">
          <div class="form-2">
            <label class="field"><span>Name</span><input name="name" value="${esc(pr.name)}"></label>
            <label class="field"><span>Channel</span><input name="channel" value="${esc(pr.channel || '')}"></label>
            <label class="field"><span>Art style</span><select name="styleSlug">${styles.map((s) => opt(s.slug, s.name, s.slug === pr.styleSlug)).join('')}</select></label>
            <label class="field"><span>Main format</span><select name="aspect">${[['16:9', '16:9 landscape (episodes)'], ['9:16', '9:16 vertical (Shorts)'], ['1:1', '1:1 square'], ['4:5', '4:5 portrait']].map(([a, l]) => opt(a, l, a === pr.format?.aspect)).join('')}</select></label>
            <label class="field"><span>Frame rate</span><select name="fps">${[24, 25, 30, 50, 60].map((f) => opt(f, `${f} fps`, f === pr.format?.fps)).join('')}</select></label>
            <label class="field"><span>Release cadence</span><input name="cadence" value="${esc(pr.cadence || '')}" placeholder="weekly"></label>
            <label class="field"><span>Episode length</span><input name="episodeLength" value="${esc(pr.episodeLength || '')}" placeholder="5 to 10 min"></label>
          </div>
          <fieldset style="border:0;padding:0;margin:0"><legend class="small" style="font-weight:600;margin-bottom:6px">Also made from the same timeline</legend><div class="row">
            ${[['9:16', '9:16 Shorts'], ['1:1', '1:1 square'], ['4:5', '4:5 portrait']].filter(([a]) => a !== pr.format?.aspect).map(([a, l]) => `<label class="check"><input type="checkbox" data-extra-output value="${a}" ${extra.includes(a) ? 'checked' : ''}><span>${l}</span></label>`).join('')}
          </div><small class="tiny">Recorded now; reframing for these formats arrives in a later phase. Characters and sets don't depend on orientation.</small></fieldset>
          <label class="check"><input type="checkbox" name="commercial" ${pr.commercial ? 'checked' : ''}><span>Commercial (monetized). Everything linked must pass the license check below.</span></label>
          <label class="field"><span>Notes</span><textarea name="notes" placeholder="Premise, tone, recurring jokes...">${esc(pr.notes || '')}</textarea></label>
          <div><button class="primary">Save settings</button></div>
        </form>
      </div>
      <div class="stack">
        <div class="card ${audit.problems.length ? '' : ''}">
          <h2 style="margin-bottom:6px">License check</h2>
          ${audit.problems.length
            ? `<div class="notice ${pr.commercial ? 'bad' : 'warn'}"><strong>${audit.problems.length} item${audit.problems.length === 1 ? '' : 's'} need attention${pr.commercial ? '' : ' before this project can be commercial'}.</strong>
                <ul class="steps small" style="margin-top:6px">${audit.problems.slice(0, 12).map((x) => `<li><strong>${esc(x.id)}</strong>${x.where ? ` · ${esc(x.where)}` : ''}: ${esc(x.problem)}</li>`).join('')}</ul></div>`
            : `<div class="notice good">${pr.commercial ? 'Everything linked passes the check for a monetized project.' : 'Nothing linked would block this project from becoming commercial.'}</div>`}
          <p class="tiny" style="margin-bottom:0">The check is a safety net, not legal advice: it uses the licenses recorded in the model registry and the rights you have recorded.</p>
        </div>
        ${linkList('characters', chars.map((c) => ({ id: c.slug, label: c.name, extra: `<span class="pill">${esc(c.status)}</span>${c.thumb ? '' : ' <span class="tiny">no cast image yet</span>'}` })), 'Cast')}
        ${linkList('sets', sets.map((s) => ({ id: s.slug, label: s.name })), 'Sets')}
        ${linkList('audio', [...music, ...sfx].map((a) => ({ id: a.id, label: a.title || a.id, extra: rightsPill(a.rights) })), 'Music & SFX')}
      </div>
    </div>`;
  on('#proj-form', 'submit', (e, form) => {
    e.preventDefault();
    const d = formData(form);
    const extraOutputs = $$('[data-extra-output]').filter((x) => x.checked).map((x) => x.value);
    act(() => api('PUT', `/api/projects/${slug}`, { ...d, fps: Number(d.fps), extraOutputs }), 'Settings saved');
  });
  on('[data-save-links]', 'click', (e, btn) => {
    const kind = btn.dataset.saveLinks;
    const ids = $$(`[data-link="${kind}"]`).filter((x) => x.checked).map((x) => x.value);
    act(() => api('PUT', `/api/projects/${slug}/links/${kind}`, { ids }), 'Links saved');
  });
}

// ---------- library lists ----------
const KIND_INFO = {
  characters: { title: 'Cast', one: 'character', route: 'cast', lead: 'Recurring characters and guests. Each one keeps every attempt, its cast winner, a reference pack per art style, a character bible and a voice.' },
  sets: { title: 'Sets', one: 'set', route: 'sets', lead: 'Locations with named cameras. Concept art now; 3D scenes and rendered plates join in phase 2.' },
};

async function viewAssets(kind) {
  const info = KIND_INFO[kind];
  const items = await get(`/api/library/${kind}`);
  const groups = kind === 'characters'
    ? [['Recurring', items.filter((i) => i.status !== 'guest')], ['Guests', items.filter((i) => i.status === 'guest')]]
    : [['', items]];
  const card = (it) => `
    <a class="asset-card" href="#/${info.route}/${it.slug}">
      <div class="thumb">${it.thumb ? `<img src="${esc(it.thumb)}" alt="">` : initials(it.name)}</div>
      <div class="body"><div class="name">${esc(it.name)}</div>
        <div class="tiny">${esc(it.role || it.description?.slice(0, 50) || '')} ${it.attempts ? `· ${it.attempts} attempts` : ''}</div></div>
    </a>`;
  app.innerHTML = `
    <div class="page-head"><div><h1>${info.title}</h1><p class="lead">${info.lead}</p></div></div>
    ${groups.map(([label, list], gi) => `
      ${label ? `<h2 style="margin-top:${gi ? 28 : 0}px">${label}</h2>` : ''}
      ${gi > 0 && !list.length ? '<p class="muted small">No guests yet. Add one with the status set to Guest; promote them to recurring any time.</p>' : ''}
      <div class="tiles">
        ${list.map(card).join('')}
        ${gi === 0 ? `<form class="asset-card add" id="new-asset" style="padding:16px;gap:10px">
          <input name="name" placeholder="New ${info.one} name" required aria-label="New ${info.one} name">
          ${kind === 'characters' ? `<select name="status" aria-label="Status">${opt('recurring', 'Recurring')}${opt('guest', 'Guest')}</select>` : ''}
          <button class="primary">Add ${info.one}</button></form>` : ''}
      </div>`).join('')}`;
  on('#new-asset', 'submit', (e, form) => {
    e.preventDefault();
    act(async () => {
      const a = await api('POST', `/api/library/${kind}`, formData(form));
      ui.tabs[`asset-${kind}`] = 'identity';
      location.hash = `#/${info.route}/${a.slug}`;
    }, `${info.one[0].toUpperCase() + info.one.slice(1)} added`, { rerender: false });
  });
}

// ---------- asset detail ----------
async function viewAsset(kind, slug) {
  const info = KIND_INFO[kind];
  const [asset, styles, models, projects, jobs] = await Promise.all([
    get(`/api/library/${kind}/${slug}`), get('/api/styles'), get('/api/models'), get('/api/projects'), get('/api/jobs?status=open'),
  ]);
  const myJobs = jobs.filter((j) => j.target.kind === kind && j.target.slug === slug);
  const cast = asset.attempts.find((a) => a.id === asset.castAttemptId);
  const t = tabs(`asset-${kind}`, kind === 'characters'
    ? [['identity', 'Identity & bible'], ['generate', `Generate & history (${asset.attempts.length})`], ['looks', 'Reference pack'], ['voice', 'Voice']]
    : [['identity', 'Overview & cameras'], ['generate', `Concept art (${asset.attempts.length})`], ['looks', 'Plates'], ['scene', '3D scene']]);

  let body = '';
  if (t.current === 'identity') body = kind === 'characters' ? identityCharacter(asset) : identitySet(asset);
  if (t.current === 'generate') body = generatePanel(kind, asset, styles, models, projects, myJobs);
  if (t.current === 'looks') body = looksPanel(kind, asset, styles, models, myJobs);
  if (t.current === 'voice') body = voicePanel(asset);
  if (t.current === 'scene') body = scenePanel(asset);

  app.innerHTML = `
    <div class="crumb"><a href="#/${info.route}">${info.title}</a></div>
    <div class="page-head">
      <div class="row" style="gap:16px;align-items:center">
        <div style="width:64px;height:64px;border-radius:12px;overflow:hidden;background:var(--side);display:grid;place-items:center;font-family:var(--serif);font-size:24px;color:var(--ink-3)">
          ${cast ? `<img src="${esc(cast.url)}" alt="" style="width:100%;height:100%;object-fit:cover">` : initials(asset.name)}</div>
        <div><h1>${esc(asset.name)}</h1>
          <p class="lead" style="margin-top:2px">${kind === 'characters' ? `${esc(asset.role || 'No role yet')} · <span class="pill ${asset.status === 'guest' ? 'warn' : 'accent'}">${esc(asset.status)}</span>${asset.episodes?.length ? ` · ${esc(asset.episodes.join(', '))}` : ''}` : esc(asset.description?.slice(0, 120) || 'No description yet')}</p></div>
      </div>
      ${myJobs.length ? `<a class="btn" href="#/jobs">${myJobs.length} open job${myJobs.length > 1 ? 's' : ''}</a>` : ''}
    </div>
    ${t.html}
    ${body}`;
  t.bind();
  bindAsset(kind, asset);
}

function identityCharacter(a) {
  const bible = [
    ['personality', 'Personality', 'Warm but proud. Hates shortcuts in the kitchen.'],
    ['backstory', 'Backstory', 'Trained in Lyon, opened Good Company after his father retired.'],
    ['speech', 'How they talk', 'Short sentences, Italian food words, calls everyone "chef".'],
    ['catchphrases', 'Catchphrases', '"Taste it again."'],
    ['relationships', 'Relationships', 'Secretly competitive with the sous chef.'],
    ['wardrobe', 'Wardrobe & look notes', 'Always a white jacket, sleeves rolled, red neckerchief.'],
  ];
  return `
    <form id="identity" class="stack"><div class="grid grid-2">
      <div class="card form">
        <h2>Identity</h2>
        <div class="form-2">
          <label class="field"><span>Name</span><input name="name" value="${esc(a.name)}"></label>
          <label class="field"><span>Role</span><input name="role" value="${esc(a.role)}" placeholder="Head chef"></label>
          <label class="field"><span>Status</span><select name="status">${opt('recurring', 'Recurring', a.status === 'recurring')}${opt('guest', 'Guest', a.status === 'guest')}</select>
            <small>${a.status === 'guest' ? 'Switch to recurring to promote this guest.' : ''}</small></label>
          <label class="field"><span>Episodes</span><input name="episodes" value="${esc((a.episodes || []).join(', '))}" placeholder="S01E03, S01E07"></label>
        </div>
        <label class="field"><span>Visual description</span>
          <textarea name="visual" rows="4" placeholder="middle-aged man, short black hair, thick moustache, white chef jacket, red neckerchief">${esc(a.visual)}</textarea>
          <small>Added to every prompt for this character, between the art style and your extra words. Describe looks only: face, hair, build, outfit.</small></label>
      </div>
      <div class="card form">
        <h2>Character bible</h2>
        <p class="tiny" style="margin:-6px 0 0">Saved as structured fields so script automation can read them later.</p>
        ${bible.map(([k, label, ph]) => `<label class="field"><span>${label}</span><textarea name="bible.${k}" rows="2" placeholder="${esc(ph)}">${esc(a.bible?.[k] || '')}</textarea></label>`).join('')}
      </div></div>
      <div><button class="primary">Save character</button></div>
    </form>`;
}

function identitySet(a) {
  const cams = a.cameras?.length ? a.cameras : [];
  const camRow = (c = {}) => `
    <tr data-cam data-cam-id="${esc(c.id || '')}">
      <td><input name="cam-name" value="${esc(c.name || '')}" placeholder="kitchen-wide" aria-label="Camera name"></td>
      <td><input name="cam-prompt" value="${esc(c.prompt || '')}" placeholder="wide shot of the open kitchen from the pass" aria-label="Framing"></td>
      <td><input name="cam-variants" value="${esc((c.variants || []).join(', '))}" placeholder="day, after-hours" aria-label="Lighting variants"></td>
      <td><input name="cam-lens" value="${esc(c.lens || '')}" placeholder="24mm" aria-label="Lens"></td>
      <td><button type="button" class="ghost danger" data-remove-cam aria-label="Remove camera">✕</button></td>
    </tr>`;
  return `
    <form id="identity" class="stack">
      <div class="card form">
        <h2>Overview</h2>
        <label class="field"><span>Name</span><input name="name" value="${esc(a.name)}"></label>
        <label class="field"><span>Description</span><textarea name="description" rows="3" placeholder="A small open-kitchen restaurant with a long pass and six tables.">${esc(a.description)}</textarea></label>
        <label class="field"><span>Visual description</span><textarea name="visual" rows="3" placeholder="cozy restaurant interior, warm wood, copper pans, open kitchen">${esc(a.visual)}</textarea>
          <small>Added to every concept-art and plate prompt for this set.</small></label>
      </div>
      <div class="card">
        <div class="spread"><h2 style="margin:0">Named cameras</h2><button type="button" id="add-cam">Add camera</button></div>
        <p class="tiny">Every episode reuses these angles. Each camera × lighting variant becomes a plate slot.</p>
        <table><thead><tr><th style="width:18%">Name</th><th>Framing</th><th style="width:20%">Lighting variants</th><th style="width:10%">Lens</th><th style="width:40px"></th></tr></thead>
          <tbody id="cams">${(cams.length ? cams : [{}]).map(camRow).join('')}</tbody></table>
      </div>
      <div><button class="primary">Save set</button></div>
    </form>
    <template id="cam-row">${camRow()}</template>`;
}

function modelOptions(models, capability, selected) {
  const usable = models.filter((m) => m.capabilities.includes(capability) && m.status === 'available' && m.guard.ok);
  return usable.map((m) => opt(m.id, `${m.label}${m.adapter === 'kaggle-bundle' ? ' · Kaggle batch' : ' · by hand'}`, m.id === selected)).join('');
}

function jobCard(j) {
  return `
    <div class="card" style="padding:14px">
      <div class="spread"><div class="row">${pillFor(j.status)}<span class="small"><strong>${esc(j.target.slot || 'New attempts')}</strong> · ${esc(j.model)} · ${j.input.count}×</span></div>
        <div class="row"><button class="ghost" data-copy="${esc(j.input.prompt)}">Copy prompt</button><button class="ghost danger" data-cancel="${j.id}">Cancel</button></div></div>
      <div class="prompt-box" style="margin-top:10px">${esc(j.input.prompt)}${j.input.negative ? `\n\nAvoid: ${esc(j.input.negative)}` : ''}</div>
      ${j.status === 'awaiting-upload' ? `
        <p class="tiny">${esc(j.instructions || '')}${j.input.refImage ? ' Reference image: the cast winner.' : ''}</p>
        ${drop(`up-${j.id}`, 'Drop the result here, or click to choose', 'image/*', true)}` : `<p class="tiny">${esc(j.instructions || '')}</p>`}
    </div>`;
}

function generatePanel(kind, a, styles, models, projects, jobs) {
  const pending = jobs.filter((j) => j.capability === 'image.generate');
  const starredOnly = ui.starredOnly[a.slug];
  const shown = starredOnly ? a.attempts.filter((x) => x.starred) : a.attempts;
  const defaultStyle = ui.lastStyle || styles[0]?.slug;
  return `
    <div class="grid grid-2">
      <form id="gen" class="card form">
        <h2>Generate</h2>
        <div class="form-2">
          <label class="field"><span>Model</span><select name="model">${modelOptions(models, 'image.generate', ui.lastModel)}</select></label>
          <label class="field"><span>Art style</span><select name="styleSlug">${styles.map((s) => opt(s.slug, s.name, s.slug === defaultStyle)).join('')}</select></label>
        </div>
        <label class="field"><span>Extra prompt words</span><textarea name="prompt" rows="2" placeholder="${kind === 'characters' ? 'smiling, arms crossed, in the kitchen' : 'golden hour light through the front window'}"></textarea>
          <small>Combined with the style and the visual description: preview below.</small></label>
        <div class="form-2">
          <label class="field"><span>How many</span><select name="count">${[1, 2, 4, 6].map((n) => opt(n, n, n === 4)).join('')}</select></label>
          <label class="field"><span>Shape</span><select name="shape">${opt('1024x1024', 'Square')}${opt('832x1216', 'Portrait')}${opt('1216x832', 'Landscape')}</select></label>
          <label class="field"><span>Seed</span><input name="seed" type="number" placeholder="random"></label>
          <label class="field"><span>Also avoid</span><input name="negative" placeholder="hats"></label>
        </div>
        <div class="prompt-box" id="preview"></div>
        <div><button class="primary">Queue job</button></div>
      </form>
      <div class="stack">
        ${pending.length ? `<h2>Waiting</h2>${pending.map(jobCard).join('')}` : ''}
        <div class="card">
          <h2>Already have an image?</h2>
          <label class="field"><span>Made with</span><select id="direct-model">${modelOptions(models.filter((m) => m.adapter === 'manual-import'), 'image.generate', 'chatgpt-images')}</select></label>
          ${rightsFields('direct')}
          <div style="margin-top:10px">${drop('direct-up', 'Drop images to add them as attempts', 'image/*', true)}</div>
        </div>
      </div>
    </div>
    <div class="spread" style="margin:28px 0 12px">
      <h2 style="margin:0">History</h2>
      <label class="check"><input type="checkbox" id="starred-only" ${starredOnly ? 'checked' : ''}><span>Starred only</span></label>
    </div>
    ${shown.length ? `<div class="tiles">${shown.map((x) => `
      <div class="shot ${x.id === a.castAttemptId ? 'cast' : ''}">
        <img src="${esc(x.url)}" alt="" data-zoom="${esc(x.url)}" loading="lazy">
        <button class="star ${x.starred ? 'on' : ''}" data-star="${x.id}" data-on="${x.starred ? 1 : 0}" aria-label="${x.starred ? 'Unstar' : 'Star'}">${x.starred ? '★' : '☆'}</button>
        ${x.id === a.castAttemptId ? '<span class="pill accent cast-flag">cast</span>' : ''}
        <div class="meta">
          <span title="${esc(x.prompt)}">${esc(x.modelLabel || x.model)}${x.seed !== null && x.seed !== undefined ? ` · seed ${esc(x.seed)}` : ''}</span>
          <span class="tiny">${fmtDate(x.createdAt)}</span>
          <div class="row">${rightsPill(x.rights)}${x.rights?.review === 'needs-review' ? `<button class="ghost" style="padding:2px 6px;font-size:12px" data-clear-attempt="${x.id}">Mark cleared</button>` : ''}</div>
          <div class="row">${x.id === a.castAttemptId ? '' : `<button data-cast="${x.id}" class="primary" style="padding:4px 10px;font-size:13px">${kind === 'characters' ? 'Cast this one' : 'Use as concept'}</button>`}
            ${x.id === a.castAttemptId ? '' : `<button class="ghost danger" data-del-attempt="${esc(x.file)}" aria-label="Delete attempt">Delete</button>`}</div>
        </div>
      </div>`).join('')}</div>` : `<div class="empty">${starredOnly ? 'No starred attempts yet.' : 'No attempts yet. Queue a job or drop in an image.'}</div>`}`;
}

function looksPanel(kind, a, styles, models, jobs) {
  const style = ui.lookStyle && styles.some((s) => s.slug === ui.lookStyle) ? ui.lookStyle : styles[0]?.slug;
  const look = a.looks[style] || {};
  const pending = jobs.filter((j) => j.capability === 'image.reference_pack' && j.target.styleSlug === style);
  const pendingSlots = new Set(pending.map((j) => j.target.slot));
  const filled = a.slots.filter((s) => look[s.id]).length;
  if (!a.castAttemptId) {
    return `<div class="notice warn">${kind === 'characters' ? 'Cast a winner first' : 'Pick a concept image first'} (on the ${kind === 'characters' ? 'Generate & history' : 'Concept art'} tab). The ${kind === 'characters' ? 'reference pack' : 'plates'} are built from it, so every view stays consistent.</div>`;
  }
  if (!a.slots.length) return '<div class="notice warn">Add named cameras on the Overview tab first. Each camera and lighting variant becomes a plate slot.</div>';
  return `
    <div class="card">
      <div class="spread">
        <div class="row">
          <label class="field" style="min-width:200px"><span>Art style</span><select id="look-style">${styles.map((s) => opt(s.slug, s.name, s.slug === style)).join('')}</select></label>
          <label class="field" style="min-width:280px"><span>Model</span><select id="look-model">${modelOptions(models, 'image.reference_pack', ui.lookModel)}</select></label>
        </div>
        <div class="row">
          <span class="small muted">${filled} of ${a.slots.length} filled</span>
          <button id="pack-missing" class="primary" ${filled + pendingSlots.size >= a.slots.length ? 'disabled' : ''}>Queue jobs for empty slots</button>
          <button id="pack-all" title="Results arrive as candidates; your approved images stay until you pick a new one">Queue all slots again</button>
        </div>
      </div>
      <p class="tiny" style="margin-bottom:0">${kind === 'characters'
        ? 'The reference pack, not a seed, is what keeps this character looking the same in every shot, even if you change models later.'
        : 'Phase 1 plates come from the concept image. In phase 2 they are rendered from the 3D set in Blender, then painted in the style.'}
        New results never replace an approved image: they arrive as <strong>candidates</strong> under the slot. Click <em>Use</em> to approve one; older images stay restorable.</p>
    </div>
    ${pending.length ? `<h2 style="margin-top:24px">Waiting</h2><div class="stack">${pending.map(jobCard).join('')}</div>` : ''}
    <div class="tiles" style="margin-top:20px">
      ${a.slots.map((s) => {
        const rec = look[s.id];
        const others = a.lookVersions?.[style]?.[s.id] || [];
        const candidates = others.filter((v) => v.status === 'candidate');
        const older = others.filter((v) => v.status !== 'candidate');
        const thumb = (v, isCand) => `
          <div style="width:64px">
            <img src="${esc(v.url)}" alt="" data-zoom="${esc(v.url)}" style="width:64px;height:64px;object-fit:cover;border-radius:6px;cursor:zoom-in;${isCand ? 'outline:2px solid var(--warn)' : 'opacity:.7'}">
            <div class="row" style="gap:2px;margin-top:2px">
              <button class="ghost" style="padding:1px 4px;font-size:11.5px" data-approve="${s.id}|${v.id}">${isCand ? 'Use' : 'Restore'}</button>
              <button class="ghost danger" style="padding:1px 4px;font-size:11.5px" data-reject="${s.id}|${v.id}" aria-label="Reject">✕</button></div>
          </div>`;
        return `
        <div class="slot ${rec ? 'filled' : ''}">
          <div class="img">${rec ? `<img src="${esc(rec.url)}" alt="${esc(s.label)}" data-zoom="${esc(rec.url)}">` : pendingSlots.has(s.id) ? 'Job waiting' : esc(s.prompt)}</div>
          <div class="meta"><strong>${esc(s.label)}</strong>
            <label class="ghost btn" style="padding:3px 8px;font-size:12.5px" title="Placing an image by hand makes it the approved one; the previous one stays restorable">Upload<input type="file" accept="image/*" hidden data-slot-upload="${s.id}"></label></div>
          ${rec ? `<div class="tiny" style="padding:0 10px 4px">${esc(rec.modelLabel || rec.model)}</div>
            <div class="row" style="padding:0 10px 8px">${rightsPill(rec.rights)}${rec.rights?.review === 'needs-review' ? `<button class="ghost" style="padding:2px 6px;font-size:12px" data-clear-look="${s.id}|${rec.id}">Mark cleared</button>` : ''}</div>` : ''}
          ${candidates.length ? `<div style="padding:0 10px 8px"><div class="tiny" style="color:var(--warn);font-weight:600">${candidates.length} new candidate${candidates.length === 1 ? '' : 's'}</div><div class="row" style="gap:6px;align-items:flex-start">${candidates.map((v) => thumb(v, true)).join('')}</div></div>` : ''}
          ${older.length ? `<details style="padding:0 10px 8px"><summary class="tiny" style="cursor:pointer">${older.length} older version${older.length === 1 ? '' : 's'}</summary><div class="row" style="gap:6px;align-items:flex-start;margin-top:4px">${older.map((v) => thumb(v, false)).join('')}</div></details>` : ''}
        </div>`;
      }).join('')}
    </div>
    <div class="card" style="margin-top:16px">
      <h3>Uploading into a slot by hand</h3>
      <label class="field"><span>Made with</span><select id="slot-source" style="max-width:420px">${modelOptions(models.filter((m) => m.adapter === 'manual-import'), 'image.reference_pack', 'chatgpt-images')}</select></label>
      ${rightsFields('slot')}
    </div>`;
}

function voicePanel(a) {
  const v = a.voice;
  return `
    <div class="grid grid-2">
      <form id="voice" class="card form">
        <h2>Voice profile</h2>
        <label class="field"><span>How lines are made</span><select name="mode">
          ${opt('mix', 'Mix: my performance through a filter for key lines, TTS for the rest', v.mode === 'mix')}
          ${opt('filter', 'Always my performance through a filter', v.mode === 'filter')}
          ${opt('tts', 'Always text-to-speech', v.mode === 'tts')}</select></label>
        <div class="form-2">
          <label class="field"><span>TTS provider</span><input name="ttsProvider" value="${esc(v.ttsProvider)}" placeholder="Kokoro"></label>
          <label class="field"><span>TTS voice</span><input name="ttsVoiceId" value="${esc(v.ttsVoiceId)}" placeholder="am_michael"></label>
        </div>
        <div class="notice warn small">Notes only for now: nothing on this tab generates or changes audio yet. The Voice Lab (effect and AI voice filters) arrives in phase 2.</div>
        <label class="field"><span>Filter notes</span><textarea name="filterNotes" rows="2" placeholder="Pitch down 2, warm EQ, light room reverb">${esc(v.filterNotes)}</textarea></label>
        <label class="field"><span>Notes</span><textarea name="notes" rows="2">${esc(v.notes)}</textarea></label>
        <div><button class="primary">Save voice</button></div>
      </form>
      <div class="card">
        <h2>Clips</h2>
        ${v.clips.length ? `<div class="stack">${v.clips.map((c) => `
          <div><div class="spread"><span class="small"><strong>${esc(c.label || c.file)}</strong> <span class="pill">${esc(c.kind || 'reference')}</span> <span class="pill ${c.consent && c.consent !== 'unknown' ? 'good' : 'bad'}">${esc(STATE.voiceConsent?.[c.consent || 'unknown'] || 'Consent not recorded')}</span></span>
            <button class="ghost danger" data-del-clip="${esc(c.file)}">Delete</button></div>
            <audio controls preload="none" src="${esc(c.url)}"></audio>
            <div class="tiny">${esc(c.source || '')}</div></div>`).join('')}</div>` : '<p class="muted small">No clips yet. Add reference recordings, TTS samples or filtered takes.</p>'}
        <div class="form-2" style="margin-top:16px">
          <label class="field"><span>Label</span><input id="clip-label" placeholder="Reference read: 'Taste it again'"></label>
          <label class="field"><span>Kind</span><select id="clip-kind">${opt('reference', 'Reference')}${opt('tts-sample', 'TTS sample')}${opt('filtered-take', 'Filtered take')}</select></label>
        </div>
        <label class="field" style="margin-top:10px"><span>Source</span><input id="clip-source" value="your recording"></label>
        <label class="field" style="margin-top:10px"><span>Whose voice</span><select id="clip-consent">${Object.entries(STATE.voiceConsent || {}).map(([k, l]) => opt(k, l, k === 'own-voice')).join('')}</select></label>
        <label class="field" style="margin-top:10px"><span>Consent evidence (if another person)</span><input id="clip-evidence" placeholder="Where the signed consent is kept"></label>
        <div style="margin-top:10px">${drop('clip-up', 'Drop audio (wav, mp3, ogg, flac, m4a)', 'audio/*')}</div>
        <p class="tiny">Only original voices, your own, or people who gave written consent.</p>
      </div>
    </div>`;
}

function scenePanel(a) {
  return `
    <div class="grid grid-2">
      <div class="card">
        <h2>Scene files</h2>
        ${a.sceneFiles.length ? `<table><tbody>${a.sceneFiles.map((f) => `<tr><td class="mono">${esc(f.file)}</td><td class="tiny">${(f.size / 1048576).toFixed(1)} MB${f.previousVersions ? ` · ${f.previousVersions} previous version${f.previousVersions === 1 ? '' : 's'} kept` : ''}</td><td style="text-align:right"><a href="${esc(f.url)}" download>Download</a> <button class="ghost danger" data-del-scene="${esc(f.file)}">Delete</button></td></tr>`).join('')}</tbody></table>`
          : '<p class="muted small">No 3D files yet.</p>'}
        <div style="margin-top:12px">${drop('scene-up', 'Drop .blend, .glb, .gltf, .fbx, .obj, .ply or .spz files', '', true)}</div>
        <p class="tiny">Uploading a file with the same name keeps the old one in <span class="mono">scene/versions/</span>.</p>
      </div>
      <div class="card">
        <h2>Coming in phase 2</h2>
        <ul class="steps small">
          <li>In-studio 3D viewer: orbit the set and click <em>Save this angle</em>.</li>
          <li>Blender renders a plain plate and a depth map for every named camera.</li>
          <li>The project's art style paints each plate while the geometry stays locked.</li>
          <li>Props generated from images (TRELLIS.2, MIT license) placed in the room.</li>
        </ul>
        <p class="tiny">For now, keep your .blend working file and exported .glb here so they live with the set.</p>
      </div>
    </div>`;
}

function bindAsset(kind, a) {
  const base = `/api/library/${kind}/${a.slug}`;
  on('[data-zoom]', 'click', (e, el) => lightbox(el.dataset.zoom));
  on('[data-copy]', 'click', async (e, el) => { await navigator.clipboard.writeText(el.dataset.copy); toast('Prompt copied'); });
  on('[data-cancel]', 'click', (e, el) => act(() => api('POST', `/api/jobs/${el.dataset.cancel}/cancel`), 'Job cancelled'));
  $$('[id^="up-job-"]').forEach((el) => bindDrop(el.id, (files) => act(async () => {
    for (const f of files) await uploadTo(`/api/jobs/${el.id.slice(3)}/upload`, f);
  }, files.length > 1 ? `${files.length} images added` : 'Image added')));

  // identity
  on('#identity', 'submit', (e, form) => {
    e.preventDefault();
    const d = formData(form);
    const payload = { name: d.name, visual: d.visual };
    if (kind === 'characters') {
      Object.assign(payload, { role: d.role, status: d.status, episodes: d.episodes.split(',').map((s) => s.trim()).filter(Boolean), bible: {} });
      for (const [k, v] of Object.entries(d)) if (k.startsWith('bible.')) payload.bible[k.slice(6)] = v;
    } else {
      payload.description = d.description;
      payload.cameras = $$('[data-cam]').map((row) => ({
        id: row.dataset.camId || undefined, // keeps plates connected when a camera is renamed
        name: $('[name=cam-name]', row).value, prompt: $('[name=cam-prompt]', row).value,
        variants: $('[name=cam-variants]', row).value.split(',').map((s) => s.trim()).filter(Boolean),
        lens: $('[name=cam-lens]', row).value,
      }));
    }
    act(() => api('PUT', base, payload), 'Saved');
  });
  on('#add-cam', 'click', () => $('#cams').append($('#cam-row').content.cloneNode(true)));
  on('#cams', 'click', (e) => { const b = e.target.closest('[data-remove-cam]'); if (b) b.closest('tr').remove(); });

  // generate
  const gen = $('#gen');
  if (gen) {
    const updatePreview = async () => {
      const d = formData(gen);
      ui.lastModel = d.model; ui.lastStyle = d.styleSlug;
      const style = await get(`/api/styles/${d.styleSlug}`).catch(() => null);
      const parts = [style?.promptPrefix, a.visual, d.prompt, style?.promptSuffix].map((s) => (s || '').trim()).filter(Boolean);
      $('#preview').textContent = `${parts.join(', ') || '(empty prompt)'}${style?.negative || d.negative ? `\n\nAvoid: ${[style?.negative, d.negative].filter(Boolean).join(', ')}` : ''}`;
    };
    gen.addEventListener('input', updatePreview);
    updatePreview();
    gen.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = formData(gen);
      const [width, height] = d.shape.split('x').map(Number);
      act(() => api('POST', '/api/jobs', {
        capability: 'image.generate', model: d.model,
        target: { kind, slug: a.slug, styleSlug: d.styleSlug },
        input: { prompt: d.prompt, negative: d.negative, count: Number(d.count), width, height, seed: d.seed === '' ? null : Number(d.seed) },
      }), (j) => (j.status === 'awaiting-upload' ? 'Job created: copy the prompt, generate, then drop the result in' : 'Queued for the next Kaggle batch'));
    });
  }
  bindDrop('direct-up', (files) => act(async () => {
    const model = $('#direct-model').value;
    for (const f of files) await uploadTo(`${base}/attempts`, f, { model, styleSlug: ui.lastStyle || null, ...rightsMeta('direct') });
  }, () => (rightsMeta('direct').rightsDeclared ? (files.length > 1 ? `${files.length} attempts added` : 'Attempt added') : 'Added, marked Needs review until you clear it')));
  on('[data-clear-attempt]', 'click', (e, el) => clearRights(`${base}/attempts/${el.dataset.clearAttempt}/rights`));
  on('#starred-only', 'change', (e, el) => { ui.starredOnly[a.slug] = el.checked; render(); });
  on('[data-star]', 'click', (e, el) => act(() => api('POST', `${base}/attempts/${el.dataset.star}/star`, { starred: el.dataset.on !== '1' })));
  on('[data-cast]', 'click', (e, el) => act(() => api('POST', `${base}/cast`, { attemptId: el.dataset.cast }), kind === 'characters' ? 'Cast! Next: build the reference pack.' : 'Concept image set'));
  on('[data-del-attempt]', 'click', (e, el) => {
    if (!confirm('Move this attempt to the trash? You can restore it from Settings → Trash.')) return;
    act(() => api('DELETE', `${base}/files/history/${el.dataset.delAttempt}`), 'Moved to the trash');
  });

  // looks
  on('#look-style', 'change', (e, el) => { ui.lookStyle = el.value; render(); });
  on('#look-model', 'change', (e, el) => { ui.lookModel = el.value; });
  const packJobs = (slots) => act(() => api('POST', `${base}/refpack`, {
    styleSlug: $('#look-style').value, model: $('#look-model').value, slots,
  }), (jobs) => `${jobs.length} job${jobs.length === 1 ? '' : 's'} queued${jobs[0]?.adapter === 'kaggle-bundle' ? ' for the next Kaggle export' : ': see Waiting below'}`);
  on('#pack-missing', 'click', () => {
    const style = $('#look-style').value;
    const filled = new Set(Object.keys(a.looks[style] || {}));
    const waiting = new Set($$('.slot .img').filter((x) => x.textContent === 'Job waiting').map((x) => x.closest('.slot').querySelector('[data-slot-upload]').dataset.slotUpload));
    const slots = a.slots.map((s) => s.id).filter((id) => !filled.has(id) && !waiting.has(id));
    if (slots.length) packJobs(slots);
  });
  on('#pack-all', 'click', () => {
    if (confirm('Queue a job for every slot? Results arrive as candidates; your approved images stay until you choose a new one.')) packJobs(a.slots.map((s) => s.id));
  });
  on('[data-slot-upload]', 'change', (e, input) => {
    const f = input.files[0];
    if (!f) return;
    act(() => uploadTo(`${base}/looks/${$('#look-style').value}/${input.dataset.slotUpload}`, f, { model: $('#slot-source').value, ...rightsMeta('slot') }),
      'Placed in the slot. The previous image is kept as an older version.');
  });
  const lookPath = (pair, action) => {
    const [slot, vid] = pair.split('|');
    return `${base}/looks/${$('#look-style').value}/${slot}/versions/${vid}/${action}`;
  };
  on('[data-approve]', 'click', (e, el) => act(() => api('POST', lookPath(el.dataset.approve, 'approve')), 'Approved for this slot'));
  on('[data-reject]', 'click', (e, el) => {
    if (confirm('Reject this image? It moves to the trash and can be restored from Settings.')) act(() => api('POST', lookPath(el.dataset.reject, 'reject')), 'Rejected');
  });
  on('[data-clear-look]', 'click', (e, el) => clearRights(lookPath(el.dataset.clearLook, 'rights')));

  // voice
  on('#voice', 'submit', (e, form) => { e.preventDefault(); act(() => api('PUT', `${base}/voice`, formData(form)), 'Voice saved'); });
  bindDrop('clip-up', ([f]) => act(() => uploadTo(`${base}/voice/clips`, f, {
    label: $('#clip-label').value || f.name, kind: $('#clip-kind').value, source: $('#clip-source').value,
    consent: $('#clip-consent').value, evidence: $('#clip-evidence').value,
  }), 'Clip added'));
  on('[data-del-clip]', 'click', (e, el) => { if (confirm('Move this clip to the trash?')) act(() => api('DELETE', `${base}/files/clips/${el.dataset.delClip}`), 'Moved to the trash'); });

  // scene
  bindDrop('scene-up', (files) => act(async () => {
    let kept = 0;
    for (const f of files) if ((await uploadTo(`${base}/scene`, f)).keptPrevious) kept++;
    return kept;
  }, (kept) => (kept ? `Saved. ${kept} older version${kept === 1 ? ' was' : 's were'} kept in scene/versions.` : 'Scene file saved')));
  on('[data-del-scene]', 'click', (e, el) => { if (confirm('Move this scene file to the trash?')) act(() => api('DELETE', `${base}/files/scene/${el.dataset.delScene}`), 'Moved to the trash'); });
}

// ---------- voices overview ----------
async function viewVoices() {
  const chars = await get('/api/library/characters');
  const full = await Promise.all(chars.map((c) => get(`/api/library/characters/${c.slug}`)));
  const modeLabel = { mix: 'Mix', filter: 'Filter', tts: 'TTS' };
  app.innerHTML = `
    <div class="page-head"><div><h1>Voices</h1><p class="lead">Every cast member's voice at a glance. Season 1 uses a mix: your performances through filters for key lines, TTS for the rest.</p></div></div>
    ${full.length ? `<div class="card" style="padding:6px 10px"><table>
      <thead><tr><th>Character</th><th>Mode</th><th>TTS voice</th><th>Filter notes</th><th>Clips</th></tr></thead>
      <tbody>${full.map((c) => `<tr>
        <td><a href="#/cast/${c.slug}" data-voice-tab>${esc(c.name)}</a> <span class="pill">${esc(c.status)}</span></td>
        <td>${esc(modeLabel[c.voice.mode] || c.voice.mode)}</td>
        <td>${esc([c.voice.ttsProvider, c.voice.ttsVoiceId].filter(Boolean).join(' · ') || '—')}</td>
        <td class="small">${esc(c.voice.filterNotes || '—')}</td>
        <td>${c.voice.clips.length}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No cast yet. <a href="#/cast">Add a character</a>.</div>'}
    <div class="card" style="margin-top:20px"><h2>Voice Lab: phase 2</h2>
      <p class="small muted">Build filters inside the studio and run your recordings through them: effect filters (pitch, formant, EQ, reverb) instantly on your laptop, and AI voice models trained once on the Kaggle worker from a voice you design.</p></div>`;
  on('[data-voice-tab]', 'click', () => { ui.tabs['asset-characters'] = 'voice'; });
}

// ---------- music & sfx ----------
async function viewAudio() {
  const t = tabs('audio', [['music', 'Music'], ['sfx', 'Sound effects']]);
  const kind = t.current;
  const items = await get(`/api/audio/${kind}`);
  app.innerHTML = `
    <div class="page-head"><div><h1>Music &amp; SFX</h1><p class="lead">Every file keeps its license, source and review state. Only tracks you have cleared can be linked to a commercial project.</p></div></div>
    ${t.html}
    <div class="grid grid-2">
      <div class="stack">
        ${items.length ? items.map((a) => `
          <div class="card" style="padding:14px">
            <div class="spread"><strong>${esc(a.title || a.id)}</strong>
              <div class="row">${rightsPill(a.rights)}
                ${a.rights?.review === 'needs-review'
                  ? `<button class="ghost" data-clear-audio="${esc(a.id)}">Mark cleared</button>`
                  : `<button class="ghost" data-unclear-audio="${esc(a.id)}">Back to needs review</button>`}
                <button class="ghost danger" data-del-audio="${esc(a.id)}">Delete</button></div></div>
            <audio controls preload="none" src="${esc(a.url)}" style="margin-top:8px"></audio>
            <div class="tiny" style="margin-top:4px">${esc(a.license)}${a.licenseUrl ? ` · <a href="${esc(a.licenseUrl)}" target="_blank" rel="noopener">license</a>` : ''}${a.source ? ` · ${esc(a.source)}` : ''}${a.tags?.length ? ` · ${a.tags.map(esc).join(', ')}` : ''}${a.use ? ` · use: ${esc(a.use)}` : ''}${a.rights?.evidence ? ` · evidence: ${esc(a.rights.evidence)}` : ''}</div>
          </div>`).join('') : `<div class="empty">No ${kind === 'music' ? 'music' : 'sound effects'} yet.</div>`}
      </div>
      <form id="audio-form" class="card form">
        <h2>Add ${kind === 'music' ? 'a track' : 'a sound effect'}</h2>
        <label class="field"><span>Title</span><input name="title" placeholder="${kind === 'music' ? 'Good Company theme' : 'Pan sizzle'}"></label>
        <label class="field"><span>License (required)</span><input name="license" required placeholder="YouTube Audio Library / CC BY 4.0 / Own recording"></label>
        <div class="form-2">
          <label class="field"><span>License link</span><input name="licenseUrl" placeholder="https://"></label>
          <label class="field"><span>Source</span><input name="source" placeholder="Where it came from"></label>
          <label class="field"><span>Tags</span><input name="tags" placeholder="upbeat, kitchen, jazz"></label>
          <label class="field"><span>Use</span><input name="use" placeholder="${kind === 'music' ? 'theme, sting, ambience' : 'transition, foley'}"></label>
        </div>
        <label class="check"><input type="checkbox" name="commercialOk"><span>I checked: this license allows use in a monetized YouTube video.</span></label>
        <label class="field"><span>Evidence (optional)</span><input name="evidence" placeholder="License link, receipt, or where the license is saved"></label>
        <p class="tiny" style="margin:0">Unticked, the track is saved as <strong>Needs review</strong>.</p>
        ${drop('audio-up', 'Drop the audio file here to save it', 'audio/*')}
      </form>
    </div>`;
  t.bind();
  bindDrop('audio-up', ([f]) => {
    const form = $('#audio-form');
    if (!form.reportValidity()) return;
    act(() => uploadTo(`/api/audio/${kind}`, f, formData(form)), 'Saved to the library');
  });
  on('[data-clear-audio]', 'click', (e, el) => {
    const evidence = prompt('You are confirming this license allows a monetized YouTube video.\n\nEvidence (license link, receipt or note). Leave empty to just mark it cleared:', '');
    if (evidence !== null) act(() => api('PUT', `/api/audio/${kind}/${el.dataset.clearAudio}`, { commercialOk: true, evidence: evidence.trim() }), 'Marked as cleared');
  });
  on('[data-unclear-audio]', 'click', (e, el) => act(() => api('PUT', `/api/audio/${kind}/${el.dataset.unclearAudio}`, { commercialOk: false })));
  on('[data-del-audio]', 'click', (e, el) => { if (confirm('Move this file to the trash?')) act(() => api('DELETE', `/api/audio/${kind}/${el.dataset.delAudio}`), 'Moved to the trash'); });
}

// ---------- styles ----------
async function viewStyles() {
  const styles = await get('/api/styles');
  app.innerHTML = `
    <div class="page-head"><div><h1>Art styles</h1><p class="lead">A style is the paint layer: prompt words, colors and references wrapped around every generation. Projects pick one; the same cast can be drawn in several.</p></div></div>
    <div class="grid grid-3">
      ${styles.map((s) => `<a class="card" href="#/styles/${s.slug}" style="text-decoration:none;color:inherit">
        <div class="spread"><h2 style="margin:0">${esc(s.name)}</h2><div class="swatches">${(s.palette || []).map((c) => `<i style="background:${esc(c)}"></i>`).join('')}</div></div>
        <p class="small muted" style="margin:10px 0 0">${esc(s.promptPrefix)}</p>
        <p class="tiny">${s.refs.length} reference image${s.refs.length === 1 ? '' : 's'}</p></a>`).join('')}
      <form class="card form" id="new-style"><h2>New style</h2>
        <label class="field"><span>Name</span><input name="name" required placeholder="Clay stop-motion"></label>
        <div><button class="primary">Create style</button></div></form>
    </div>`;
  on('#new-style', 'submit', (e, form) => {
    e.preventDefault();
    act(async () => { const s = await api('POST', '/api/styles', { ...formData(form), promptPrefix: '', negative: '' }); location.hash = `#/styles/${s.slug}`; }, 'Style created', { rerender: false });
  });
}

async function viewStyle(slug) {
  const s = await get(`/api/styles/${slug}`);
  const pal = [...(s.palette || [])];
  while (pal.length < 5) pal.push('#cccccc');
  app.innerHTML = `
    <div class="crumb"><a href="#/styles">Art styles</a></div>
    <div class="page-head"><div><h1>${esc(s.name)}</h1></div></div>
    <div class="grid grid-2">
      <form id="style-form" class="card form">
        <label class="field"><span>Name</span><input name="name" value="${esc(s.name)}"></label>
        <label class="field"><span>Prompt prefix</span><textarea name="promptPrefix" rows="3">${esc(s.promptPrefix)}</textarea><small>Goes before every prompt in this style.</small></label>
        <label class="field"><span>Prompt suffix</span><textarea name="promptSuffix" rows="2">${esc(s.promptSuffix)}</textarea></label>
        <label class="field"><span>Avoid (negative prompt)</span><textarea name="negative" rows="3">${esc(s.negative)}</textarea></label>
        <label class="field"><span>Palette</span><div class="row">${pal.map((c, i) => `<input type="color" name="pal${i}" value="${esc(c)}" aria-label="Palette color ${i + 1}" style="width:44px;height:36px;padding:2px;border-radius:8px;border:1px solid var(--line-2)">`).join('')}</div></label>
        <label class="field"><span>Notes</span><textarea name="notes" rows="2">${esc(s.notes)}</textarea></label>
        <div><button class="primary">Save style</button></div>
      </form>
      <div class="card">
        <h2>Reference images</h2>
        <p class="tiny">Mood and style references. Kept with the style; later used as style inputs by models that support them.</p>
        ${s.refs.length ? `<div class="tiles" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">${s.refs.map((r) => `
          <div class="shot"><img src="${esc(r.url)}" alt="" data-zoom="${esc(r.url)}"><div class="meta"><button class="ghost danger" data-del-ref="${esc(r.file)}">Remove</button></div></div>`).join('')}</div>` : ''}
        <div style="margin-top:12px">${drop('ref-up', 'Drop reference images', 'image/*', true)}</div>
      </div>
    </div>`;
  on('#style-form', 'submit', (e, form) => {
    e.preventDefault();
    const d = formData(form);
    d.palette = [0, 1, 2, 3, 4].map((i) => d[`pal${i}`]);
    act(() => api('PUT', `/api/styles/${slug}`, d), 'Style saved');
  });
  on('[data-zoom]', 'click', (e, el) => lightbox(el.dataset.zoom));
  bindDrop('ref-up', (files) => act(async () => { for (const f of files) await uploadTo(`/api/styles/${slug}/refs`, f); }, 'References added'));
  on('[data-del-ref]', 'click', (e, el) => act(() => api('DELETE', `/api/styles/${slug}/refs/${el.dataset.delRef}`), 'Removed'));
}

// ---------- jobs ----------
async function viewJobs() {
  const all = await get('/api/jobs');
  const kaggle = all.filter((j) => j.adapter === 'kaggle-bundle' && (j.status === 'queued' || j.status === 'exported'));
  const manual = all.filter((j) => j.status === 'awaiting-upload');
  const finished = all.filter((j) => ['done', 'failed', 'cancelled'].includes(j.status)).slice(0, 40);
  const queued = kaggle.filter((j) => j.status === 'queued').length;
  const images = kaggle.reduce((n, j) => n + (j.input.count || 1), 0);
  app.innerHTML = `
    <div class="page-head"><div><h1>Jobs</h1><p class="lead">Everything waiting to be generated. Kaggle jobs run together on batch day; by-hand jobs wait for you to drop the result in.</p></div></div>
    <div class="grid grid-2">
      <div class="card">
        <div class="spread"><h2 style="margin:0">Kaggle batch</h2><span class="pill accent">${kaggle.length} job${kaggle.length === 1 ? "" : "s"} · ${images} image${images === 1 ? "" : "s"}</span></div>
        <ol class="steps small" style="margin-top:12px">
          <li><button id="export" class="primary" ${kaggle.length ? '' : 'disabled'}>Export bundle.zip</button>
            <span class="tiny">${queued} new${kaggle.length - queued ? `, ${kaggle.length - queued} exported before (included again in case you lost that bundle; results from either bundle are accepted once)` : ''}</span></li>
          <li>On <a href="https://www.kaggle.com" target="_blank" rel="noopener">kaggle.com</a>, upload the bundle as a dataset and add it as input to the <a href="/worker/sideplate_worker.ipynb" download>worker notebook</a> (GPU T4, internet on).</li>
          <li>Run all cells, then download <span class="mono">results.zip</span> from the notebook's output.</li>
          <li>Import it here: ${drop('import', 'Drop results.zip', '.zip,application/zip')}</li>
        </ol>
        <p class="tiny">Full walkthrough in the README. Free GPU time is limited and can change (recently around 30 GPU-hours a week on Kaggle): check your quota on Kaggle before a big batch. <strong>The notebook has not yet been confirmed on a real GPU</strong>; start with a small batch.</p>
        ${ui.lastImport ? `<div class="notice ${ui.lastImport.failed || ui.lastImport.skipped ? 'warn' : 'good'} small"><strong>Last import:</strong> ${ui.lastImport.images} image(s) from ${ui.lastImport.done} job(s)${ui.lastImport.failed ? `, ${ui.lastImport.failed} failed` : ''}${ui.lastImport.skipped ? `, ${ui.lastImport.skipped} skipped` : ''}.
          ${ui.lastImport.messages.length ? `<ul class="steps" style="margin-top:4px">${ui.lastImport.messages.slice(0, 10).map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}</div>` : ''}
      </div>
      <div class="card">
        <h2>Waiting for upload (by hand)</h2>
        ${manual.length ? `<div class="stack">${manual.map((j) => `<div><div class="small"><a href="#/${j.target.kind === 'characters' ? 'cast' : 'sets'}/${j.target.slug}">${esc(j.target.name)}</a></div>${jobCard(j)}</div>`).join('')}</div>` : '<p class="muted small">Nothing waiting.</p>'}
      </div>
    </div>
    ${kaggle.length ? `<h2 style="margin-top:28px">In the Kaggle batch</h2>
      <div class="card" style="padding:6px 10px"><table><thead><tr><th>For</th><th>What</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>
      ${kaggle.map((j) => `<tr><td><a href="#/${j.target.kind === 'characters' ? 'cast' : 'sets'}/${j.target.slug}">${esc(j.target.name)}</a></td>
        <td class="small">${esc(j.target.slot ? `Reference: ${j.target.slot}` : `${j.input.count} new attempt${j.input.count > 1 ? 's' : ''}`)} · ${esc(j.target.styleSlug || '')}</td>
        <td>${pillFor(j.status)}</td><td class="tiny">${fmtDate(j.createdAt)}</td>
        <td><button class="ghost danger" data-cancel="${j.id}">Cancel</button></td></tr>`).join('')}</tbody></table></div>` : ''}
    <h2 style="margin-top:28px">Recently finished</h2>
    ${finished.length ? `<div class="card" style="padding:6px 10px"><table><thead><tr><th>For</th><th>What</th><th>Model</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>
      ${finished.map((j) => `<tr><td>${esc(j.target.name)}</td><td class="small">${esc(j.target.slot ? `Reference: ${j.target.slot}` : 'New attempts')}</td><td class="small">${esc(j.model)}</td>
        <td>${pillFor(j.status)}${j.error ? `<div class="tiny">${esc(j.error)}</div>` : ''}${j.diagnostics ? `<div class="tiny">${esc([j.diagnostics.gpu, j.diagnostics.peakVramGB != null && `peak ${j.diagnostics.peakVramGB} GB`, j.diagnostics.seconds != null && `${j.diagnostics.seconds}s`, ...(j.diagnostics.notes || [])].filter(Boolean).join(' · '))}</div>` : ''}</td><td class="tiny">${fmtDate(j.updatedAt)}</td>
        <td>${j.status === 'failed' || j.status === 'cancelled' ? `<button class="ghost" data-retry="${j.id}" title="Puts the job back in the queue as a new revision; results from the old bundle are then ignored">Retry</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">Nothing yet.</p>'}`;

  on('#export', 'click', () => act(async () => {
    const res = await fetch('/api/jobs/export', { method: 'POST', headers: { 'X-Sideplate': '1' } });
    if (!res.ok) throw new Error((await res.json()).error);
    const blob = await res.blob();
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'bundle.zip';
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'Bundle downloaded. Upload it to Kaggle next.'));
  bindDrop('import', ([f]) => act(async () => {
    const res = await fetch('/api/jobs/import', { method: 'POST', body: f, headers: { 'X-Sideplate': '1' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    ui.lastImport = data;
    return data;
  }, (s) => `Imported ${s.images} image${s.images === 1 ? '' : 's'} from ${s.done} job${s.done === 1 ? '' : 's'}${s.failed ? `, ${s.failed} failed` : ''}${s.skipped ? `, ${s.skipped} skipped` : ''}`));
  on('[data-copy]', 'click', async (e, el) => { await navigator.clipboard.writeText(el.dataset.copy); toast('Prompt copied'); });
  on('[data-cancel]', 'click', (e, el) => act(() => api('POST', `/api/jobs/${el.dataset.cancel}/cancel`), 'Job cancelled'));
  $$('[id^="up-job-"]').forEach((el) => bindDrop(el.id, (files) => act(async () => {
    for (const f of files) await uploadTo(`/api/jobs/${el.id.slice(3)}/upload`, f);
  }, 'Image added')));
  on('[data-retry]', 'click', (e, el) => act(() => api('POST', `/api/jobs/${el.dataset.retry}/retry`), 'Back in the queue'));
}

// ---------- models ----------
async function viewModels() {
  const [models, caps] = await Promise.all([get('/api/models'), get('/api/capabilities')]);
  const region = STATE.regions[STATE.workspace.region];
  app.innerHTML = `
    <div class="page-head"><div><h1>Models &amp; licenses</h1>
      <p class="lead">Every model the studio can use, with its license as recorded here. The license guard checks each one against where you live (${esc(region)}) and whether the work is commercial. A model that allows commercial use only clears the <em>model</em>; what you make with it is marked "Cleared via model license" until you review it.</p></div></div>
    <div class="card" style="padding:6px 10px"><table>
      <thead><tr><th>Model</th><th>Does</th><th>License</th><th>Runs via</th><th>For you</th></tr></thead>
      <tbody>${models.map((m) => `<tr>
        <td><strong>${esc(m.label)}</strong><div class="tiny mono">${esc(m.id)}</div><div class="tiny">${esc(m.notes)}</div></td>
        <td class="small">${m.capabilities.map((c) => esc(caps.capabilities[c]?.label || c)).join('<br>')}</td>
        <td class="small">${m.licenseUrl ? `<a href="${esc(m.licenseUrl)}" target="_blank" rel="noopener">${esc(m.license)}</a>` : esc(m.license)}
          <div>${m.commercial ? '<span class="pill good">license allows commercial use</span>' : '<span class="pill bad">non-commercial</span>'}${m.excludedRegions.length ? ` <span class="pill warn">not in ${esc(m.excludedRegions.join(', '))}</span>` : ''}</div>
          <div class="tiny">Recorded in your registry${m.licenseCheckedAt ? `, checked ${esc(m.licenseCheckedAt)}` : ''}. Re-check the model card before relying on it.</div>
          ${m.version ? `<div class="tiny mono">${esc(m.version)}</div>` : ''}</td>
        <td class="small">${esc(m.adapter)}</td>
        <td>${m.status === 'planned' ? '<span class="pill">planned</span>' : m.guard.ok ? '<span class="pill good">allowed</span>' : `<span class="pill bad">blocked</span><div class="tiny">${esc(m.guard.reasons.join(' '))}</div>`}</td>
      </tr>`).join('')}</tbody></table></div>
    <details class="card" style="margin-top:20px"><summary style="cursor:pointer;font-weight:600">Add or edit a model</summary>
      <form id="model-form" class="form" style="margin-top:14px">
        <div class="form-2">
          <label class="field"><span>Id</span><input name="id" required placeholder="my-anime-model"></label>
          <label class="field"><span>Name</span><input name="label" required></label>
          <label class="field"><span>License</span><input name="license" required placeholder="Apache 2.0"></label>
          <label class="field"><span>License link</span><input name="licenseUrl"></label>
          <label class="field"><span>Runs via</span><select name="adapter">${caps.adapters.map((a) => opt(a.id, a.label)).join('')}</select></label>
          <label class="field"><span>Status</span><select name="status">${opt('available', 'Available')}${opt('planned', 'Planned')}${opt('blocked', 'Blocked')}</select></label>
        </div>
        <fieldset style="border:0;padding:0;margin:0"><legend class="small" style="font-weight:600;margin-bottom:6px">Does</legend><div class="row">
          ${Object.entries(caps.capabilities).map(([id, c]) => `<label class="check"><input type="checkbox" name="cap:${id}"><span>${esc(c.label)}</span></label>`).join('')}</div></fieldset>
        <label class="check"><input type="checkbox" name="commercial"><span>License allows commercial use (monetized videos)</span></label>
        <label class="field"><span>Regions where the license does not apply</span><input name="excludedRegions" placeholder="EU, UK, KR"></label>
        <label class="field"><span>Notes</span><input name="notes"></label>
        <div class="form-2">
          <label class="field"><span>Version / repository</span><input name="version" placeholder="org/model-name@revision"></label>
          <label class="field"><span>License checked on</span><input name="licenseCheckedAt" placeholder="YYYY-MM-DD"></label>
        </div>
        <p class="tiny" style="margin:0">Batch models also need the worker notebook to know them; see the README.</p>
        <div><button class="primary">Save model</button></div>
      </form></details>`;
  on('#model-form', 'submit', (e, form) => {
    e.preventDefault();
    const d = formData(form);
    const body = {
      id: d.id, label: d.label, license: d.license, licenseUrl: d.licenseUrl, adapter: d.adapter, status: d.status,
      commercial: d.commercial, notes: d.notes, version: d.version, licenseCheckedAt: d.licenseCheckedAt,
      capabilities: Object.keys(d).filter((k) => k.startsWith('cap:') && d[k]).map((k) => k.slice(4)),
      excludedRegions: d.excludedRegions.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    };
    act(() => api('POST', '/api/models', body), 'Model saved');
  });
}

// ---------- settings ----------
async function viewSettings() {
  const ws = STATE.workspace;
  const [backups, trash] = await Promise.all([get('/api/backups'), get('/api/trash')]);
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  app.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="grid grid-2">
      <div class="stack">
        <form id="ws-form" class="card form">
          <label class="field"><span>Studio name</span><input name="name" value="${esc(ws.name)}"></label>
          <label class="field"><span>Where you live</span><select name="region">${Object.entries(STATE.regions).map(([k, v]) => opt(k, v, k === ws.region)).join('')}</select>
            <small>Some model licenses do not apply in certain regions (e.g. Tencent Hunyuan in the EU and UK). The guard uses this.</small></label>
          <label class="check"><input type="checkbox" name="libraryCommercial" ${ws.libraryCommercial ? 'checked' : ''}><span>Treat library assets as commercial. Recommended: cast and sets can end up in any monetized project.</span></label>
          <div><button class="primary">Save</button></div>
        </form>
        <div class="card">
          <h2>Your data</h2>
          <p class="small">Everything is saved as plain files in:</p>
          <div class="prompt-box">${esc(STATE.home)}</div>
          <p class="small">Nothing is stored in the browser, so closing the tab or clearing browser data loses nothing. Each save replaces a file in one step, so a crash leaves the old or the new version, not a broken one. That is not a backup: use <strong>Back up now</strong> regularly, and avoid editing the same folder from two computers through a sync app at the same time.</p>
          <p class="tiny">To use a different folder, start the studio with <span class="mono">SIDEPLATE_HOME=/path/to/folder npm start</span>.</p>
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="spread"><h2 style="margin:0">Backups</h2><button id="backup" class="primary">Back up now</button></div>
          <p class="tiny">A full copy of your folder is saved in <span class="mono">${esc(backups.folder)}</span> and checked file by file.</p>
          ${backups.backups.length ? `<table><tbody>${backups.backups.slice(0, 10).map((b) => `<tr><td class="mono">${esc(b.name)}</td><td class="tiny">${b.fileCount} files · ${mb(b.totalBytes)}</td><td style="text-align:right"><button class="ghost" data-verify="${esc(b.name)}">Verify</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted small">No backups yet.</p>'}
          <details style="margin-top:10px"><summary class="small" style="cursor:pointer">How to restore a backup</summary>
            <ol class="steps small"><li>Close the studio (close its window or press Ctrl+C).</li><li>Rename your current folder (e.g. to <span class="mono">SideplateStudio-old</span>) so nothing is lost.</li><li>Copy the backup folder you want and rename the copy to the original folder name.</li><li>Start the studio and check your cast, sets and projects.</li></ol></details>
        </div>
        <div class="card">
          <h2>Trash</h2>
          <p class="tiny">Deleted attempts, clips, scene files, tracks and rejected images land here and can be put back.</p>
          ${trash.length ? `<table><tbody>${trash.slice(0, 30).map((t) => `<tr><td class="small">${esc(t.name)}<div class="tiny">${esc(t.reason || '')}</div></td><td class="tiny">${fmtDate(t.deletedAt)}</td><td style="text-align:right"><button class="ghost" data-restore="${esc(t.id)}">Restore</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted small">The trash is empty.</p>'}
        </div>
      </div>
    </div>`;
  on('#ws-form', 'submit', (e, form) => { e.preventDefault(); act(() => api('PUT', '/api/workspace', formData(form)), 'Settings saved'); });
  on('#backup', 'click', (e, btn) => {
    btn.disabled = true;
    btn.textContent = 'Backing up...';
    act(() => api('POST', '/api/backups'), (b) => (b.verified ? `Backup saved and verified (${b.checked} files)` : `Backup saved but verification found problems: ${b.problems.slice(0, 3).join(', ')}`));
  });
  on('[data-verify]', 'click', (e, el) => act(() => api('POST', `/api/backups/${el.dataset.verify}/verify`),
    (v) => (v.verified ? `All ${v.checked} files present and the right size` : `Problems: ${v.problems.slice(0, 3).join(', ')}`), { rerender: false }));
  on('[data-restore]', 'click', (e, el) => act(() => api('POST', `/api/trash/${el.dataset.restore}/restore`), 'Restored'));
}

render();
