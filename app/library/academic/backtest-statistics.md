---
topics: [stats, sizing]
type: guide
---

# Backtest statistics

Six results that decide whether a backtest number means anything, and how big to bet once it does. Sources: Lo (2002), Bailey and Lopez de Prado (2012, 2014), Bailey, Borwein, Lopez de Prado and Zhu (2014, 2017), Lopez de Prado (2018), Kelly (1956), Thorp (2006). Formulas `[1]` 2026-10-04 (a second hand read each paper's equation pages and compared term by term; Lo, PSR, MinTRL, DSR, MinBTL, the PBO procedure and the Kelly forms match). Still `[U]`: the 0.5 PBO reading, the embargo 0.01T and CPCV path counts (Lopez de Prado 2018 is paywalled), Kelly (1956) itself. Symbols: SR is the Sharpe ratio per observation period (not annualized) unless stated; T is the number of observations; Phi is the standard normal CDF; g3 is the return series' skewness; g4 is its raw kurtosis (3 for a normal).

## Sharpe error and annualizing

Read when: about to annualize a Sharpe ratio, put an error bar on one, or compare two Sharpe ratios.

Source: Lo (2002), "The Statistics of Sharpe Ratios", Financial Analysts Journal. High level: a Sharpe ratio is an estimate with a standard error, and the usual square-root-of-time scaling holds only for uncorrelated returns.

```
SR      = (mean(r) - rf) / std(r)                 per period
se(SR)  = sqrt((1 + SR^2 / 2) / T)                IID normal returns
SR(q)   = eta(q) * SR
eta(q)  = q / sqrt(q + 2 * sum_{k=1..q-1} (q - k) * rho_k)
```

`q` is periods per year (365 for daily crypto, 8760 for hourly), `rho_k` the lag-k autocorrelation of returns. With `rho_k = 0`, `eta(q) = sqrt(q)`. Positive autocorrelation (smoothed, stale or marked-to-model series) makes `eta(q) < sqrt(q)`: the square-root rule overstates the annual Sharpe. A funding-carry series is autocorrelated (a rate persists across periods): measure `rho_k` first and report `eta(q)`, never `sqrt(q)` by habit. With T daily observations the error on the annualized Sharpe is about `sqrt(365 / T)`: one year of data (T = 365) gives roughly 1.0, so at two standard errors a year of data cannot tell a Sharpe of 1 from 0.

## The probabilistic Sharpe ratio

Read when: a backtest Sharpe sits against a benchmark and the question is whether it is real, or how long a track record must run.

Source: Bailey and Lopez de Prado (2012), "The Sharpe Ratio Efficient Frontier", Journal of Risk. High level: skewness and fat tails widen the Sharpe estimate's error; a high Sharpe from a short, negatively skewed series is weaker than it looks.

```
se(SR)      = sqrt((1 - g3*SR + (g4 - 1)/4 * SR^2) / (T - 1))
PSR(SR*)    = Phi((SR - SR*) / se(SR))
MinTRL      = 1 + (1 - g3*SR + (g4 - 1)/4 * SR^2) * (z_a / (SR - SR*))^2
```

`SR*` is the benchmark Sharpe per period (0 to test "better than nothing"), `z_a` the normal quantile for confidence `1 - a` (1.645 at 95%). PSR is the probability the true Sharpe exceeds `SR*`. MinTRL is the number of observations needed before the estimate clears `SR*` at that confidence. Negative skew (`g3 < 0`) and `g4 > 3` raise both the error and MinTRL, which is the carry book's shape: many small gains, rare large losses. Use PSR for ONE pre-registered strategy; a strategy picked from several needs the next chapter.

## The deflated Sharpe ratio

Read when: the Sharpe being judged is the best of several variants, parameters or runs tried on one window.

Source: Bailey and Lopez de Prado (2014), "The Deflated Sharpe Ratio", Journal of Portfolio Management. High level: the best of N tries has a high Sharpe by chance alone. Deflation raises the benchmark to the Sharpe the best of N luck-only strategies would show.

```
SR0  = sqrt(V) * ((1 - gam) * Phi^-1(1 - 1/N) + gam * Phi^-1(1 - 1/(N*e)))
DSR  = PSR(SR0)
```

`V` is the variance of the Sharpe estimates across the N trials, `N` the number of INDEPENDENT trials, `gam` the Euler-Mascheroni constant (0.5772), `e` Euler's number. `SR0` is the expected maximum Sharpe of N trials whose true Sharpe is zero. DSR is the probability the selected strategy's true Sharpe beats that. Counting `N` is the hard part: every variant tried counts, and correlated variants count as fewer independent ones (cluster them). Do not carry the fund's evidence rule over by mistake: runs that share a window, a regime or a defect are ONE result for a belief (`app/library/law/how-we-know.md#a-shared-window-is-one-result`), but for a DSR they were still tried, so `N` never drops below the variants actually run. `N` unknown means DSR cannot be computed: say so.

## Minimum backtest length

Read when: sizing how much history a search over many variants needs, or told "the backtest is two years long".

Source: Bailey, Borwein, Lopez de Prado and Zhu (2014), "Pseudo-Mathematics and Financial Charlatanism", Notices of the AMS. High level: the more variants tried, the longer the history needed before the best one means anything, and a short window with many trials will always find a good-looking strategy.

```
E[max_N SR_ann]  ~  Z_N / sqrt(Y)
Z_N              =  (1 - gam) * Phi^-1(1 - 1/N) + gam * Phi^-1(1 - 1/(N*e))
MinBTL (years)   ~  (Z_N / SR_target)^2        bound: MinBTL < 2 * ln(N) / SR_target^2
```

`Y` is years of IID data, `SR_target` an annualized Sharpe; the expected best-of-N luck-only Sharpe falls with `sqrt(Y)`. Read it backwards: with N trials and Y years, any in-sample annualized Sharpe below `Z_N / sqrt(Y)` is what luck delivers. The `ln(N)` bound says history must grow only with the log of the trial count, but it must grow. The IID assumption flatters autocorrelated series (first chapter).

## Probability of backtest overfitting

Read when: a strategy was selected from a grid or a search, and the question is how likely the winner is to lose out of sample.

Source: Bailey, Borwein, Lopez de Prado and Zhu (2017), "The Probability of Backtest Overfitting", Journal of Computational Finance. High level: reshuffle which slices of history are "in sample", and count how often the in-sample winner ranks below the median out of sample.

```
M      = T x N matrix: returns of N variants over T periods
split M by rows into S even blocks (S even, 16 is common)
for each of C(S, S/2) ways to pick S/2 blocks as IS, the rest OOS:
  n*   = variant with the best IS Sharpe
  w    = rank of n* among all N variants OOS, divided by (N + 1)
  lam  = ln(w / (1 - w))                 logit of the OOS relative rank
PBO    = share of splits with lam <= 0   (the IS winner lands at or below the OOS median)
```

PBO near 0 means the IS winner tends to stay good; the paper reads values near 1 as likely overfitting and suggests rejecting a selection above 0.05 `[1]`. A 0.5 line (the winner is no better than the median out of sample) is this book's own reading `[U]`. Also report the degradation: regress OOS Sharpe on IS Sharpe across splits, and a negative slope is the overfitting signature. CSCV needs the whole matrix of variants, not the winner alone: a search that kept only the best run's returns cannot produce PBO.

## Purged cross-validation and embargo

Read when: cross-validating a model whose labels look forward (a return over the next h bars), or splitting a time series for any fit-then-test.

Source: Lopez de Prado (2018), "Advances in Financial Machine Learning", chapters 7 and 12. High level: a label that spans time leaks across a train/test boundary, and plain k-fold then reports a score the live model cannot reach.

```
sample i has label interval [t0_i, t1_i]
purge:    drop from TRAIN every i whose [t0_i, t1_i] overlaps a TEST interval
embargo:  also drop the h observations right after each test block, h ~ 0.01 * T
CPCV:     N groups, k test groups per split
          splits  = C(N, k)
          paths   = C(N - 1, k - 1)   each a full-history out-of-sample path
```

The embargo covers serial dependence the purge misses (features built on rolling windows). CPCV yields a distribution of out-of-sample Sharpe ratios, one per path, instead of the single number of one walk-forward: report the spread. Shuffled k-fold on overlapping labels is the failure this guards against; where the label is the next bar only, the purge is empty and the embargo is the whole fix.

## Kelly sizing and its error

Read when: sizing a position, or a leverage, from an estimated edge.

Sources: Kelly (1956), "A New Interpretation of Information Rate", Bell System Technical Journal; Thorp (2006), "The Kelly Criterion in Blackjack, Sports Betting and the Stock Market". High level: Kelly maximizes long-run log growth; it is aggressive, and with an estimated edge it overbets.

```
binary bet, win prob p, q = 1 - p, net odds b:   f* = p - q / b
continuous, excess return mu, variance s^2:       f* = mu / s^2
log growth at fraction f:                         g(f) = r + f*mu - f^2 * s^2 / 2
at the optimum:                                   g(f*) = r + mu^2 / (2 * s^2) = r + SR^2 / 2
```

`f` is the fraction of capital (leverage in the continuous case), `r` the risk-free rate, `SR = mu / s`. Growth is symmetric around `f*` and falls to the risk-free rate at `2 f*` and below it beyond (excess growth turns negative there; growth itself goes negative only at a larger fraction): betting double Kelly buys the variance of a bet twice the size for no excess growth. `mu` is estimated with error `s / sqrt(T)`, and overestimating the edge costs more than underestimating it, so size at a fraction of the estimate (half Kelly keeps 75% of the excess growth `g(f*) - r` at a quarter of the variance). Size from the DEFLATED edge of the chapters above, never from the raw backtest. A venue cap (margin, liquidation distance) binds before Kelly does: take the lower of the two sizes.
