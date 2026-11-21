---
id: submodule-server-artifacts
type: submodule-design
status: active
title: artifacts — the workspace's agent artifacts and their kept copies
parent: module-server
depends-on: [module-contracts, submodule-server-persistence, submodule-server-trash, submodule-server-fs, submodule-server-git]
references: [submodule-server-watch, submodule-server-turns, submodule-server-host]
tags: [artifacts, persistence, public-surface-checked]
---

## Responsibility

The host-owned index behind the Artifacts tool: what an agent left in a workspace, who wrote it, and a
kept copy of each file so nothing in the artifacts folder disappears unless the user removes it. An
**artifact** is a regular file under the worktree's `.raildesign/context/` (`WORKSPACE_CONTEXT_DIR`), except
the seeded `.gitignore` and the TODO state under `todos/`. An **ignored output** is a gitignored file or
folder elsewhere in a git worktree that appeared or changed while an agent ran. The index is host state,
not a web derivation: only the host sees every run (attended or not), can keep copies, and serves every
client the same answer.

## Boundary

- **Owns:** `<dataDir>/artifacts/<workspaceId>/` — `index.json` (artifact records + ignored-output records)
  and `kept/<uuid>` — plus the in-memory per-workspace running set, run starts, last replies, explicit
  writers and run window.
- **Public surface (barrel):** `listArtifacts`, `reconcileArtifacts`, `restoreArtifact`, `discardArtifact`,
  `withUserRemoval`, `prepareArtifactsDestination`, `observeArtifactSessionEvent`, `ArtifactSessionEvent`,
  `noteArtifactPathsChanged`, `setArtifactsPublisher`, `removeWorkspaceArtifacts`.
- **Allowed deps:** `persistence` (`dataDir`, workspace records), `fs` (contained restore paths), `git` (`gitAsync` for the ignored-root
  listing), `trash` (a discarded kept copy goes to the OS trash), `log`; `contracts`, `shared/paths`,
  `shared/artifactsDir`, `shared/codedError`; Node `fs`/`path`/`crypto`.
- **Forbidden:** `host`, `agent`, `watch`, SDK runtime. `host` feeds it session events and change nudges and
  publishes its nudges; it never watches files itself.

## Kept copies

A kept copy is a **hard link** to the live file, so it costs no disk while the file lives and holds the
current content. SDK `apply_patch` atomically replaces files; the next reconcile relinks the kept copy to the new inode. Where linking fails
(the worktree is on another filesystem than the data dir — a Default workspace on a second disk) the copy
is a real copy, refreshed on change, and it costs disk even while the file lives — so real copies are
bounded: a file over 100 MB is not copied, nor one that would take the workspace's real copies (live and
deleted together) past 1 GB. A file left without a copy is still listed but not protected, and when it
vanishes its row goes with it. Hard links have no such bound: they cost nothing until a file is deleted,
and a deleted artifact keeps its copy until the user removes it. Kept copies live in the data dir rather than the worktree so an
agent's `git clean -fdx` or `rm -rf .raildesign` cannot take them along; the price is that a deleted
artifact is restored before it can be opened.

## Reconcile

`reconcile` walks the artifacts folder (at most 5 000 entries) and diffs it against the index. The walk
never follows a link: `.raildesign` and `context` must be real directories — a folder replaced by a link is
not walked and marks nothing deleted, while a missing one means everything in it is gone — and no entry
inside is followed. It skips dependency and cache folders (the same set ignored outputs drop, so a mockup
app's `node_modules` neither floods the list nor exhausts the bound) and build-output folders (`dist`,
`build`, `out`, `.next`, `target`, `coverage`): an agent-built mockup inside the artifacts folder rebuilds
hashed assets on every run, and each old hash would otherwise stay forever as a "deleted" row with a kept
copy. Unlike ignored outputs elsewhere, which do list `dist/`, a build inside the artifacts folder is
scaffolding, not something the agent produced for the user. It also skips the `fs` delete claims
(`DELETE_CLAIM_PREFIX`), which are the user's own trash in flight, not a rename. A worktree root that is
not there (an unmounted drive, a moved project folder) is an incomplete scan, so its rows stay live until it
returns. A new path gains a record
and a link; a changed size/mtime updates the record (and its writer when known); an inode change relinks;
a missing record whose file now sits at a new path is a **rename** (the row moves, keeping its first-seen
time and chat); any other missing record becomes `deleted` while its kept copy exists — unless the
removal is the user's. Rename by inode alone is trusted only while a hard-linked kept copy holds the
inode; a record kept as a copy (or not kept) must also match size and mtime, because a freed inode is
reused at once on ext4 and XFS, and a different file taking it would otherwise inherit the row and
discard the kept copy. A walk cut short by the bound never marks anything deleted. The host triggers it from file-change nudges under the folder, from every
agent run start, tool end and settle, and from `artifacts.list`; each change publishes one pathless
nudge per workspace.

