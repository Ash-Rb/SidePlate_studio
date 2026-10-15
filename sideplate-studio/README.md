# Sideplate Studio · Phase 1: the library

A local studio for making AI series. Build your cast, sets, voices and music once, save them as plain files, and reuse them in every episode and every project.

Phase 1 covers the **library**: projects, art styles, cast (with generation history, cast winners, reference packs and character bibles), sets (with named cameras and plates), voice profiles, music & SFX with licenses, the model registry with its license guard, and the free Kaggle worker.

---

## 1. Start it

You need **Node.js 18 or newer** (free: get the LTS version from <https://nodejs.org>). Nothing else to install: the studio has no dependencies.

- **Mac:** double-click `Start Sideplate Studio.command`. The first time, macOS may block it: right-click it → *Open* → *Open*.
- **Windows:** double-click `Start Sideplate Studio.bat`.
- **Or in a terminal**, inside this folder: `npm start`

Your browser opens <http://localhost:4321>. To stop, close the terminal window or press `Ctrl+C`.

## 2. Where your work lives

Everything is saved as normal files in the `SideplateStudio/` folder next to this README. Nothing is stored in the browser, so closing the tab or clearing browser data loses nothing. Each save replaces a file in one step (written to a temp file, flushed to disk, then renamed), so a crash leaves the old or the new version of that file, not a half-written one. That protects single files; it is **not a backup**.

**Back up:** *Settings → Back up now* copies the whole folder to `SideplateStudio-backups/<date-time>/` and checks every file. You can also sync the folder (Google Drive, OneDrive, Dropbox, git), but don't edit it from two computers at the same time: sync apps can create conflicting copies. Only one studio can run on a folder at a time.

**Restore a backup:** close the studio, rename your current `SideplateStudio` folder (e.g. to `SideplateStudio-old`), copy the backup folder and rename the copy to `SideplateStudio`, then start the studio and check your work. Nothing is restored automatically, so nothing can be overwritten by accident.

**Deleted something?** Deleted attempts, clips, scene files, tracks and rejected images go to *Settings → Trash* and can be restored.

To keep your data somewhere else, start with `SIDEPLATE_HOME=/path/to/folder npm start` (Windows: `set SIDEPLATE_HOME=D:\Sideplate` then `npm start`).

```
SideplateStudio/
├── workspace.json                 # studio name, where you live, defaults
├── library/
│   ├── characters/<name>/
│   │   ├── identity.json          # role, status, visual description, character bible
│   │   ├── history/               # every attempt + a .json record (prompt, model, license, seed)
│   │   ├── looks/<style>/         # look.json + <slot>/<version>.png (every version kept)
│   │   └── voice/                 # profile.json, clips/, filters/ (phase 2)
│   ├── sets/<name>/
│   │   ├── set.json               # description and named cameras (the source of truth)
│   │   ├── cameras.json           # read-only copy of the cameras for other tools
│   │   ├── history/               # concept art attempts
│   │   ├── looks/<style>/         # plates per camera and lighting variant
│   │   └── scene/                 # .blend, .glb ... (scene/versions/ keeps replaced files)
│   ├── music/  sfx/               # audio + a .json with license and source
├── styles/<name>/style.json       # art style presets (+ refs/)
├── projects/<name>/project.json   # format, style, commercial flag, linked assets
├── models/registry.json           # every model with its license
├── queue/                         # jobs/, exported bundles, imported results + import logs
└── .trash/                        # deleted files, restorable from Settings
```

## 3. First session: Good Company

1. **Art styles** → open *Anime warm* and tune the prompt prefix and palette. This is the paint layer for everything.
2. **Projects** → create *Good Company* (channel Side Plate, style Anime warm, 16:9, commercial, weekly).
3. **Cast** → add *Marco*. On *Identity & bible*, write a short **visual description** (looks only: face, hair, build, outfit) and fill in the bible.
4. **Generate & history** → pick *ChatGPT image generation (by hand)*, add extra words, click *Queue job*. Copy the prompt, generate in ChatGPT, drop the image back in. Repeat until you like one, star the good ones, click **Cast this one**.
5. **Reference pack** → pick a model, click *Queue jobs for empty slots*. This makes front, three-quarter, side, full body and four expressions from the winner. With ChatGPT, upload the cast image together with each prompt. Once a slot has an approved image, new results for it arrive as **candidates** underneath: click *Use* to approve one or ✕ to reject it. Older versions stay restorable.
6. **Sets** → add *Restaurant kitchen*, define named cameras (e.g. `kitchen-wide` with variants `day, after-hours`), generate concept art, choose one, then build plates.
7. **Voice** tab → set how lines are made (mix, filter or TTS) and add reference clips.
8. **Music & SFX** → add tracks with their license. Only tracks you mark *OK for commercial use* can be linked to a commercial project.
9. Back in the project, tick the cast, sets and tracks it uses.

**Tip for prompts:** SDXL reads roughly the first 75 words-pieces of a prompt and ignores the rest, so keep style prefixes and visual descriptions short and concrete.

## 4. The free Kaggle batch (weekly)

Queue Kaggle jobs whenever you like during the week (choose *Stable Diffusion XL 1.0 · Kaggle batch* as the model). On batch day:

1. **Once:** create a free account on <https://www.kaggle.com> and verify your phone number (Settings → Phone verification). This unlocks GPUs and internet in notebooks.
2. In the studio, **Jobs → Export bundle.zip**.
3. On Kaggle: **Create → New Notebook**. Then **File → Import Notebook** and upload `worker/sideplate_worker.ipynb` from this folder (also downloadable from the Jobs page).
4. In the notebook's right panel: **Add Input → Upload** your `bundle-….zip` (give the dataset any name).
5. **Settings → Accelerator → GPU T4 x2** (or P100), and **Internet → On**.
6. **Run All.** The first run downloads the models (a few GB). Each 1024×1024 image takes roughly half a minute to a minute on a T4.
7. When it finishes, open the **Output** panel and download **results.zip**.
8. In the studio, **Jobs → drop results.zip**. Images land in each character's or set's history and reference packs automatically.

Re-running the notebook skips finished jobs. Failed jobs can be retried from the Jobs page. Google Colab works the same way: upload the bundle into the file panel, use a T4 runtime, run all, download `results.zip`.

Kaggle's free tier gives about 30 GPU-hours a week. Check the quota on your Kaggle profile.

## 5. Rights and the license guard

Every image and track records where it came from and how far its rights have been checked:

| State | Meaning | Commercial projects |
|---|---|---|
| Needs review | Nobody has confirmed the rights yet | Blocked |
| Cleared via model license | Made by a model whose registry entry allows commercial use; the content itself was not reviewed | Allowed |
| Cleared by you | You ticked "I have checked I may use this" | Allowed |
| Evidence on file | Cleared, with a link, receipt or note recorded | Allowed |

Images you drop in by hand are *Needs review* unless you tick the declaration; use *Mark cleared* later. Voice clips record whose voice it is.

### The guard

`models/registry.json` lists every model with its license, whether it allows commercial use, and any regions where the license does not apply. The guard refuses:

- non-commercial models (e.g. FLUX.1 [dev]) for anything that may end up in a monetized project;
- models whose license excludes where you live (e.g. Tencent Hunyuan in the EU and UK; set your region in *Settings*);
- linking assets made with non-commercial models into a commercial project;
- linking music or SFX not cleared into a commercial project;
- anything made with a model that is no longer in the registry (it is never assumed to be fine);
- switching a project to commercial while something linked to it would fail these checks.

Each project page shows a **License check** panel listing anything that needs attention.

Every image keeps a record of the model and license it came from. This is a safety net, not legal advice: check each model card and track license yourself.

## 6. On a Mac M1 Air

The studio itself (library, projects, editing, Blender plates later) runs comfortably on an M1 Air. AI generation stays on Kaggle: an M1 Air can run some image models slowly through other apps, but it is fanless and has limited shared memory, so a weekly batch is far more practical on Kaggle's free GPU.

## 7. Swapping tools

The studio core only knows **capabilities** (generate image, reference pack, TTS, ...). Each tool is an **adapter** in `server/adapters/`:

- `manual-import.js`: you generate elsewhere (ChatGPT, your own art) and upload.
- `kaggle-bundle.js`: jobs go out as one zip to a batch worker and come back as `results.zip`.

To add a tool: write an adapter, add it to `server/adapters/index.js`, add its models to the registry (Models & licenses → *Add or edit a model*), and run `npm test`. The contract tests in `tests/contract.test.js` check every adapter. Batch models also need an entry in the worker notebook's `SUPPORTED` list (edit `worker/build_notebook.py`, then run `python3 worker/build_notebook.py`).

## 8. Troubleshooting

- **"Port already in use":** another copy is running, or start on another port: `PORT=4400 npm start`.
- **Kaggle: "No GPU" or downloads fail:** check the accelerator is a GPU and internet is on (phone verification needed).
- **Kaggle: out of memory:** the notebook already retries with memory savers, then at a smaller size, and records what it did. If a job still fails, use fewer images per job or a smaller shape. On GPUs under 20 GB it runs in low-memory mode automatically.
- **"Sideplate Studio is already running for this folder":** another copy is open; use that window or close it.
- **An import says results were skipped as stale:** the job was retried or finished after that bundle was exported. Export a new bundle and run it.
- **A page says it cannot load:** the studio server was closed; start it again.

## 9. What is not here yet

- **Phase 2:** Voice Lab (effect and AI voice filters), shot list editor, draft edits in Revideo, 3D set viewer and Blender plates, local Kokoro TTS.
- **Phase 3:** per-shot video generation (Wan 2.2) and final renders.

## Development

- `npm test` runs the contract tests and an end-to-end API test on a throwaway workspace.
- The server is plain Node (`server/`), the interface plain JavaScript (`public/`), no build step.
- `tests/notebook.test.js` runs the worker notebook with a stand-in GPU (`worker/mock_run.py`, needs python3 + Pillow; skipped otherwise). **That is not a real GPU test.** The real check is the smoke test in `docs/phase1-review-response.md`.
- The worker notebook is generated: edit `worker/build_notebook.py`, then run `python3 worker/build_notebook.py`.
