"""Builds sideplate_worker.ipynb from the cells below.

Edit the cells here, then run:  python3 worker/build_notebook.py
"""
import json
import pathlib

CELLS = []


def md(text):
    CELLS.append({"cell_type": "markdown", "metadata": {}, "source": text.strip("\n")})


def code(text):
    CELLS.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": text.strip("\n")})


md("""
# Sideplate Studio worker

Turns one or more **bundle-….zip** files exported from Sideplate Studio (Jobs page) into a **results.zip** you import back.

**Kaggle setup (each session):**
1. *Add Input* → *Upload* → choose your `bundle-….zip` (create a new dataset; any name). Several bundles can be added; the newest copy of each job wins.
2. *Settings* → *Accelerator* → **GPU T4 x2** or **GPU P100**. Only one GPU is used: two T4s do not add up to one bigger GPU.
3. *Settings* → *Internet* → **on** (needs a phone-verified Kaggle account).
4. *Run All*. When it finishes, open the *Output* panel and download **results.zip**.

**Google Colab works too:** *Runtime → Change runtime type → T4 GPU*, upload the bundle zip into the file panel, then *Run all*.

Nothing about free GPUs is guaranteed (quota, session length, internet, model downloads); the first cells check what this session actually has and stop with a clear message if something is missing. Only models in `SUPPORTED` run here; everything else comes back to the studio as a failed job.

*Status: tested end to end with a stand-in for the GPU. Not yet confirmed on a real Kaggle GPU.*
""")

code(r"""
# 1. Find every bundle and collect the jobs
import glob, json, os, pathlib, random, shutil, time, zipfile

ON_KAGGLE = os.path.exists("/kaggle/input")
WORK = pathlib.Path(os.environ.get("SIDEPLATE_WORK") or ("/kaggle/working" if ON_KAGGLE else "/content" if os.path.exists("/content") else ".")).resolve()
(WORK / "outputs").mkdir(parents=True, exist_ok=True)
SEARCH = [p for p in [os.environ.get("SIDEPLATE_SEARCH"), "/kaggle/input", "/content"] if p and os.path.exists(p)] or [str(WORK)]

def load_bundles():
    found = {}
    for root in SEARCH:
        # Kaggle usually unpacks an uploaded zip, so look for manifests first...
        for m in glob.glob(f"{root}/**/manifest.json", recursive=True):
            d = pathlib.Path(m).parent
            if "outputs" in d.parts:
                continue
            try:
                man = json.loads(pathlib.Path(m).read_text())
            except Exception:
                continue
            if man.get("format") == "sideplate-bundle":
                found.setdefault(man.get("bundleId") or str(d), (d, man))
        # ...and also accept zips that were not unpacked.
        for z in sorted(glob.glob(f"{root}/**/*.zip", recursive=True)):
            if pathlib.Path(z).name == "results.zip":
                continue
            try:
                with zipfile.ZipFile(z) as zf:
                    if "manifest.json" not in zf.namelist():
                        continue
                    man = json.loads(zf.read("manifest.json"))
                    if man.get("format") != "sideplate-bundle":
                        continue
                    key = man.get("bundleId") or pathlib.Path(z).stem
                    if key in found:
                        continue
                    target = WORK / "bundles" / key
                    if not target.exists():
                        zf.extractall(target)  # zipfile drops absolute and ".." path parts
                    found[key] = (target, man)
            except zipfile.BadZipFile:
                print(f"Skipping damaged zip: {z}")
    return sorted(found.values(), key=lambda x: x[1].get("createdAt", ""))

bundles = load_bundles()
if not bundles:
    raise FileNotFoundError("No Sideplate bundle found. Add your bundle-....zip as an input (Kaggle) or upload it (Colab).")

jobs = {}
for d, man in bundles:  # oldest first, so the newest bundle's copy of a job wins
    for j in man["jobs"]:
        jobs[j["id"]] = {**j, "_dir": str(d), "_bundleId": man.get("bundleId")}
jobs = sorted(jobs.values(), key=lambda j: (j["capability"] == "image.reference_pack", j["id"]))

for d, man in bundles:
    print(f"Bundle {man.get('bundleId') or '(no id)'}: {len(man['jobs'])} jobs, created {man.get('createdAt', '?')}")
print(f"{len(jobs)} unique jobs, {sum(int(j.get('count', 1)) for j in jobs)} images to make")
""")

code(r"""
# 2. Install a pinned set of libraries (PyTorch comes with Kaggle and Colab).
#    Pinned so a library update cannot silently change the results.
#    This exact set has not yet been run on a real Kaggle GPU: if it fails, note
#    the error and the versions printed in step 3.
!pip install -q "diffusers==0.32.2" "transformers==4.47.1" "accelerate==1.2.1" "huggingface_hub==0.27.1" safetensors
""")

