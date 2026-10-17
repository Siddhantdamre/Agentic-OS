# Performance and soak — Agentic-OS release candidate

Commit: `51cc68a0bbcfcccf80af9330d50abe7c1aee46b8` + uncommitted changes. Host: cloud sandbox, 4 vCPU, ~16 GB RAM, Postgres on the same host. Model and providers simulated (so no model latency or token cost is included).

## Soak (`HARNESS_SCRIPT=soak.js HARNESS_ARGS=8 infra/harness/run-flows.sh`)
Workload: one workspace; steady mix of signed inbound customer messages, plain questions, and held sends approved in chat; about 1.1 requests/second.
| Measure | Result |
|---|---|
| Duration | 8 minutes |
| Requests | 530 (306 inbound, 102 questions, 61 approvals, 530 replies stored) |
| 5xx / dropped connections | 0 |
| Approvals finished / stuck | 61 / 0 |
| Dashboard memory | 246 MB at start, 318 MB after warm-up, 329 MB at end (+3% after warm-up) |
| Postgres connections | 4 -> 13 and stable |
| Verdict | PASS (soak.js assertions) |

## What this does and does not show
- It shows no failures, no stuck work and no memory growth over 8 minutes at about one request per second on a simulated stack.
- It does NOT give p50/p95/p99 latency (soak.js does not record them), CPU, queue depth or a capacity number. **No users-or-agents capacity claim is supported by this run.**
- Multi-tenant fairness (one noisy workspace starving others): NOT TESTED.
- Real model/provider latency, rate limits and 429 back-off: NOT TESTED.
- 24-hour soak, clean container build under load, Temporal backlog: NOT TESTED.
- Earlier baseline (BUILD_STATE.md): 30 minutes, 1,968 requests, 0 failures, memory 310 -> 379 MB (stand-ins).
