# Phase 1 review: verification and fixes

**Date:** 15 October 2026 · **Baseline reviewed:** commit `80d3a3b` · **Phase 2 not started.**

Every finding was checked against the baseline code before changing anything. "Confirmed" findings marked *(reproduced)* were demonstrated by running the untouched baseline server and triggering the defect. Line numbers refer to the **baseline** files.

**Headline:** 20 findings confirmed, 3 partially confirmed, none rejected. All confirmed and partial ones are fixed with regression tests. **The worker notebook is NOT TESTED ON A REAL GPU**; that remains the one open gate.

## 1. Findings

| # | Sev | Baseline file:line | Verdict | Impact | Fix | Test |
|---|---|---|---|---|---|---|
| 1 | P0 | `server/library.js:232-248` (`setLook`; old file unlinked at 242 *before* the new write at 243) | Confirmed (reproduced: one file per slot, no history) | A replacement, a new job result, or a failed write could silently destroy an approved reference image | Every image is a new immutable version file (`looks/<style>/<slot>/<version>.png`); `look.json` (v2) updated atomically only after the file is safely written. Results for an approved slot arrive as **candidates**; approve / reject / restore. Version-1 `look.json` read in place, no files moved | `regression.test.js` #1 ×3 (simulated write failure, candidates, legacy read) |
| 2 | P0 | `server/workspace.js:149`; `server/index.js:126-150` | Confirmed (reproduced: project became commercial with an unvetted asset linked) | Commercial projects could contain assets that fail the guard | `PUT /api/projects/:slug` audits all links before a false→true switch (409 with reasons); new **License check** panel on each project | #2 |
| 3 | P0 | `server/index.js:137` (`catch { continue; }`) | Confirmed (reproduced: HTTP 200) | Removed/unknown models were treated as cleared | `server/guard.js` fails closed: unknown model = problem | #3 |
| 4 | P0 | `server/library.js:179-196`; `server/audio.js:23`; `server/library.js:286-299`; `server/index.js:158` | Partially confirmed | Rights were inferred only from the model flag; uploads had no rights record; voice clips had no consent record; upload meta could set `commercial: false`. That last one only bypassed the guard for a non-commercial model *not* marked `blocked` (default FLUX is blocked, so not exploitable with defaults) | `server/rights.js`: review states (needs-review / model-cleared / user-cleared / evidence-on-file), origin, evidence; uploads need a declaration; voice clips record consent; upload meta is allow-listed; model version + license check date stored with every image | #4 ×2 |
| 5 | P1 | `server/zip.js:86-122` | Confirmed | No CRC check; inflate not capped (bomb expands before the size check at 109); offsets not bounds-checked; duplicate names silently overwrite (119) | Bounds checks everywhere; inflate capped at declared size + 1; real size and CRC must match; duplicates, encryption, zip64, unsafe names refused; entry limit | #5 |
| 6 | P1 | `server/jobs.js:179-216` | Partially confirmed | Re-importing *done* jobs was already skipped, but stale results after a retry were accepted, nothing tied a result to its bundle, and a failure mid-job left partial state unexplained | Bundle id + job revision written into the bundle and echoed by the worker; stale results refused; all images validated before anything is saved (staged); per-import log in `queue/imports/`; partial saves recorded on the job | #6 ×2 |
| 7 | P1 | `server/library.js:302-308` | Confirmed | Same-named scene upload overwrote `kitchen.blend` | Previous file moved to `scene/versions/<name>.<timestamp>` | #7 |
| 8 | P1 | `server/store.js:68-81` | Partially confirmed | Rename-based writes existed, but no fsync, pid-only temp names, no single-instance protection, no backup feature. Same-process concurrent writes were not an issue (writes are synchronous) | fsync before rename, random temp names, temp cleanup on failure; `.studio.lock` (one studio per folder); **Back up now** with per-file verification; documented manual restore. README no longer claims crash-proof storage | #8 |
| 9 | P1 | `server/index.js:236-244`, `263-266` | Confirmed (reproduced: write from `localhost:3000` → 200; `/files/models/registry.json` → 200) | Any page on another local port could write; requests without an Origin were accepted; all workspace JSON was served; symlinks were followed | Writes need `X-Sideplate: 1` (forces a CORS preflight the server never grants) and, if present, an Origin with the exact host **and port**; Host port checked; `/files/` serves media/3D only, no dotfiles, realpath must stay inside the workspace | #9 |
| 10 | P1 | `server/index.js:56-65`, `81` | Confirmed | Up to 1 GB held in RAM (twice, with `Buffer.concat`) | Uploads stream to bounded temp files (images 50 MB, audio 500 MB, scenes 2 GB, results 512 MB), moved into place by rename, always cleaned up | #10 |
| 11 | P1 | `server/library.js:310-324`; `server/audio.js` delete | Confirmed | Deletes were permanent; deleting the cast winner silently cleared it; open jobs whose reference image was deleted made export crash; linked tracks could be deleted | Trash with restore (file + sidecar together); cast winner protected; images used by open jobs protected; linked tracks protected; export checks reference images first | #11 |
| 12 | P1 | `worker/build_notebook.py` cells 1, 4 | Partially confirmed | API calls matched the documented diffusers IP-Adapter usage; but only the first manifest found was used (non-deterministic with several bundles) and results did not identify their bundle | All bundles found (zipped or unpacked), newest copy of a job wins, results echo bundle id and job revision, only this run's results packed | `notebook.test.js` (mocked) |
| 13 | P1 | notebook pip cell | Confirmed | Broad ranges (`diffusers>=0.30,<1`) | Pinned: diffusers 0.32.2, transformers 4.47.1, accelerate 1.2.1, huggingface_hub 0.27.1; versions printed and saved in job diagnostics. **Pinned set not yet run on Kaggle** | n/a |
| 14 | P1 | notebook cell 3; README | Confirmed | "T4 x2" implied pooled memory; no low-memory path; no OOM handling or diagnostics | Single GPU (`cuda:0`) stated; automatic low-memory mode (model CPU offload, enabled after IP-Adapter loads) under 20 GB; OOM → memory savers → smaller size → clear error; peak VRAM recorded | `notebook.test.js` (mocked OOM) |
| 15 | P1 | notebook cell 4 | Partially confirmed | Per-job saving and skip-on-rerun existed; duplicates across bundles and stale entries were not handled | Keyed by job + revision + bundle; skip only if files still exist; duplicate ids collapsed | `notebook.test.js` |
| 16 | P1 | n/a | **NOT TESTED ON REAL GPU** | Unknown whether the pinned stack runs and fits on a Kaggle T4 | Checklist in section 4 | Manual |
| 17 | P1 | `public/app.js:925`; README; notebook | Partially confirmed | Quota stated as fact; GPU checked but not internet or disk | Hedged wording; runtime checks for GPU, VRAM, internet, disk | n/a |
| 18 | P2 | `public/app.js:394-395`, `610-611`; `server/library.js:165` | Confirmed (reproduced: renamed camera got a new id, plate left under the old one) | Renaming a camera disconnected its plates | Stable ids sent from the editor and kept by the server; removing a camera or renaming a lighting variant that has plates is refused with an explanation | #18 |
| 19 | P2 | `server/library.js:155-156` | Confirmed (low impact: `cameras.json` was never read) | Two copies could diverge | `set.json` is canonical; `cameras.json` labelled as a generated read-only copy | #19 |
| 20 | P2 | `server/workspace.js:147`; `server/jobs.js:77` | Confirmed (reproduced: fps -5 stored) | Nonsense frame rates; huge seeds would crash the worker | fps must be 24/25/30/50/60; seed 0 to 2^32-1 or random; width/height/count were already validated | #20 |
| 21 | P2 | `public/app.js:102`, `508`, `547` | Confirmed | "Sent to Kaggle" before anything was sent; "Generate missing" didn't say it queues; voice tab looked functional | "Exported: upload to Kaggle", "Queue jobs for empty slots", retry explained, voice tab marked notes-only | Manual (browser) |
| 22 | P2 | UI throughout | Partially confirmed | Delete confirmations existed; no history or recovery | Trash and version history in the UI; backup/restore in Settings | Manual (browser) |
| 23 | P2 | `public/app.js:267`, `721`, `882` | Confirmed | "Commercial OK" read as a legal verdict; model version not kept | Review-state pills everywhere; models show "license allows commercial use, recorded in your registry, checked <date>"; model version + license URL + check date stored per image | #4 |

