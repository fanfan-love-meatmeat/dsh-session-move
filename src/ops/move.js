// Move one session to another workspace.
//
// The plan (report/deepseek/T3_实现推演/202610191610_移动的六步.md):
//   判定 -> 快照 -> 变冷 -> 改名 -> 改 header -> 对齐索引 -> 挂回项目 -> 修缓存
//
// This module declares steps; it performs no I/O of its own.

import { runTransaction, OpError, STATUS } from '../txn.js'
import { allOf, checkAccounting, checkCacheIdentity, checkLocation, expectedSessionDir, samePath } from '../core/invariants.js'

const SESSION_ID = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OK = { ok: true, reason: '' }

function invalid(message) {
  return new OpError('INVALID', message)
}

/**
 * @param {object} runtime host ports + journal + snapshotter + clock + paths
 */
export function createMove(runtime) {
  const { paths, clock, journal, snapshotter, logger, sessionGateway, logStore, registry, durableStores } = runtime

  /** Invariants that must hold BEFORE the move (and again after a rollback). */
  function verifyOriginal(sessionId, oldWorkspace) {
    return async () => {
      const after = await logStore.stat(sessionId)
      if (after === undefined) return { ok: false, reason: '会话日志不存在' }
      const checks = [checkLocation(paths.sessionsRoot, after.header, after.dir)]
      if (oldWorkspace) checks.push(checkAccounting(registry.list(), sessionId, oldWorkspace.workspaceId))
      checks.push(checkCacheIdentity(durableStores.cacheRow(sessionId), after.header))
      return allOf(...checks)
    }
  }

  return async function move(input) {
    const sessionId = String(input.sessionId ?? '').trim()
    const targetWorkspaceId = String(input.targetWorkspaceId ?? '').trim()
    const source = input.source ?? 'ui'
    if (!SESSION_ID.test(sessionId)) throw invalid('参数错误：会话 id 不合法')
    if (targetWorkspaceId.length === 0) throw invalid('参数错误：目标项目为空')

    const workspaces = registry.list()
    const target = workspaces.find((entry) => entry.workspaceId === targetWorkspaceId)
    if (target === undefined) throw invalid('目标项目不存在')
    if (typeof target.path !== 'string' || target.path.length === 0) throw invalid('目标项目没有登记路径')
    if (target.reachable === false) throw invalid('目标目录不可达：' + target.path)

    const stat = await logStore.stat(sessionId)
    if (stat === undefined) throw invalid('会话不存在')
    const header = stat.header
    if (typeof header.cwd !== 'string' || header.cwd.length === 0) throw invalid('该会话没有工作目录，无法移动')

    const oldCwd = header.cwd
    const oldWorkspace = workspaces.find((entry) => typeof entry.path === 'string' && samePath(entry.path, oldCwd)) ?? null
    const accountedBefore = workspaces.filter((entry) => entry.sessionIds.includes(sessionId))
    const baseMeta = { from: oldCwd, to: target.path, oldWorkspaceId: oldWorkspace?.workspaceId ?? null, newWorkspaceId: target.workspaceId }

    // --- already there ------------------------------------------------------
    if (samePath(oldCwd, target.path)) {
      const accountedHere = target.sessionIds.includes(sessionId)
      const accountedElsewhere = workspaces.some(
        (entry) => entry.workspaceId !== target.workspaceId && entry.sessionIds.includes(sessionId),
      )
      if (accountedHere && !accountedElsewhere) {
        return { status: STATUS.NO_CHANGE, sessionId, ...baseMeta }
      }
      // Accounting is missing: repair it without touching files.
      const snapshotRequest = { sessionDir: stat.dir, header, records: { cache: durableStores.cacheRow(sessionId) } }
      const result = await runTransaction({
        kind: 'move',
        sessionId,
        title: input.title,
        source,
        clock,
        journal,
        snapshotter,
        logger,
        snapshotRequest,
        meta: { ...baseMeta, repairOnly: true },
        steps: [{
          name: 'reattach',
          async run() {
            for (const entry of registry.list()) {
              if (entry.workspaceId === target.workspaceId) continue
              if (!entry.sessionIds.includes(sessionId)) continue
              await registry.detach(entry.workspaceId, sessionId)
            }
            await registry.attach(target.workspaceId, sessionId)
          },
          async verify() {
            return checkAccounting(registry.list(), sessionId, target.workspaceId)
          },
        }],
        verify: async () => checkAccounting(registry.list(), sessionId, target.workspaceId),
        verifyRestored: verifyOriginal(sessionId, oldWorkspace),
        restore: async () => {
          if (oldWorkspace) await registry.attach(oldWorkspace.workspaceId, sessionId)
          await registry.detach(target.workspaceId, sessionId)
        },
      })
      return { status: result.status, sessionId, ...baseMeta, repaired: true }
    }

    // --- the real move ------------------------------------------------------
    const patchedHeader = { ...header, cwd: target.path }
    const newDir = expectedSessionDir(paths.sessionsRoot, patchedHeader)

    const steps = [
      {
        name: 'quiesce',
        async run() {
          await sessionGateway.flush(sessionId)
          sessionGateway.detach(sessionId)
        },
        async verify() {
          return sessionGateway.get(sessionId) === undefined
            ? OK
            : { ok: false, reason: '会话仍在内存中，写锁没有释放' }
        },
      },
      {
        name: 'rename-dir',
        async run() {
          await logStore.renameDir(stat.dir, newDir)
        },
        async verify() {
          const after = await logStore.stat(sessionId)
          return after !== undefined && samePath(after.dir, newDir)
            ? OK
            : { ok: false, reason: '会话目录没有落到目标位置' }
        },
      },
      {
        name: 'patch-header',
        async run() {
          await logStore.patchCwd(newDir, target.path)
        },
        async verify() {
          const after = await logStore.stat(sessionId)
          return after !== undefined && after.header.cwd === target.path
            ? OK
            : { ok: false, reason: '日志首帧的工作目录没有更新' }
        },
      },
      {
        name: 'reindex',
        async run() {
          await registry.index(patchedHeader)
        },
      },
      {
        name: 'reattach',
        async run() {
          for (const entry of registry.list()) {
            if (entry.workspaceId === target.workspaceId) continue
            if (!entry.sessionIds.includes(sessionId)) continue
            await registry.detach(entry.workspaceId, sessionId)
          }
          await registry.attach(target.workspaceId, sessionId)
        },
        async verify() {
          return checkAccounting(registry.list(), sessionId, target.workspaceId)
        },
      },
      {
        name: 'cache',
        async run() {
          await durableStores.patchCacheCwd(sessionId, target.path)
        },
        async verify() {
          return checkCacheIdentity(durableStores.cacheRow(sessionId), patchedHeader)
        },
      },
    ]

    const verify = async () => {
      const after = await logStore.stat(sessionId)
      if (after === undefined) return { ok: false, reason: '会话日志不见了' }
      return allOf(
        checkLocation(paths.sessionsRoot, after.header, after.dir),
        checkAccounting(registry.list(), sessionId, target.workspaceId),
        checkCacheIdentity(durableStores.cacheRow(sessionId), after.header),
      )
    }

    // Fixed sequence, never a per-step inverse: clear the new location, put the
    // snapshot back, restore the copies, then re-align the index.
    const restore = async (snapshot) => {
      try {
        await logStore.removeDir(newDir)
      } catch { /* the new location may never have been created */ }
      snapshotter.copyBack(snapshot.id, stat.dir)
      try {
        await durableStores.patchCacheCwd(sessionId, oldCwd)
      } catch { /* cache is optional */ }
      try {
        await registry.index({ ...header, cwd: oldCwd })
      } catch { /* index is derived */ }
      for (const entry of accountedBefore) {
        try {
          await registry.attach(entry.workspaceId, sessionId)
        } catch { /* best effort */ }
      }
      if (!accountedBefore.some((entry) => entry.workspaceId === target.workspaceId)) {
        try {
          await registry.detach(target.workspaceId, sessionId)
        } catch { /* not attached yet */ }
      }
    }

    const result = await runTransaction({
      kind: 'move',
      sessionId,
      title: input.title,
      source,
      clock,
      journal,
      snapshotter,
      logger,
      meta: baseMeta,
      snapshotRequest: {
        sessionDir: stat.dir,
        header,
        records: { cache: durableStores.cacheRow(sessionId), workspaces: accountedBefore },
      },
      steps,
      verify,
      verifyRestored: verifyOriginal(sessionId, oldWorkspace),
      restore,
    })

    return { status: result.status, sessionId, ...baseMeta, dir: newDir }
  }
}
