# [LIVE] research/ - notebooks only

Jupyter notebooks that orchestrate + visualize. **No logic lives here** - every
fetcher/engine/metric they use comes from `fundplat.data` / `fundplat.quant` (the repo is an
editable install, so notebooks import `fundplat.*` directly). This folder is
`platform/research` (the `fund-research` repo until 2026-09-25, folded in with its history); the
logic lives one folder up in `fundplat/`, installed editable into the fund `.venv`. Open with the
`ccvenv` kernel, which IS the fund `.venv` (`fund/.venv/Scripts/python.exe`), from JupyterLab
(`platform/dashboards/jupyter`, :8890).

```
research/
└── studies/          # strategy notebooks, in THE STUDY STRUCTURE (S0-S7)
    ├── _template-study.ipynb                                        # every new study starts here
    ├── 2026-09-27-xasset-sofr-hike-tail-put-bill.ipynb              # research-001: the base trade, the owner's short SR3 puts
    └── 2026-09-27-xasset-sofr-hike-tail-hedge-polymarket.ipynb      # research-003: do Polymarket Fed contracts hedge it
```

Everything else was removed on 2026-10-03 at the owner's word (the SK Hynix studies, `-put-sofr`,
the vol studies, the three original engine notebooks, the ten `venue_tests/`); each is in git
history (`git log --diff-filter=D --name-only -- research` from `platform`).

New studies are date-prefixed `YYYY-MM-DD-<market>-<subject>[-<variant>].ipynb` (the naming law).

CLI equivalents (no notebook needed):

```
..\.venv\Scripts\python -m fundplat.data --once                                    # funding dislocation snapshot
..\.venv\Scripts\python -m fundplat.quant.crypto.backtest.carry.cnc --days 30 90 180 --leverage 5
..\.venv\Scripts\python -m fundplat.quant.core.slippage --symbol BTCUSDT
```