**Production strategy:** projects record a main format plus extra output formats (e.g. 16:9 episodes with 9:16 Shorts). Character and set identity never depended on orientation: looks are keyed by style and slot, not aspect ratio. No reframing features were added (Phase 2).

## 2. Change sets (commits)

```
001ff9b Storage: fsync'd unique-temp writes, recoverable trash, test hook
15bcc30 P0: versioned reference images, rights records, fail-closed license guard
8dce0f0 P1: hardened zip reader, staged and idempotent result imports (#5, #6)
46f2eec P1: request checks, media-only file serving, streamed uploads, backups, single-instance lock
343b681 Tests: regression tests for review findings
3281ea3 P1: worker notebook: all bundles, bundle/rev echo, pinned libs, runtime checks, low-memory mode, OOM fallback (#12-#17)
dc0a388 P2: interface for review findings
(final)  Docs, README, seed validation
```

Still zero npm dependencies. **Data migration:** none needed. Old `look.json` files are read as-is, and old records without rights are read conservatively (direct uploads = needs review). Back up before upgrading anyway (*Settings → Back up now* once the new version is running, or copy the `SideplateStudio` folder first).

## 3. Tests

Command: `npm test` (Node 22.22.0). Actual output:

```
ok 1 - first run creates the workspace, a default style and the registry
ok 2 - full library flow
ok 3 - manual job, retry and audio license rules
ok 4 - safety: path traversal and foreign hosts are refused
ok 5 - adapter manual-import: shape
ok 6 - adapter manual-import: submit returns a valid status
ok 7 - adapter kaggle-bundle: shape
ok 8 - adapter kaggle-bundle: submit returns a valid status
ok 9 - adapter kaggle-bundle: bundle -> results round trip
ok 10 - every registry model points at a real adapter and known capabilities
ok 11 - license guard
ok 12 - zip: crc32 and deflate round trip
ok 13 - mocked notebook round trip (stand-in GPU, not a real GPU test)
ok 14 - #1 a failed replacement never destroys the approved reference image
ok 15 - #1 job results for an approved slot arrive as candidates, then approve / reject / restore
ok 16 - #1 version-1 look.json files are read without moving any files
ok 17 - #2 switching a project to commercial re-checks what is already linked
ok 18 - #3 a model missing from the registry fails closed
ok 19 - #4 direct uploads need a rights declaration; meta cannot switch off the guard
ok 20 - #4 uncleared music is blocked; clearing with evidence allows it
ok 21 - #5 zip reader refuses bombs, damage, duplicates and unsafe names
ok 22 - #6 stale results (job retried after export) are refused; re-import is idempotent
ok 23 - #6 an import with one invalid image saves nothing (staged)
ok 24 - #7 re-uploading a scene file keeps the previous version
ok 25 - #8 backup copies the workspace and verifies it
ok 26 - #9 writes need the studio header and its exact origin; files are allowlisted
ok 27 - #10 uploads stream to disk and over-limit uploads are refused
ok 28 - #11 deleting is safe: cast winner protected, files go to trash and can be restored
ok 29 - #18 renaming a camera keeps its plates; removing a camera with plates is refused
ok 30 - #19 cameras.json is a generated copy of set.json
ok 31 - #20 frame rate and output formats are validated
# tests 31  # pass 31  # fail 0  # skipped 0
```

