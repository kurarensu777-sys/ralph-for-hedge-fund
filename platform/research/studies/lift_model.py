"""Simple models for the probability-lifting study (B-0649): a ridge regression, a logistic regression and a small histogram gradient-boosted tree ensemble, numpy only.
They are fitted on the FIT days, a setting (ridge lambda, tree depth) is chosen on the VALIDATION days, the TEST days are read once. Features are winsorised and
standardised with the FIT days' own quantiles and moments; nothing here looks at a later day.
"""
from __future__ import annotations

import numpy as np

import updown15_model as M


# ============================================================================ preparing the matrix
class Prep:
    """Winsorise at the FIT 0.5 / 99.5 percentiles and standardise with the FIT mean and sd."""

    def __init__(self, X):
        self.lo, self.hi = np.nanpercentile(X, 0.5, axis=0), np.nanpercentile(X, 99.5, axis=0)
        Z = np.clip(X, self.lo, self.hi)
        self.mu, self.sd = Z.mean(0), Z.std(0)
        self.sd[self.sd < 1e-9] = 1.0

    def __call__(self, X):
        return ((np.clip(X, self.lo, self.hi) - self.mu) / self.sd).astype(np.float32)


def matrix(days: dict, names):
    return np.column_stack([np.concatenate([d.F[n] for d in days.values()]) for n in names]).astype(np.float32)


# ============================================================================ ridge
def fit_ridge(Z, y, w, lam):
    """Weighted ridge on standardised Z. -> beta with beta[0] the intercept (not penalised)."""
    w = w.astype(np.float64)
    A = np.column_stack([np.ones(len(Z), np.float32), Z]).astype(np.float64)
    Aw = A * w[:, None]
    G = A.T @ Aw
    P = np.eye(A.shape[1]) * lam * w.sum()
    P[0, 0] = 0.0
    return np.linalg.solve(G + P, Aw.T @ y.astype(np.float64))


def predict_ridge(beta, Z):
    return beta[0] + Z.astype(np.float64) @ beta[1:]


# ============================================================================ logistic (the study's own IRLS)
def fit_logistic(Z, y01, w, l2):
    return M.fit_logit(Z.astype(np.float64), y01, l2=l2, iters=40, w=w.astype(np.float64))


def predict_logistic(model, Z):
    return M.predict_logit(model, Z.astype(np.float64))


# ============================================================================ histogram gradient boosting, depth-limited
NB = 32


class Binner:
    """Feature bins from the FIT quantiles (at most 32 per feature), rows mapped to uint8."""

    def __init__(self, Z):
        self.edges = []
        for j in range(Z.shape[1]):
            e = np.unique(np.quantile(Z[:, j], np.linspace(0, 1, NB + 1)[1:-1]))
            self.edges.append(e)

    def __call__(self, Z):
        return np.column_stack([np.searchsorted(e, Z[:, j], side="right") for j, e in enumerate(self.edges)]).astype(np.uint8)


class Boosted:
    """Additive trees of fixed depth. Each tree is (feat[nodes], thr[nodes], leaf[2^depth]) with node n's children 2n+1 / 2n+2 (a complete binary tree)."""

    def __init__(self, depth=3, rounds=60, lr=0.1, min_leaf=3000, l2=200.0, loss="l2"):
        self.depth, self.rounds, self.lr, self.min_leaf, self.l2, self.loss = depth, rounds, lr, min_leaf, l2, loss
        self.trees = []
        self.base = 0.0

    def _grad(self, y, f, w):
        if self.loss == "l2":
            return w * (f - y), w
        p = 1.0 / (1.0 + np.exp(-f))
        return w * (p - y), w * np.maximum(p * (1 - p), 1e-6)

    def fit(self, Xb, y, w):
        n, d = Xb.shape
        w = w.astype(np.float64)
        y = y.astype(np.float64)
        if self.loss == "l2":
            self.base = float((w * y).sum() / w.sum())
        else:
            p0 = float((w * y).sum() / w.sum())
            self.base = float(np.log(p0 / (1 - p0)))
        f = np.full(n, self.base)
        for _ in range(self.rounds):
            g, h = self._grad(y, f, w)
            node = np.zeros(n, np.int32)
            feat = np.full(2 ** self.depth - 1, -1, np.int32)
            thr = np.zeros(2 ** self.depth - 1, np.int32)
            for lev in range(self.depth):
                first = 2 ** lev - 1
                nn = 2 ** lev
                G = np.zeros((nn, d, NB))
                H = np.zeros((nn, d, NB))
                loc = node - first
                for j in range(d):
                    idx = loc * NB + Xb[:, j]
                    G[:, j, :] = np.bincount(idx, weights=g, minlength=nn * NB).reshape(nn, NB)
                    H[:, j, :] = np.bincount(idx, weights=h, minlength=nn * NB).reshape(nn, NB)
                GL, HL = np.cumsum(G, axis=2), np.cumsum(H, axis=2)
                Gt, Ht = GL[:, :, -1:], HL[:, :, -1:]
                GR, HR = Gt - GL, Ht - HL
                gain = GL ** 2 / (HL + self.l2) + GR ** 2 / (HR + self.l2) - Gt ** 2 / (Ht + self.l2)
                lim = self.min_leaf * float(w.mean())            # a leaf keeps at least this much weight (min_leaf rows of mean weight)
                gain[(HL < lim) | (HR < lim)] = -np.inf
                for k in range(nn):
                    gk = gain[k].reshape(-1)
                    a = int(np.argmax(gk))
                    if not np.isfinite(gk[a]) or gk[a] <= 0:
                        feat[first + k] = -1
                        thr[first + k] = NB
                    else:
                        feat[first + k], thr[first + k] = a // NB, a % NB
                nxt = np.where(feat[node] >= 0, Xb[np.arange(n), np.maximum(feat[node], 0)] > thr[node], False)
                node = 2 * node + 1 + nxt.astype(np.int32)
            leaves = node - (2 ** self.depth - 1)
            Gl = np.bincount(leaves, weights=g, minlength=2 ** self.depth)
            Hl = np.bincount(leaves, weights=h, minlength=2 ** self.depth)
            val = -Gl / (Hl + self.l2)
            self.trees.append((feat, thr, val))
            f += self.lr * val[leaves]
        return self

    def _leaf_of(self, Xb, feat, thr):
        n = len(Xb)
        node = np.zeros(n, np.int32)
        ar = np.arange(n)
        for lev in range(self.depth):
            fj = feat[node]
            go = np.where(fj >= 0, Xb[ar, np.maximum(fj, 0)] > thr[node], False)
            node = 2 * node + 1 + go.astype(np.int32)
        return node - (2 ** self.depth - 1)

    def raw(self, Xb):
        f = np.full(len(Xb), self.base)
        for feat, thr, val in self.trees:
            f += self.lr * val[self._leaf_of(Xb, feat, thr)]
        return f

    def predict(self, Xb):
        f = self.raw(Xb)
        return f if self.loss == "l2" else 1.0 / (1.0 + np.exp(-f))

    def importance(self, d):
        imp = np.zeros(d)
        for feat, thr, val in self.trees:
            for j in feat[feat >= 0]:
                imp[j] += 1
        return imp / max(imp.sum(), 1)
