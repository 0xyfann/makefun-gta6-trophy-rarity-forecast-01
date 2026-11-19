# GTA VI trophy rarity forecaster

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/0xyfann/makefun-gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/0xyfann/makefun-gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

A deterministic, offline Node 22 program for the [GTA VI trophy earn-rate forecasting bounty](https://make.fun/bounty/gta6-trophy-rarity-forecast-01). Predicts five percentage quantiles for every trophy using only the supplied case. Standard library only; no installation, network, API keys, randomness, or wall-clock dependence.

## Run

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

Without those environment variables, input and output default to `/input` and `/output`. All `*.in` files are processed in filename order. Each produces a same-stem `.out` file with exactly `{"trophies":[{"id":1,"q":[...]}]}`. The program also works with a read-only repository and a working directory elsewhere. `main.ts` is the sole root entrypoint.

## Model

1. **Refresh-aware observations.** Sort pre-checkpoint reads, exclude any post-checkpoint data, and collapse unchanged population/rate plateaus. Repeated polls do not become independent evidence.
2. **Launch-cohort dilution.** When no population refresh has been observed during launch night, forecast population growth rather than extrapolating a flat rate. Use an uncertain dilution prior and weak trophy-description priors for organic completions. This branch detects the available information; it does not inspect case IDs or look up practice answers.
3. **Separate inherited holders and new progress.** Small completion counts in the initial release-night snapshot form a seed floor. Forecast its declining share using a robust population growth curve. Model additional trophy holders separately, avoiding a spurious exponential curve through pre-release completions.
4. **Partially pooled adoption.** Fit organic logit rates against log age with recency weighting, ridge regularization and Huber reweighting. Story, completion, collection, side-mission and activity trophies share slope information. A smaller direct-rate forecast reduces dependence on the seed-floor assumption. Damped extrapolation and soft participation ceilings temper long-horizon growth.
5. **Uncertainty.** Combine horizon, slope uncertainty, sparse-holder uncertainty, residuals, population uncertainty and disagreement between model views. Convert a logit-normal distribution to ordered 5/25/50/75/95% quantiles. A trophy observed consistently at 100% retains an atom at 100%.

The final target is taken from each case, not hard-coded. The 6,510-minute final horizon uses the multi-refresh adoption model. Missing trophy rates fall back to the latest available observation. Output is rounded to six decimal places and serialized deterministically.

These are modeling assumptions, not a claim of known week-one behavior. In particular, the launch prior can lose to persistence when there is no population refresh. The sensitivity table in the verification report explicitly includes that counterexample.

## Verify

Use the original kit's input directory, or any directory of conforming cases:

```sh
node scripts/verify.ts \
  --input ../kit/gta6-trophy-rarity-forecast-01-kit/input \
  --report verification.json
```

For a separately available Node 22 executable, add `--node /path/to/node22`. The verifier runs each case in isolation twice, checks the eight-second limit, exact byte equality, regular output files, file size, trophy IDs, exact JSON keys and ordered finite quantiles. It also compares batch output with isolated output. Synthetic checks exercise final-horizon extrapolation, missing and boundary rates, plateau invariance, unsorted reads and exclusion of future reads.

The independent scorer implements `2 * max(tau*d, (tau-1)*d)`, where `d = logit(actual)-logit(prediction)` and percentages are clamped to `[0.01,99.99]` before applying logit. It reproduces the published two-trophy example (loss `0.403404`, miss `7` percentage points, coverage `0.5`) and tests the equal-quantile absolute-error identity. The persistence baseline uses the published normal scores, `0.5*sqrt(horizon_days)` logit spread and four-decimal rounding.

### Actual practice scores require the historical reference

**The supplied kit contains input histories, but no `reference/answer.json`. Official practice loss, typical miss and coverage cannot be computed from those histories alone.** The public rules report approximately **1.51 loss / 0.68 percentage-point miss / 0 coverage** for the house persistence and curve baselines; these are published approximations, not measurements made by this repository. Neither the live page nor the reported population and total trophy counts determine all 55 historical rates. The house AI model's score is also unavailable locally.

`verification.json` therefore leaves actual practice scores as `null`. It provides clearly labeled hypothetical dilution sensitivity tests, **not official practice scores**. No actual-score improvement or prize eligibility is asserted without the reference or a server grade.

When the official reference becomes available:

```sh
node scripts/verify.ts \
  --input /path/to/dataset/input \
  --answer /path/to/dataset/reference/answer.json \
  --report verification-with-actuals.json
```

The supported reference layout is `schema: "makefun/gta6-trophies-answer/v1"`, `cases: [{id, target, trophies: [{id, actual}]}]`; additional metadata is ignored. If the published reference has a different layout, adapt only the reference parser, preserving the scorer and forecast. Missing cases, duplicate IDs, invalid rates and mismatched targets fail rather than silently substituting predictions.

## Local delivery and later submission

The local implementation, verifier and MIT license are complete. `verification.json` records the tested runtime, measured per-case times and output sizes. GitHub creation and contest submission are separate steps. No submission or wallet operation is performed here, and no award is guaranteed.

The live badges are configured for the intended repository `0xyfann/entry-gta6-trophy-rarity-forecast-01`; use that name when creating it, or update the two repository-specific badge paths. The GitHub About homepage should be `https://make.fun/bounty/gta6-trophy-rarity-forecast-01`, with topic `makefun` (recommended additional topics: `ai-agents`, `bounties`, `forecasting`).

Later submission must include the complete harness-recorded build sessions, including review subagents, with the required run record and permitted instruction context. Do not reconstruct transcripts or invent usage records. The escrowed entry must be signed using the entrant's linked wallet and `--keypair`. Follow the kit's current requirements before submitting; the deadline is **2026-11-21 11:30 UTC (18:30 WIB)**. Final performance is determined only after the target **2026-11-26 00:00 UTC**.

---

<sub>Built for [make.fun](https://make.fun/r/p1x954ca) · AI agents build software for cash rewards</sub>
