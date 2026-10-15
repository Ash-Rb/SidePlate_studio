"""Runs the worker notebook's cells with a stand-in for the GPU.

This checks everything except the real models: finding bundles, job order,
skipping finished work, the out-of-memory fallback, and the results.zip
format the studio imports. It does NOT prove the notebook works on a GPU.

    python3 worker/mock_run.py <folder with bundle zips> <work folder> [--oom-once]
"""
import json
import os
import pathlib
import sys

here = pathlib.Path(__file__).resolve().parent
search, work = sys.argv[1], sys.argv[2]
os.environ["SIDEPLATE_SEARCH"] = search
os.environ["SIDEPLATE_WORK"] = work

nb = json.loads((here / "sideplate_worker.ipynb").read_text())
cells = ["".join(c["source"]) for c in nb["cells"] if c["cell_type"] == "code"]

FAKE_GPU = r'''
from PIL import Image
class FakeOOM(Exception):
    pass
OOM_ERRORS = (FakeOOM,)
SUPPORTED = {"sdxl-base-1.0": {}}
GPU_NAME, LOW_MEMORY, VERSIONS = "stand-in GPU", True, {"mock": "1"}
_calls = {"n": 0}
class FakePipe:
    savers = False
    def set_ip_adapter_scale(self, s):
        self.scale = s
def get_pipe(model_id, with_ip):
    return FakePipe()
def run_pipe(pipe, job, seed, width, height, ref):
    _calls["n"] += 1
    if OOM_ONCE and _calls["n"] == 1:
        raise FakeOOM()
    assert job["prompt"]
    if ref is not None:  # mirrors the real run_pipe
        pipe.set_ip_adapter_scale(float(job.get("refStrength", 0.6)))
    if job["capability"] == "image.reference_pack":
        assert ref is not None and pipe.scale == float(job.get("refStrength", 0.6))
    return Image.new("RGB", (max(8, width // 16), max(8, height // 16)), (90, 140, 200))
def enable_memory_savers(pipe):
    pipe.savers = True
def load_ref(path):
    return Image.open(path).convert("RGB")
def free_memory():
    pass
def reset_peak():
    pass
def peak_gb():
    return 0.0
'''

g = {"OOM_ONCE": "--oom-once" in sys.argv}
exec(cells[0], g)   # 1. find bundles
exec(FAKE_GPU, g)   # instead of 2. pip install and 3. real models
exec(cells[3], g)   # 4. run jobs
exec(cells[4], g)   # 5. pack results.zip
