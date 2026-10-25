# Local run identity: candidate module

`client/local/run-contract.mjs` defines the local identity for a research round.
It is not a running monitor. The CLI does not use this module yet.

An immutable envelope fixes the watch and revision, company scope, method reference, source references, comparison baselines, evaluation time, and private-context hash.
The run ID includes these inputs. The delivery ID belongs to that run, not to the shared MCP handle.
Reordered symbols and references retain the same identity. A changed method or scope creates another identity.
Retries must reuse the saved envelope and evaluation time rather than call the current clock again.

Source references use the existing research contract's event and artifact names.
Baseline references retain its owner, Pack version, output hash, and recording time.
These are declared references. A controller must check the retained bytes and referenced records before execution.
This module does not validate financial facts, source corrections, rights, or research conclusions.
An empty source set is permitted for a first-run gap record. It does not establish a sourced result.

`publicBeginArguments()` permits the public company scope only.
It does not send the private-context hash, local baselines, source references, or local run ID.
Private thesis text stays outside the envelope in caller-owned storage. A hash is not encryption.

Legacy results retain unknown method and source provenance. The import helper records their content hash without inventing a historical method or run.
The result still needs separate schema validation and human review.

Run `npm test` for contract and transport checks.
The [local ledger library](local-ledger.md) now implements storage, budget, lease, and review foundations.
The CLI does not connect those foundations to execution or notification delivery yet. A local dashboard and method promotion remain incomplete.
Passing the contract tests does not mean either research loop is complete.