**User removals** go through `withUserRemoval(workspaceId, path, mutation)`: the path (or folder) is
marked for the mutation's lifetime and reconciled right after it succeeds, so the host's own Delete,
Cut and Rename never read as "deleted not by you", while a failed mutation leaves no mark. The mark is
the entry's real location — its parent folder resolved, the leaf itself not followed — so a removal made
through a link to the artifacts folder (`artifacts-alias/report.md`) is still the user's, while removing
such a link is no removal of artifacts at all. A user deletion made outside RailDesign (a terminal `rm`)
cannot be told from an agent's and shows as deleted; the user discards it once.

**Pasting into the folder.** `prepareArtifactsDestination(workspaceId, directory)` reseeds the artifacts
folder (`seedArtifactsDir`, its `.gitignore` included) when a copy or move targets it or a folder inside
it, so Paste into artifacts works before the first chat created the folder — a Default workspace is seeded
only at session start — or after someone cleaned it. In a Default workspace this writes into the user's
repository, which is acceptable because the user asked for that paste.

**Restore** first reseeds the artifacts folder through `shared`'s `seedArtifactsDir` (after a
`git clean -fdx` the folder is gone, and recreating it without its `.gitignore` would let `git add -A` stage
the restored draft), then links the kept copy back, refusing a path that exists again (`ENTRY_EXISTS`) or
one whose nearest existing parent resolves outside the worktree. It copies instead when the kept copy is a copy,
or when its inode is still linked elsewhere — the agent moved the file into the project, and a link back
would make editing the artifact edit that project file — and then keeps the restored file afresh. The
restored file's stat is applied before the next reconcile, so a restore is never read as a change and
never moves the row to whichever chat is running. **Discard** stages a hard link (or exclusive copy) under its original file
name and sends that to the OS trash, retaining the original until the index commit succeeds, so the trash shows a recognizable name; it
drops the row only if its deletion identity (path, kept name and changedAt) is unchanged, since the agent may have written the path again
meanwhile.

## Attribution

A record's chat is the session that last created or changed it. `apply_patch` and `spec_create`
name their target in `tool_execution_start` args (the workspace-relative `path` field), so
their writer is exact even with concurrent chats. Such a hint lives only for its own tool call: the
reconcile at that call's `tool_execution_end` reads it and then drops it, so a call that failed without
writing never names the writer of a file another chat creates later.
Any other change (a shell command, a tool writing on its own) is attributed only while exactly one
session of the workspace is running; otherwise the record keeps the chat it had. Like [[submodule-server-turns]]
this is not exclusive attribution, and a session that never settles (a host crash) stays "running" until
restart.

**Round markers.** Each record keeps the chat rounds that created or changed it (`rounds`: `{ sessionId,
startedAt }`, oldest first, each distinct round once, at most 16 — chats taking turns on one file must not
push an earlier round out). A round starts at the session's first `agent_start` and again at every message
pi delivers inside the run that opens a round in the chat (`round_start` for `opensChatRound` in
contracts — a prompt, a review fix, a continuation request, a handoff, a waking completion — stamped with
the message's own timestamp: a follow-up queued or steered into a running agent is a new round in the
chat, though pi runs it in the same `agent_start`…`agent_settled` window); it ends at the next one or at `agent_settled` (pi re-emits
`agent_start` on retries; the first one counts). At a round boundary the index reconciles first, so changes
so far stay with the round that made them, and reads that round's reply (see Roles). A marker is written
only when the change is attributed to a running session — by a writer hint or as the only one running — and
seen after the run started: the reconcile at `agent_start` runs before the run is registered, so a change
waiting from before the run (an edit the watcher had not reported yet) gets none, and neither do a restore
or a move. A user's own edit made *while* exactly one session runs is indistinguishable from the agent's
and does get that round's marker. The chat divider's "N artifacts" joins these markers with its
round, which is why they live here and not in the turn receipts: those come from git, and the
artifacts folder is ignored.

## Roles

Every listed artifact carries a **role**, `result` or `working`, and the **reason** for it, computed when
the list is served (`roles.ts`, never stored, so a rule change needs no migration). One host answer
serves the Smart view, the chat divider and any other consumer.

1. **Signals first.** `picked` — the person chose it among a tool's previews. `shown` — a successful tool
   call put it in front of them: the host maps the declarations extensions make through
   `artifactTools` ([[submodule-server-extensions]]) into the `presented` / `picked` paths of a
   `tool_execution_end` event. `linked` — the round's last assistant message names it, read when the next
