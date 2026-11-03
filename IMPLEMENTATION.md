# FAME memory implementation

User-approved scope: a DSH plugin with bounded active session replacement,
FAME states for both participants, route memory, recall, backup and migration.
Avoid Agent implementation changes. All data and experiments live on E:.

## Work items

- [x] Validate DSH lifecycle ownership and same-ID recreation on local 0.2.1-rc.2.
- [x] Persistent SQLite archive, scoped recall, current FAME state and bounded context.
- [x] Verified portable backup and isolated import, with visible controls.
- [x] Plugin integration, automatic memory capture and compaction lifecycle.
- [x] Real DSH integration, long-log, recovery and browser tests.
- [x] Install isolated profile and document supported paths and limitations.

## Invariants

- Raw history is immutable and never truncated by summarization.
- A working generation is bounded and distinguishable from the canonical archive.
- Runtime seq is generation-local; permanent references include generation.
- Flush and validate the successor before releasing an old working generation.
- No switch during active tools or pending input.
- Reads always constrain conversation ID; no global fallback.
- FAME state has source, confidence and algorithm version; unknown is not zero.
- All graph nodes, edges, routes and participants use the paper's SAME eight
  FAME meanings. Legacy gateway engineering meanings are not converted silently.
  Operational scores live under routing_metrics, never redefine FAME dimensions.
- Portable backups contain memory only, not API keys or machine configuration.
- Imports create a separate vault; never overwrite an existing vault.
- No claim of mathematically infinite conversations or perfect recall.
