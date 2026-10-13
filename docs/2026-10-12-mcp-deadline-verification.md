# MCP request deadline verification

Date: October 12, 2026. Status: local repair verified. No push or deployment occurred.
The public submission candidate contains this client repair without the internal loop modules.

## Failure and repair

The old client used the fetch transport's abort behavior as its body deadline.
Forced GC and an open SSE body reproduced a stalled request after the 100 ms deadline.
A retained abort signal did not fix the stall. The request returned only after the diagnostic closed its server.

The client now retains a timer and abort controller until each request completes.
Header and body waits race that signal. Cancellation cannot delay a result or error.
Late responses start cleanup without another request. Invalid late responses cannot create unhandled cleanup failures.
Session close uses the same bounded header wait. Unsupported content types cancel their body before rejection.

Six initial regressions failed before the repair: five cancelled at their 500 ms test limits and one failed deadline validation.
Independent QC then found two cleanup defects: invalid late responses and an unsupported content type with an open body.
Both defects received corrections and regression tests. The final new file contains nine tests.

## Final commands and results

| Checkout | Runtime | Command | Result |
|---|---|---|---|
| Internal local candidate | Node 22.13.0 | `node --test tests/*.test.mjs` | 544 passed, 0 failed, 0 cancelled, 0 skipped. 5925.596875 ms. |
| Internal local candidate | Node 24.19.0 | same | 544 passed, 0 failed, 0 cancelled, 0 skipped. 5006.627083 ms. |
| Internal local candidate | Node 25.2.1 | same | 544 passed, 0 failed, 0 cancelled, 0 skipped. 7406.559875 ms. |
| Public submission candidate | Node 22.13.0 | same | 39 passed, 0 failed, 0 cancelled, 0 skipped. 732.903958 ms. |
| Public submission candidate | Node 24.19.0 | same | 39 passed, 0 failed, 0 cancelled, 0 skipped. 873.847292 ms. |
| Public submission candidate | Node 25.2.1 | same | 39 passed, 0 failed, 0 cancelled, 0 skipped. 316.030125 ms. |
| Independent QC | Node 25.2.1 | `node --test --test-timeout=15000 tests/client.test.mjs tests/mcp-deadline.test.mjs` | 37 passed. 326.054958 ms. |

QC's five extra assertion groups found zero retained application timers, abort listeners, or unhandled rejections.
Its weak and strong GC diagnostic runs rejected at 103 and 102 ms.
Concurrent-suite diagnostic timings were 160 and 260 ms. Event-loop load affects observed time.
The timer cannot interrupt synchronous code that blocks the event loop. Transport cleanup remains best effort.

The public base contained 30 tests. The repair adds nine. No new pre-repair full-suite success is claimed.
The internal full count includes previously saved method-assessment WIP tests. Passing tests do not approve a method or establish research quality.
The buyer bridge, hosted server, native AI connectors, UI rendering, and production deployment are outside these client suite runs.

## Two manual retained-data checks

An ignored local diagnostic opened the retained research database read-only.
It checked the retained source bytes against their hash and sent only aggregate status through an owned loopback SSE server.
This is controlled transport with real retained data, not a live hosted source or native AI test.

First successful output:

```json
{"ok":true,"counts":{"watches":1,"source_events":1,"runs":0,"deliveries":0,"requests":0},"gates":["SOURCE_RIGHTS_HOLD"],"artifacts_verified":1,"verification":"retained-local-data-controlled-transport","calls":1,"elapsed_ms":22,"model_calls":0,"payment_calls":0,"investment_orders":0}
```

Second successful output:

```json
{"ok":true,"counts":{"watches":1,"source_events":1,"runs":0,"deliveries":0,"requests":0},"gates":["SOURCE_RIGHTS_HOLD"],"artifacts_verified":1,"verification":"retained-local-data-controlled-transport","calls":1,"elapsed_ms":21,"model_calls":0,"payment_calls":0,"investment_orders":0}
```

Two initial diagnostic attempts failed because the diagnostic omitted the MCP `structuredContent` wrapper.
The client rejected that invalid tool response. The diagnostic was corrected without changing the client acceptance contract.
The source HOLD, accepted history, and zero AI/payment/order counts did not change.

This repair does not complete automatic monitoring, method evaluation, native caller setup, or the full product's 9/10 acceptance.
