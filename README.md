English ｜ [中文](./README.zh.md)

# dsh-session-move

Session management for the **DeepSeek Harness (dsh)** Web UI: **move a session to another workspace**,
**delete one permanently**, and **AI-rename a session's title**. All three also ship as agent tools,
sharing a single implementation with the UI, and every change is a snapshot-backed transaction with an
operation journal.

> 中文说明见 [README.zh.md](./README.zh.md)。

---

## What it does

| Feature | Where | Result |
|:--|:--|:--|
| **Move a session** | Session row “⋯” → Move to folder… | The session keeps working in the target directory; history moves with it; a failure is rolled back |
| **Delete a session** | Session row “⋯” → Delete session | Stop → snapshot → remove the log directory, workspace accounting and projection-cache row |
| **AI-rename the title** | Session row “⋯” → AI rename | Reads what you said in the session and rewrites its existing title |

Agent-side equivalents: `workbench_session_move` / `workbench_session_delete` / `workbench_session_rename_ai`.

## Usage

**Move** — click “⋯” on a session row → “Move to folder…” → pick one target → “Move”.
The target must be an **already registered workspace**; the dialog shows where the session lives now.
Afterwards the session keeps working in the target directory, and it opens and resumes normally.

**Delete** — “⋯” → “Delete session” → tick the acknowledgement → “Delete”.
A snapshot is taken **before** anything is removed, so a mistake is recoverable (see below).

**AI rename** — “⋯” → “AI rename”; the title updates a few seconds later.
It only reads **what you said** (not assistant replies or tool output) and uses the session's own model
to **rewrite the title**. A cold session is woken just for this and is released again if the rename fails.
Rename again if you dislike the result — the previous title is kept in the operation journal.

## The three agent tools

| Tool | Arguments | Purpose |
|:--|:--|:--|
| `workbench_session_move` | `sessionId`, `workspaceId` | Move a session to another workspace |
| `workbench_session_delete` | `sessionId` | Permanently delete (snapshots first) |
| `workbench_session_rename_ai` | `sessionId` | Rewrite the session title with AI |

Workspace ids come from `GET /__sessionmove/info`. Tools and UI share one operation implementation;
a failure is **thrown**, never returned as prose, so the model cannot read a failure as success.

## Data and recovery

One change = one transaction:

```
decide (may refuse; a refusal never touches disk)
  → quiesce (stop, flush, leave the in-memory registries, release the write lock)
  → snapshot (the whole session directory + the two persisted records)
  → steps (rename dir → patch header → realign index → re-attach → fix cache)
  → verify four invariants → commit | on failure restore from the snapshot and verify again
```

The four invariants: the log directory equals the one its own header `cwd` implies; the session is
accounted only under the target workspace; the projection-cache identity matches the header; the first
frame is exactly one JSON line. A failed check rolls back; an incomplete rollback is reported as
**partial** together with the snapshot path — it is never disguised as a plain failure.

| Artifact | Location |
|:--|:--|
| Operation journal (two lines per operation: in-progress / result) | `~/.dsh/session-move/journal.jsonl` |
| Snapshots (never pruned automatically) | `~/.dsh/session-move/snapshots/<operation id>/` |

```powershell
node tools/restore-session.mjs --list             # list snapshots
node tools/restore-session.mjs <op-id> --yes      # restore (replaces the target directory)
```

A restore only puts the **session directory** back; accounting and cache are repaired by the plugin's own
“re-attach only” path, so the Harness's durable state is never edited behind its back.
After restoring: restart, then use “Move to folder…” and pick the original workspace — `cwd` already
matches, so it takes the re-attach branch.

## Install

**Do not use `link:`.** The plugin is plain ESM and imports `@deepseek-ai/dsh-tools` directly; with `link:`
Node resolves through the symlink's real path, whose ancestors do not contain `@deepseek-ai`, and the whole
bundle fails with `ERR_MODULE_NOT_FOUND` at load time.

```powershell
npm pack
dsh plugin --profile web add file:<repo path>\dsh-session-move-0.3.7+dsh.0.2.1-rc.2.tgz
# restart dsh web — plugins are loaded at startup
```

Re-run `npm pack` + reinstall + restart after code changes. Back up `~/.dsh/sessions` and
`~/.dsh/storages` before installing.

## Verify

```powershell
npm test                          # pure core / transaction / operations / snapshots — 50 checks, no dsh needed
node tools/check-layers.mjs       # dependency directions (21 files, 0 violations)
node tools/check-dsh-contract.mjs # 15 contract assertions against the installed dsh
node tools/check-session-dir.mjs <session dir>   # read-only diagnosis of one real session
```

`check-dsh-contract` is what keeps this plugin alive across Harness upgrades: it imports the installed
packages and asserts that `defineTool` / `BlockAssembler` / `deadline` / `indexHeader` /
`detachEntered` / `session_projcache` / `projectKey` still exist, and that the web bundle still
exports `MenuItemButton`.

## Version scheme

```
version     = 0.3.7+dsh.0.2.1-rc.2
              ^^^^^             this plugin's own semantic version
                   ^^^^^^^^^^^^ the dsh version it was verified against
engines.dsh = ^0.2.1-rc.2       the machine gate: a dsh outside it skips the whole bundle
```

Everything after `+` is build metadata: semver ignores it for ordering and range matching, so it is
purely informational. It changes only when the target dsh version changes.

## Known limits

1. **Coverage is uneven end to end**: frame rewriting, transaction rollback and snapshot restore are
   covered by tests (including byte-for-byte restore on a real directory); UI rendering and the model call
   behind AI rename have only been verified by hand.
2. **No drag and drop**: cross-folder dragging needs DOM listeners on another plugin's rows and has no
   official extension point, so only the menu path is kept.
3. **Snapshots are never pruned**: disk usage only grows; clean `~/.dsh/session-move/snapshots/` manually.
4. **Only `^0.2.1-rc.2`**: a 0.x bump is blocked by the gate — re-check every item in
   `tools/check-dsh-contract.mjs` at that point.

## Upstream

This plugin is a rewrite of **dsh-session-move v0.1.5**, created by
**[reinocheong](https://github.com/reinocheong)** and released under MIT. The central insight is his:
a session belongs to the workspace whose path equals the `cwd` stored in its header, and that `cwd`
is what determines where the log directory lives. The three features, the tool names and the title-prompt
trade-offs are inherited from his work too.

The original repository is no longer reachable, so this rewrite is based on the v0.1.5 copy installed locally.

## License

MIT — see [LICENSE](./LICENSE). Its first line is the upstream copyright line; the provenance note follows it.
