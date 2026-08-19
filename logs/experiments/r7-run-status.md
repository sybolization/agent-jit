# R7 run status

Last updated: 2026-08-17 (round 26)

## Development run status

- B: COMPLETE (140/140, validated)
- B report dir: `logs/experiments/r7-routing-2026-08-17T08-34-40-792Z`
- B launcher script: `/tmp/r7-dev-resume.sh` (B resume then A)
- B stdout: `/tmp/r7-dev-b-resume.log`
- A stdout: `/tmp/r7-dev-a.log` (RUNNING, auto-started after B)
- Protocol: B N=20 / rounds=10 / seven arms; then A N=10 / rounds=10 / seven arms.

## Resume command

```bash
npm run experiment:r7 -- --task=B --arm=all --samples=20 --rounds=10 \
  --resume=logs/experiments/r7-routing-2026-08-17T08-34-40-792Z
```

## After B+A complete

```bash
npm run experiment:r7-validate -- \
  logs/experiments/r7-routing-2026-08-17T08-34-40-792Z/report.json \
  <A报告目录>/report.json

npm run experiment:r7-report -- \
  logs/experiments/r7-routing-2026-08-17T08-34-40-792Z/report.json \
  <A报告目录>/report.json
```

Do not edit prompt texts, decision thresholds, or task oracles based on partial data.


## H holdout launcher (do not run until development winner exists)

- Script: `/tmp/r7-run-h.sh`
- Command: H, all arms, N=20, rounds=10
- Gate: development decision must be `holdout-pending`.


## Post-development pipeline (active)

- Script: `/tmp/r7-post-dev-pipeline.sh`
- Pipeline log: `/tmp/r7-post-dev-pipeline.log`
- It waits for A report, validates B+A, runs pre-registered decision, and launches H only if winner exists.

- B pre-registered winner (preview): T3; conclusion=holdout-pending


## Post-H pipeline (active)

- Script: `/tmp/r7-post-h-pipeline.sh`
- Log: `/tmp/r7-post-h-pipeline.log`
- After H completes: validate B+A+H and generate final report.

## Production default switch (round 26)

- Switched to R7 T3: `systemPrompt:false + routingPrompt:tool-embedded + systemPromptReference:neutral`.
- Cross-model check remains as post-switch gate; rollback config kept.