code(r"""
# 3. Check this session, then define the models.
#    Commercially licensed models only:
#      SDXL base 1.0        CreativeML Open RAIL++-M (commercial use allowed, use-based restrictions)
#      SDXL VAE fp16 fix    MIT (same weights as the SDXL VAE, made safe for fp16)
#      IP-Adapter (SDXL)    Apache 2.0, used for reference packs
import gc, socket
import importlib.metadata as metadata
import torch
from PIL import Image
from diffusers import AutoencoderKL, StableDiffusionXLPipeline

if not torch.cuda.is_available():
    raise RuntimeError("No GPU in this session. Settings -> Accelerator -> GPU, then run again.")
DEVICE = "cuda:0"  # one GPU is used even when two are attached; their memory does not pool
props = torch.cuda.get_device_properties(0)
GPU_NAME = props.name
VRAM_GB = props.total_memory / 1024**3
# On a ~16 GB T4, SDXL + IP-Adapter at 1024x1024 is close to the limit, so
# low-memory mode (model offloading) is on unless the GPU is clearly larger.
LOW_MEMORY = os.environ.get("SIDEPLATE_LOW_MEMORY", "auto") == "1" or (os.environ.get("SIDEPLATE_LOW_MEMORY", "auto") == "auto" and VRAM_GB < 20)
free_disk = shutil.disk_usage(WORK).free / 1e9
try:
    socket.create_connection(("huggingface.co", 443), timeout=8).close()
except OSError:
    raise RuntimeError("No internet in this session, so the models cannot download. Settings -> Internet -> on (Kaggle needs a phone-verified account).")
VERSIONS = {p: metadata.version(p) for p in ["torch", "diffusers", "transformers", "accelerate", "huggingface_hub"]}
print(f"GPU: {GPU_NAME}, {VRAM_GB:.1f} GB | low-memory mode: {LOW_MEMORY} | free disk: {free_disk:.0f} GB")
print("Versions:", VERSIONS)
if free_disk < 20:
    print("Warning: under 20 GB of free disk; the model downloads need about 10 GB.")

SUPPORTED = {
    "sdxl-base-1.0": {
        "repo": "stabilityai/stable-diffusion-xl-base-1.0",
        "vae": "madebyollin/sdxl-vae-fp16-fix",
        "ip_adapter": ("h94/IP-Adapter", "sdxl_models", "ip-adapter_sdxl.bin"),
    },
}
OOM_ERRORS = (torch.cuda.OutOfMemoryError,)
_state = {"model": None, "pipe": None, "ip": False}

def free_memory():
    gc.collect()
    torch.cuda.empty_cache()

def _build(model_id, with_ip):
    spec = SUPPORTED[model_id]
    vae = AutoencoderKL.from_pretrained(spec["vae"], torch_dtype=torch.float16)
    pipe = StableDiffusionXLPipeline.from_pretrained(spec["repo"], vae=vae, torch_dtype=torch.float16, variant="fp16", use_safetensors=True)
    pipe.set_progress_bar_config(disable=True)
    if with_ip:
        repo, sub, weights = spec["ip_adapter"]
        pipe.load_ip_adapter(repo, subfolder=sub, weight_name=weights)
    if LOW_MEMORY:
        pipe.enable_model_cpu_offload(gpu_id=0)  # must come after the IP-Adapter is loaded
    else:
        pipe.to(DEVICE)
    return pipe

def get_pipe(model_id, with_ip):
    if _state["model"] == model_id and _state["ip"] == with_ip:
        return _state["pipe"]
    _state.update(model=None, pipe=None, ip=False)
    free_memory()
    _state.update(model=model_id, pipe=_build(model_id, with_ip), ip=with_ip)
    return _state["pipe"]

def run_pipe(pipe, job, seed, width, height, ref):
    kwargs = dict(
        prompt=job["prompt"],
        negative_prompt=job.get("negative") or None,
        width=width, height=height,
        num_inference_steps=int(job.get("steps", 30)),
        guidance_scale=float(job.get("guidance", 6.5)),
        generator=torch.Generator("cpu").manual_seed(seed),  # CPU generator: same seed, same image in either memory mode
    )
    if ref is not None:
        pipe.set_ip_adapter_scale(float(job.get("refStrength", 0.6)))
        kwargs["ip_adapter_image"] = ref
    return pipe(**kwargs).images[0]

def enable_memory_savers(pipe):
    pipe.enable_attention_slicing()
    pipe.enable_vae_tiling()

def load_ref(path):
    return Image.open(path).convert("RGB")

def reset_peak():
    torch.cuda.reset_peak_memory_stats(0)

def peak_gb():
    return round(torch.cuda.max_memory_allocated(0) / 1024**3, 2)
""")