**Mocked vs real:**
- *Mocked notebook test* (test 13; also runnable as `python3 worker/mock_run.py <bundle folder> <work folder> --oom-once`): real studio export, the notebook's own code for bundle discovery, job order, retry/skip and packing, a **stand-in** for the GPU pipeline (including a simulated out-of-memory), then the real studio import. Proves the formats and control flow agree.
- *Real GPU test:* **NOT TESTED ON REAL GPU.** No Kaggle access from this environment.
- The interface was also clicked through in a headless browser (rights declaration, blocked link, Mark cleared, slot upload, candidate → Use, backup). No unexpected console errors; the only error logged was the deliberately blocked link (HTTP 403).

## 4. Real Kaggle smoke test (to do on your first batch day)

1. In the studio, cast a character. Queue **one** *Stable Diffusion XL 1.0 · Kaggle batch* job with 1 image, and a reference pack for **two slots only** (Reference pack → pick the model → upload nothing → *Queue jobs for empty slots*, then cancel all but two on the Jobs page).
2. Export the bundle and upload it to Kaggle as described in the README (GPU T4, internet on).
3. Run all. Write down what step 3 prints: **GPU name, VRAM, low-memory mode, versions**.
4. Note any failed cell and its last 20 lines of output.
5. Download `results.zip` and import it. On the Jobs page, each finished job shows **peak VRAM and seconds**.
6. Open the images: the plain image looks like the prompt; the two reference images resemble the cast winner.
7. Report back: versions, peak VRAM, seconds per image, failures. If the pinned versions fail to install or import, that is the first thing to fix.