round starts or the run settles (a message without
text, a tool-call-only turn or a stop, clears the earlier one) (a markdown link,
   a code span or a bare path; worktree-relative, artifacts-relative or absolute; only paths that are
   live records count); the host passes each assistant message as `assistant_message` and the index
   reads the last one at settle. Signals are stored on the record, survive a move and a re-created
   path, and are recorded from now on — older artifacts have none (no backfill).
2. **Path rules** for the rest, from the agent sessions of 16 real worktrees (2 877 files: these rules
   marked 2 409 as working with 5 ever shown): a `_*` or dot folder or a helper folder name (`tools`,
   `scripts`, `bin`, `build`, `data`, `extract`, `check`, `raw`, `src`, `js`, `css`, `fonts`, `images`,
   `frames`, `previews`, `comments`, `batch_*`, `notes*`) → `working-folder`; a script extension →
   `script`; a data extension or none → `data`; `.md`/`.html`/`.pdf`/`.svg` → a `document` result (it may
   be a subagent's brief — the price of not missing notes the agent only named as a folder); anything
   else never shown (images, mostly check renders) → `unshown`.

No model classifies: on the data above the deterministic answer was good enough, and a model step would
add cost and latency.

## Ignored outputs

The watcher never watches ignored folders on Linux (see [[submodule-server-watch]]), so outputs are found
by snapshot. The first `agent_start` in a workspace opens a run window and lists the ignored roots with
`git ls-files --others --ignored --exclude-standard --directory` — git collapses an ignored folder into one
entry without descending, so a folder is one row. Roots under a dependency or cache folder
(`node_modules`, `.venv`, `__pycache__`, `.turbo`, `.cache`, …) and `.raildesign` are dropped. When the last
running session settles, a root that is new since the window opened, or holds anything modified since
(with one second of slack: file times can lag the clock by a tick, and the baseline listing runs while the
agent may already be writing), is recorded together with its file count (bounded at 20 000 entries).
Rows are live, never copied.

**Listing never walks an output.** Every walk here is asynchronous and runs only at settle or after a
change, because `artifacts.list` follows most tool ends and a recorded `target/` or `.next/` walked on each
listing stalled the host's one event loop — the SDK runs on it too. The listing reads the cached counts and
`lstat`s each root once, dropping a root that no longer exists. A change that reaches a recorded root
(`noteArtifactPathsChanged`, fed by the host's file-change publisher — the user's own Delete, Cut, Paste or
Rename land there, while the Linux watcher reports nothing inside ignored folders) recounts that root or
drops it, then nudges the clients; a removed workspace's pending recount is abandoned. A count can
therefore lag a build the user runs in a terminal until the next settle or touching change. A chat without
a project has no git, so its snapshot reports `outputs: null`.

## Lifetime

The store follows its workspace: `host` calls `removeWorkspaceArtifacts` when a workspace or chat is
removed, alongside its other per-workspace state — after the workspace or chat record is gone, so a listing
racing the removal cannot rebuild the store — and the worktree's own teardown is not awaited. An async step
(a discard's trash move, an output walk) that outlives the removal writes nothing back. The index
is validated on load; only a missing index starts empty. Read, JSON or unsupported-version errors in an existing index fail closed without caching an empty state or overwriting the index. Malformed individual rows in a valid index are omitted. Removing store
entries is best-effort: a kept copy another process holds open (Windows refuses to unlink a hard-linked
file Excel or a scanner has open) is logged and left behind, never allowed to abort a reconcile, a user's
Delete that already succeeded, or the workspace's teardown.

## RailDesign ownership and durability

Only normalized context-relative regular-file paths are indexable; traversal, reserved .git case variants and symlink escapes are rejected even for persisted records. Public operations require a live workspace in an open project/chat. Closing a project keeps its store but denies access; removal invalidates pending work and deletes the store.

The index uses a sibling temporary file, fsync, preserved existing mode (0600 for new files), and atomic rename. Candidate kept copies are committed with the index before prior copies are removed; failed persistence retains the prior index and kept bytes and reports failure. Deletion changedAt values advance monotonically across new deletion generations, including restore and discard/recreate.

Canonical application events come from the current SDK publisher. Writer hints recognize apply_patch.path and spec_create.path only, and child results are attributed to their openable parent chat. SDK application records, RunState and checkpoint context are unchanged. Kept copies follow atomic replacement and represent the latest bytes, not version history. This commit offers explicit Restore; opening a deleted row does not automatically restore it.

The same canonical SDK events identify current round markers and which indexed files the assistant linked,
showed or the user picked. Attribution is bounded to sixteen rounds per file. Child producers capture
their openable parent's admitted round when they start, and stale child results do not select a later
parent round. Metadata changes commit through the same atomic artifact index.
