// Permanently delete one session.
//
// The only irreversible operation, so it always snapshots first. Order is the
// same as everywhere else: make it cold (that also releases the write lock),
// remove the files, then drop every copy of its identity.
//
// A running session IS allowed here (unlike move): the user asked to destroy it,
// and the confirmation dialog already says in-flight work will be interrupted.

import { runTransaction, OpError, STATUS } from '../txn.js'
import { allOf, checkLocation } from '../core/invariants.js'

const SESSION_ID = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OK = { ok: true, reason: '' }

/**
 * @param {object} runtime host ports + journal + snapshotter + clock + paths
 */
export function createDelete(runtime) {
  const { paths, clock, journal, snapshotter, logger, sessionGateway, logStore, registry, durableStores } = runtime

  return async function remove(input) {
    const sessionId = String(input.sessionId ?? '').trim()
    const source = input.source ?? 'ui'
    if (!SESSION_ID.test(sessionId)) throw new OpError('INVALID', '参数错误：会话 id 不合法')

    const stat = await logStore.stat(sessionId)
    const cacheRow = durableStores.cacheRow(sessionId)
    const workspaces = registry.list()
    const accountedIn = workspaces.filter((entry) => entry.sessionIds.includes(sessionId))

    if (stat === undefined && cacheRow === undefined && accountedIn.length === 0) {
      throw new OpError('INVALID', '会话不存在')
    }

    const oldCwd = stat === undefined ? null : stat.header.cwd
    const meta = { from: oldCwd, dir: stat === undefined ? null : stat.dir }

    const steps = [
      {
        name: 'quiesce',
        async run() {
          await sessionGateway.cancel(sessionId)
          await sessionGateway.flush(sessionId)
          sessionGateway.detach(sessionId)
        },
        async verify() {
          return sessionGateway.get(sessionId) === undefined
            ? OK
            : { ok: false, reason: '会话仍在内存中，删除后会被重新落盘' }
        },
      },
      {
        name: 'remove-dir',
        async run() {
          if (stat !== undefined) await logStore.removeDir(stat.dir)
        },
        async verify() {
          const after = await logStore.stat(sessionId)
          return after === undefined ? OK : { ok: false, reason: '会话目录仍然存在' }
        },
      },
      {
        name: 'drop-session',
        async run() {
          await durableStores.dropSession(sessionId)
        },
        async verify() {
          if (durableStores.cacheRow(sessionId) !== undefined) {
            return { ok: false, reason: '投影缓存记录仍然存在' }
          }
          const still = registry.list().filter((entry) => entry.sessionIds.includes(sessionId))
          return still.length === 0
            ? OK
            : { ok: false, reason: '项目记账仍然包含该会话：' + still.map((entry) => entry.workspaceId).join(', ') }
        },
      },
    ]

    const verify = async () => {
      if (await logStore.stat(sessionId) !== undefined) return { ok: false, reason: '会话目录仍然存在' }
      if (durableStores.cacheRow(sessionId) !== undefined) return { ok: false, reason: '投影缓存记录仍然存在' }
      const still = registry.list().filter((entry) => entry.sessionIds.includes(sessionId))
      return allOf(still.length === 0 ? OK : { ok: false, reason: '项目记账仍然包含该会话' })
    }

    /** Restored state = the session exists again, where it was, accounted where it was. */
    const verifyRestored = async () => {
      if (stat === undefined) return OK
      const after = await logStore.stat(sessionId)
      if (after === undefined) return { ok: false, reason: '恢复后仍然找不到会话目录' }
      return allOf(checkLocation(paths.sessionsRoot, after.header, after.dir))
    }

    const restore = async (snapshot) => {
      if (stat === undefined) return
      snapshotter.copyBack(snapshot.id, stat.dir)
      if (oldCwd !== null) {
        try {
          await durableStores.patchCacheCwd(sessionId, oldCwd)
        } catch { /* cache is optional */ }
        try {
          await registry.index(stat.header)
        } catch { /* index is derived */ }
      }
      for (const entry of accountedIn) {
        try {
          await registry.attach(entry.workspaceId, sessionId)
        } catch { /* best effort */ }
      }
    }

    const result = await runTransaction({
      kind: 'delete',
      sessionId,
      title: input.title,
      source,
      clock,
      journal,
      snapshotter,
      logger,
      meta,
      snapshotRequest: {
        sessionDir: stat === undefined ? null : stat.dir,
        header: stat === undefined ? null : stat.header,
        records: { cache: cacheRow, workspaces: accountedIn },
      },
      // A session with no files left (already gone) needs no snapshot.
      requiresSnapshot: stat !== undefined,
      steps,
      verify,
      verifyRestored,
      restore,
    })

    return { status: result.status, sessionId, ...meta }
  }
}
