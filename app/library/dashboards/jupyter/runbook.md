---
topics: [runbook]
---

# JupyterLab - runbook

A tool, not a screen: JupyterLab serving `platform/research` on :8890, on the fund venv.

| What | Where |
|---|---|
| owner | `research` |
| server | `.venv\Scripts\python.exe -m jupyterlab --port 8890 --ServerApp.root_dir=platform/research` from the fund root (install `jupyterlab` into the venv first) |
| notebooks | `platform/research` |
| kernel | `ccvenv`, the fund `.venv` (per-user kernelspec): the notebooks import `fund_db` from there |
| open | `http://127.0.0.1:8890/lab` (loopback only) |

## Health checks

| Check | Green | Red |
|---|---|---|
| `port` | :8890 listens | not started, or JupyterLab died: start it again |

## When a notebook has no kernel

The `ccvenv` kernelspec is registered per user. From the fund root:
`.venv\Scripts\python -m ipykernel install --user --name ccvenv`.
