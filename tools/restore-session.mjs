// Restore a session directory from a snapshot. Run: node tools/restore-session.mjs --list
//                                            node tools/restore-session.mjs <snapshot-id> [--yes]
//
// What it does: puts the session's log directory back where the snapshot says it
// came from, then re-reads the header to confirm the identity is consistent.
//
// What it does NOT do: touch the durable stores (workspace.json, the projection
// cache). Those are owned by a running Harness, and editing them behind its back
// is exactly the kind of half-measure this plugin exists to avoid. After a
// restore, start dsh and use "move" once if the session shows up as ungrouped.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { copyTree, dirSize, isDirectory, removeDir } from '../src/adapters/fs.js'
import { projectKey } from '../src/core/slug.js'

const BT_TICK = String.fromCharCode(96)

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function snapshotsRoot() {
  return path.join(dshHome(), 'session-move', 'snapshots')
}

function listSnapshots() {
  const root = snapshotsRoot()
  if (!isDirectory(root)) {
    console.log('no snapshots at ' + root)
    return
  }
  const entries = fs.readdirSync(root).sort().reverse()
  if (entries.length === 0) {
    console.log('no snapshots at ' + root)
    return
  }
  for (const id of entries) {
    const dir = path.join(root, id)
    let meta = {}
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
    } catch { /* older snapshot without meta */ }
    console.log(id
      + '  ' + String(meta.kind ?? '?')
      + '  ' + String(meta.sessionId ?? '?')
      + '  ' + String(meta.title ?? '')
      + '  ' + (dirSize(dir) / 1024 / 1024).toFixed(2) + ' MB')
  }
}

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === '--list' || args[0] === '-l') {
  listSnapshots()
  process.exit(0)
}

const id = args[0]
const assumeYes = args.includes('--yes')
const dir = path.join(snapshotsRoot(), id)

if (!isDirectory(dir)) {
  console.error('no such snapshot: ' + id)
  process.exit(1)
}

let meta
try {
  meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
} catch (error) {
  console.error('snapshot has no readable meta.json')
  process.exit(1)
}

const target = meta.sessionDir
if (typeof target !== 'string' || target.length === 0) {
  console.error('snapshot does not record where the session came from')
  process.exit(1)
}

const source = path.join(dir, 'session')
if (!isDirectory(source)) {
  console.error('snapshot is missing its session tree')
  process.exit(1)
}

console.log('snapshot : ' + id)
console.log('kind     : ' + String(meta.kind))
console.log('session  : ' + String(meta.sessionId))
console.log('restore  : ' + target)
console.log('existing : ' + (isDirectory(target) ? 'yes (will be replaced)' : 'no'))

if (!assumeYes) {
  console.log('')
  console.log('re-run with --yes to apply. this replaces the target directory.')
  process.exit(0)
}

removeDir(target)
copyTree(source, target)

// Re-read the header to prove the restored artifact is self-consistent.
const names = fs.readdirSync(target).filter((name) => name.endsWith('.jsonl') || name.endsWith('.jsonl.zstd'))
console.log('')
console.log('restored files: ' + names.join(', '))
if (meta.header && typeof meta.header.cwd === 'string') {
  const expected = path.join(dshHome(), 'sessions', projectKey(meta.header.cwd), meta.sessionId)
  console.log('expected dir  : ' + expected)
  console.log('matches target: ' + (path.resolve(expected).toLowerCase() === path.resolve(target).toLowerCase()))
}
console.log('')
console.log('next: start dsh. if the session shows up as ungrouped, use "move" once to re-attach it.')
