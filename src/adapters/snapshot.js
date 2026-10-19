// Snapshot adapter: the only escape hatch for a failed operation.
//
// Layout (see report/deepseek/T3_实现推演/202610191555_操作记录与快照.md):
//   <root>/<opId>/session/        the whole session directory, verbatim
//   <root>/<opId>/records.json    the two persisted copies of its identity
//   <root>/<opId>/meta.json       where it came from, where it was going
//
// Snapshots are never pruned automatically (user decision, 2026-10-19): disk use
// is only reported, so a mistake can be undone a month later.

import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './durable.js'
import { copyTree, dirSize, ensureDir, exists, isDirectory, removeDir } from './fs.js'

/**
 * @param {{root: string}} options  root directory for all snapshots
 */
export function createSnapshotter(options) {
  const root = options.root

  function pathOf(id) {
    return path.join(root, id)
  }

  async function take(request) {
    const dir = pathOf(request.opId)
    if (exists(dir)) throw new Error('snapshot directory already exists: ' + dir)
    const sessionDir = request.sessionDir
    if (typeof sessionDir !== 'string' || !isDirectory(sessionDir)) {
      throw new Error('cannot snapshot: session directory is unavailable: ' + String(sessionDir))
    }

    ensureDir(dir)
    copyTree(sessionDir, path.join(dir, 'session'))

    const records = request.records ?? {}
    await writeFileAtomic(path.join(dir, 'records.json'), JSON.stringify(records, null, 2))
    await writeFileAtomic(path.join(dir, 'meta.json'), JSON.stringify({
      opId: request.opId,
      kind: request.kind,
      sessionId: request.sessionId,
      title: request.title ?? null,
      at: request.at instanceof Date ? request.at.toISOString() : String(request.at ?? ''),
      sessionDir,
      header: request.header ?? null,
      pluginVersion: request.pluginVersion ?? null,
    }, null, 2))

    return { id: request.opId, path: dir, sessionDir }
  }

  function readRecords(id) {
    const file = path.join(pathOf(id), 'records.json')
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }

  function readMeta(id) {
    return JSON.parse(fs.readFileSync(path.join(pathOf(id), 'meta.json'), 'utf8'))
  }

  /** Put the snapshot's session tree back where it was. */
  function copyBack(id, targetDir) {
    const source = path.join(pathOf(id), 'session')
    if (!isDirectory(source)) throw new Error('snapshot is missing its session tree: ' + source)
    ensureDir(path.dirname(targetDir))
    removeDir(targetDir)
    copyTree(source, targetDir)
  }

  function size() {
    return dirSize(root)
  }

  function list() {
    try {
      return fs.readdirSync(root).sort().reverse()
    } catch {
      return []
    }
  }

  return { take, pathOf, readRecords, readMeta, copyBack, size, list }
}