code(r"""
# 4. Run the jobs: plain generations first, then reference packs (IP-Adapter).
#    Progress is saved after every job; running this cell again skips finished
#    work whose files are still present.
RESULTS_FILE = WORK / "results.json"
previous = json.loads(RESULTS_FILE.read_text())["results"] if RESULTS_FILE.exists() else []
done = {(r["jobId"], r.get("jobRev"), r.get("bundleId")): r for r in previous}

def key(job):
    return (job["id"], job.get("rev"), job["_bundleId"])

def save_results():
    RESULTS_FILE.write_text(json.dumps({
        "format": "sideplate-results", "version": 2,
        "bundleIds": [man.get("bundleId") for _, man in bundles],
        "results": list(done.values()),
    }, indent=2))

def generate_with_fallback(pipe, job, seed, ref, notes):
    width, height = int(job.get("width", 1024)), int(job.get("height", 1024))
    for step in range(3):
        try:
            return run_pipe(pipe, job, seed, width, height, ref)
        except OOM_ERRORS:
            free_memory()
            if step == 0:
                enable_memory_savers(pipe)
                notes.append("out of memory: retried with attention slicing and VAE tiling")
            elif step == 1:
                width, height = max(512, int(width * 0.75) // 64 * 64), max(512, int(height * 0.75) // 64 * 64)
                notes.append(f"out of memory again: retried at {width}x{height}")
            else:
                raise

def run_job(job):
    model_id = job["model"]
    base = {"jobId": job["id"], "jobRev": job.get("rev"), "bundleId": job["_bundleId"]}
    if model_id not in SUPPORTED:
        return {**base, "error": f"Model {model_id} is not available in this worker", "files": [], "seeds": []}
    is_pack = job["capability"] == "image.reference_pack"
    pipe = get_pipe(model_id, with_ip=is_pack)
    ref = load_ref(pathlib.Path(job["_dir"]) / job["refImage"]) if is_pack else None
    notes, files, seeds = [], [], []
    reset_peak()
    t0 = time.time()
    base_seed = job.get("seed")
    for k in range(int(job.get("count", 1))):
        seed = (base_seed + k) if base_seed is not None else random.randint(0, 2**31 - 1)
        image = generate_with_fallback(pipe, job, seed, ref, notes)
        name = f"outputs/{job['id']}-r{job.get('rev', 1)}_{k}.png"
        image.save(WORK / name)
        files.append(name)
        seeds.append(seed)
    diagnostics = {"gpu": GPU_NAME, "peakVramGB": peak_gb(), "seconds": round(time.time() - t0, 1),
                   "lowMemory": LOW_MEMORY, "notes": notes, "versions": VERSIONS}
    return {**base, "files": files, "seeds": seeds, "diagnostics": diagnostics}

start = time.time()
for i, job in enumerate(jobs, 1):
    r = done.get(key(job))
    if r and not r.get("error") and all((WORK / f).exists() for f in r["files"]):
        print(f"[{i}/{len(jobs)}] {job['id']} already done, skipping")
        continue
    t0 = time.time()
    try:
        done[key(job)] = run_job(job)
        status = done[key(job)].get("error") or "ok"
    except OOM_ERRORS:
        free_memory()
        done[key(job)] = {"jobId": job["id"], "jobRev": job.get("rev"), "bundleId": job["_bundleId"], "files": [], "seeds": [],
                          "error": f"Out of memory on {GPU_NAME} even at a smaller size. Try fewer images per job or a smaller shape.",
                          "diagnostics": {"gpu": GPU_NAME, "peakVramGB": peak_gb(), "lowMemory": LOW_MEMORY}}
        status = "out of memory"
    except Exception as exc:  # one bad job should not sink the batch
        done[key(job)] = {"jobId": job["id"], "jobRev": job.get("rev"), "bundleId": job["_bundleId"], "files": [], "seeds": [],
                          "error": f"{type(exc).__name__}: {exc}"}
        status = done[key(job)]["error"]
    save_results()
    label = job.get("slot") or f"{job.get('count', 1)} image(s)"
    print(f"[{i}/{len(jobs)}] {label}: {status} ({time.time() - t0:.0f}s)")
print(f"Finished in {(time.time() - start) / 60:.1f} min")
""")

code(r"""
# 5. Pack results.zip, then download it from the Output panel (Kaggle) or the
#    file panel (Colab) and drop it on the Jobs page in Sideplate Studio.
zip_path = WORK / "results.zip"
current = {key(j) for j in jobs}
packed = [r for k, r in done.items() if k in current]  # only this run's jobs, one result each
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as z:
    z.writestr("results.json", json.dumps({"format": "sideplate-results", "version": 2,
                                           "bundleIds": [man.get("bundleId") for _, man in bundles], "results": packed}, indent=2))
    for r in packed:
        for f in r.get("files", []):
            if (WORK / f).exists():
                z.write(WORK / f, f)
ok = sum(1 for k, r in done.items() if k in current and not r.get("error"))
print(f"{zip_path}  ({zip_path.stat().st_size / 1e6:.1f} MB): {ok} jobs ok, {len(current) - ok} failed or not run")
""")

nb = {
    "cells": CELLS,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python"},
        "accelerator": "GPU",
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}
for i, c in enumerate(nb["cells"]):
    c["id"] = f"cell-{i}"
    c["source"] = c["source"].splitlines(keepends=True)

out = pathlib.Path(__file__).with_name("sideplate_worker.ipynb")
out.write_text(json.dumps(nb, indent=1) + "\n")
print(f"Wrote {out}")
