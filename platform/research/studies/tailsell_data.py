"""tailsell_data - reads the frozen study inputs (one gzip pickle built from the Polymarket census and price histories, hashed)."""
import gzip
import hashlib
import pickle
from pathlib import Path

INPUT_DIR = Path.home() / "fund-data" / "research" / "predmkts-tail-sell"


def load_inputs(name="inputs-20261004"):
    """-> (mk, hist, census, digest). mk[id] = {y, event, tags, grp, vol, neg, q, end_s, start_s, ev_n, head}; hist[id] = array of (t seconds, p of the first outcome)."""
    path, want = INPUT_DIR / f"{name}.pkl.gz", (INPUT_DIR / f"{name}.sha256").read_text().strip()
    got = hashlib.sha256(path.read_bytes()).hexdigest()
    assert got == want, f"{path.name}: the file's hash {got[:12]} is not the recorded {want[:12]}"
    with gzip.open(path, "rb") as f:
        d = pickle.load(f)
    return d["mk"], d["hist"], d["census"], got
