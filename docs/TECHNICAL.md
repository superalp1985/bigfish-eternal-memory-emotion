# BigFish Eternal Memory & Emotion

Permanent conversation memories and emotional states for BigFish.
Includes `dsh-dafeiyu@0.1.23`, with DSH `0.2.1-rc.2`.

## Launch

Run `Install.cmd` once and choose the memory folder. From a source download, the
installer bootstraps missing Node, DSH and companion components in the installation
folder. Node 24.22.1 is downloaded from nodejs.org and checked against its pinned
SHA-256 digest. DSH and the companion are pinned to the versions above.
The installer restores any
included memories, registers automatic startup, and opens the conversation.
Memories, emotions, retrieval, compaction and recovery run automatically.
Default panel: `http://127.0.0.1:5196`; another available port is selected when needed.
The launcher uses an isolated
`runtime/dsh` home, not the original DSH web profile or existing conversations.
The API key is configured during installation and kept in local connection settings.
Windows DPAPI is preferred; environments without a loaded Windows profile use an
AES-GCM file with a local key. Both files are excluded from every export.
Program files, caches and temporary files stay under the installation folder.
Only the small automatic-start shortcut uses the Windows Startup folder.

## Memory contract

- Original accepted events are stored in SQLite with generation, sequence and checksum.
- The plugin owns the agents it creates, so it can release and recreate them
  through public lifecycle APIs. It does not overwrite Agent source code.
- A working generation contains the summary and a bounded recent tail.
  The same logical/native session ID is used across working generations.
- Defaults are 600 events / 64000 characters, with at most 4 loaded sessions.
  Idle LRU unloading releases other sessions. One turn can temporarily exceed
  its budget; failed compaction blocks further input until reduction succeeds.
- The canonical archive is the plugin database. Generation-local DSH sequence
  numbers are not permanent archive addresses.
- History and recall are scoped to the selected conversation. Chinese bigram
  indexing supports phrase fragments. An 8 MiB SQLite page cache and a 2 MiB
  recall cache bound those caches independently of archive size.
- The original DSH Web controller owns its own agents. This plugin does not
  silently seize or compact their internal objects; use the BigFish panel's
  managed conversation entry.
- Current transfer covers text history, raw event JSON, memories, graph records,
  FAME state and checkpoints. External file/image bytes are not bundled.
  This is a text-conversation release, not an attachment migration utility.

## Unified FAME semantics

The paper's dimensions are authoritative everywhere: participant, memory,
route and edge. `mu` satisfaction, `chi` curiosity, `epsilon` empathy,
`kappa` confidence, `nu` anxiety, `delta` conflict, `rho` fatigue,
`lambda` loss. Operational ranking/evidence/resource metrics must use
`routing_metrics`; the legacy gateway's differently defined values are not
silently interpreted as paper FAME values.

Both participants have distinct vectors, confidence, source evidence, time and
inertia settings. Missing observations stay unknown. With a remote text API,
these are explicitly labeled text proxies or manual settings, not measurements
of hidden states, gradients, full probability entropy or hardware power.
The inertia implementation integrates
`dE/dt = (1-xi)*(E_target-E)/tau` exactly for constant targets.

The graph overlay follows the FAME Gateway's scoped route/node/source-reference
structure. It is a private conversation layer queried from SQLite in pages of
at most 200 memories. The graph API returns pages; the portable package
transfers the full archive. The original gateway's public static index does not
automatically ingest this layer. Its legacy engineering vectors are explicitly
incompatible, so they are not relabeled or silently merged into paper vectors.
Paper definitions and derivation notes are in `FAME_REFERENCE.md`.

The user interface presents saved memories and emotional states. Internal
observation metadata is kept out of the companion's normal conversation.

## Backup and migration

Click **一键打包带走**. The program creates a ZIP under the selected memory folder's
`transfers` directory and reveals it in Explorer. It contains the conversation,
emotional states, program, Node, DSH and the BigFish companion, with upstream licenses.
Extract it on the destination computer and run `Install.cmd`. Installation restores
the archive and continues the same conversation automatically.

Click **更换位置** to select a new empty folder on any local drive. The current
memory and emotional states are automatically packed, verified, restored and
switched to that folder. The old data remains intact. Subsequent launches use
the new location.

Backups are compressed, not encrypted. Keep the file private or put it in your
own encrypted storage. File hashes detect corruption, not a malicious author
who rebuilds a valid archive. Imported memory is treated as data, never executed.
Never copy only a live `.sqlite` file without its WAL; use the backup button.
The standalone `.fame.gz` backup carries memories and emotional states; the ZIP
also carries runtime files. Neither includes API credentials or original host
profile data.

## Validation and limits

Run `npm test` with Node 24, and `npm run test:dsh` for local DSH integration.
Published test records are under `docs/validation/`; private local test tooling
and vaults under `work/` are excluded from Git.

The engineering goal is bounded working memory and snapshot-based recovery,
not a claim of mathematically infinite storage, zero latency, or perfect recall.
Model summaries and automatic FAME observations require additional model calls.
If model calls fail, original archived text remains available; failures must be
reported, and a failed compaction must not silently discard the old state.
Saved replies are identified separately from failed post-turn processing, so a
retry never needs to resend the conversation turn. Annotation is atomic and
idempotent using original generation/sequence references.

The independent memory manager (`node src/server.mjs`) supports storage,
search and backup, but does not answer as DSH. Use `start.ps1` for the connected
plugin.
