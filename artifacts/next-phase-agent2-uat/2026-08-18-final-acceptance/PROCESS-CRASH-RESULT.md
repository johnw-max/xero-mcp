# Real process crash/restart evidence

- Evidence: `process-crash-restart.json` plus four hash-bound raw JSONL files.
- Source fingerprint: `dfdac62557b524c101ca87ef0fe6a009819917d309991e555a754b33c71587cc`; stable throughout the run.
- Independent replay: PASS; 4 raw artifacts and 4 recomputed scenarios.
- Container boundary: a random-name PostgreSQL 16 container was created by the generator and removed automatically after evidence capture.

| Crash window | PID before -> after | Provider writes after restart | Outcome |
|---|---:|---:|---|
| After preflight prepared | 73557 -> 73562 | 1 | `RECOVERED_READBACK_VERIFIED` |
| After durable write claim, before Provider | 73564 -> 73565 | 0 | `BLOCKED_SAFE_UNKNOWN` |
| After Provider accepted, before durable completion | 73589 -> 73593 | 1 | `RECOVERED_READBACK_VERIFIED` |
| After durable completion, before response | 73595 -> 73596 | 1 | `IDEMPOTENT_REPLAY` |

Every original process exited via externally issued `SIGKILL`; every restart used a distinct PID and the same PostgreSQL durable rows. This is local synthetic-Provider evidence, not a real Xero or Agent2 claim.
