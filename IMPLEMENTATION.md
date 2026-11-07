# BigFish for DeepSeek Harness：实现边界

本文描述完整 BigFish 应用及其 DSH 插件内核。WorkBuddy 是在同一套记忆
原则和核心模块之上的独立应用入口，详见
[docs/WORKBUDDY.md](docs/WORKBUDDY.md)。

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
- [x] Preserve original image, audio, video and file bytes with message references.
- [x] Stream media through backup, storage moves and portable recovery.
- [x] Align the project-private runtime to DSH 0.2.2-alpha.3.

## Invariants

- Raw history is immutable and never truncated by summarization.
- Referenced media is immutable, content-addressed and never removed automatically.
- A working generation is bounded and distinguishable from the canonical archive.
- Runtime seq is generation-local; permanent references include generation.
- Flush and validate the successor before releasing an old working generation.
- No switch during active tools or pending input.
- Reads always constrain conversation ID; no global fallback.
- FAME state has source, confidence and algorithm version; unknown is not zero.
- All graph nodes, edges, routes and participants use the paper's SAME eight
  FAME meanings. Legacy gateway engineering meanings are not converted silently.
  Operational scores live under routing_metrics, never redefine FAME dimensions.
- Portable backups contain memory and all referenced media, not API keys or machine configuration.
- Imports create a separate vault; never overwrite an existing vault.
- No claim of mathematically infinite conversations or perfect recall.