## 5. Manual QA checklist (Mac or Windows, no developer tools)

1. Start with the Start file; the browser opens. Start it a second time: it refuses with "already running".
2. Create a project, a character, and drop in an image **without** ticking the declaration → it shows *Needs review*.
3. Link that character to a commercial project → refused with a reason. *Mark cleared* → linking works.
4. Cast an image, then try deleting it → refused. Delete another attempt → *Settings → Trash* → Restore → it's back.
5. Reference pack: upload into the *Front* slot. Queue all slots again with *ChatGPT (by hand)*; drop an image on the Front job → it appears as a **candidate**, the approved image is unchanged. Click *Use*, then open *older versions* and *Restore* the first one.
6. Set with a camera: add a plate, rename the camera, save → the plate is still there. Delete the camera → refused.
7. Upload `kitchen.blend` twice → "older version kept".
8. *Settings → Back up now* → "saved and verified". *Verify* again later.
9. Make a non-commercial project with an unreviewed image linked; tick *Commercial* → refused with the list.
10. Jobs page: export, then import a random zip → clear error, nothing changes.

## 6. Remaining risks

- **Real GPU:** the notebook and its pinned libraries have never run on a Kaggle GPU. Whether SDXL + IP-Adapter at 1024×1024 fits a T4 without offloading is unverified; low-memory mode is on by default for this reason, which is slower.
- **Free tiers:** Kaggle quota, session length, internet access and model downloads can change or fail at any time. The notebook checks and reports; it can't guarantee them.
- **External licenses:** registry entries record licenses as checked on 15 October 2026 (SDXL Open RAIL++-M, IP-Adapter Apache 2.0, VAE fix MIT, OpenAI terms for ChatGPT images). Licenses can change; re-check model cards. "Cleared via model license" means the model allows commercial use, not that a given image is free of third-party rights.
- **Rights states are self-declared.** The studio records what you declare; it can't verify that an uploaded image or track is really yours.
- **Storage:** atomic replace + fsync protects single files; it is not a transaction across several files and not protection against sync-app conflicts or disk failure. Backups are copies on the same disk unless you move them; keep one elsewhere.
- **Trash is never emptied automatically,** so it grows. Emptying it is a future feature; for now delete old items in `SideplateStudio/.trash` by hand if space matters.
- **Backups copy everything,** including large scene files, so they can be big.
- **Lighting variant renames** are refused when plates exist (safe but strict); variants don't yet have their own stable ids.
- **Local security** assumes the computer itself is trusted: any program already running as you can read the folder directly.

## 7. Phase 1 completion gate

| Gate | Status |
|---|---|
| Save and reopen a character (identity, bible, attempts, cast) | Met (API + browser) |
| Safely generate, reject and regenerate looks; approved images never silently replaced | Met (#1 tests + browser) |
| Reuse assets across projects (linked, not copied) | Met (link tests) |
| Recover from failed imports (staged, stale refused, retry) | Met (#6 tests) |
| Recover deleted items and restore backups | Met (#8, #11; restore is manual by design) |
| Validate licenses conservatively (fail closed, rights states, commercial switch) | Met (#2, #3, #4) |
| One real GPU round trip: queued job → Kaggle → usable saved image | **Not met: NOT TESTED ON REAL GPU.** Needs your first Kaggle run (section 4) |
