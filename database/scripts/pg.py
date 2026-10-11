"""The portable PostgreSQL controller, runnable before fund_db is installed:

    python database/scripts/pg.py ensure|install|init|start|stop|status [--json]

It only puts database/py on sys.path and hands over to fund_db.cluster (standard library only).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))

from fund_db.cluster import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
