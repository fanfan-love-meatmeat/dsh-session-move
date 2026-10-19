// Move + delete against fake ports: no host, no real filesystem.
// Run: node tools/test-move.mjs

import assert from 'node:assert'
import path from 'node:path'
import { projectKey } from '../src/core/slug.js'
import { STATUS } from '../src/txn.js'
import { createMove } from '../src/ops/move.js'
import { createDelete } from '../src/ops/delete.js'

const ROOT = path.join('C:', 'fake', 'sessions')
const ID = '0a42141c-aaaa-bbbb-cccc-111122223333'
const A = 'D:\\proj\\a'
const B = 'D:\\proj\\b'

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed++
  } catch (error) {
    failures.push(name + ' :: ' + (error && error.message ? error.message : String(error)))
  }
}

function dirFor(id, cwd) {
  return path.join(ROOT, projectKey(cwd), id)
}

/** A complete set of fake ports over an in-memory session tree. */
function makeRuntime(options) {
  const faults = (options && options.faults) || {}
  const state = {
    sessions: new Map(),
    cache: new Map(),
    workspaces: [
      { workspaceId: 'ws-a', path: A, title: 'A', sessionIds: [ID], reachable: true },
      { workspaceId: 'ws-b', path: B, title: 'B', sessionIds: [], reachable: true },
    ],
    live: new Set([ID]),
    snapshots: new Map(),
    snapshotCalls: 0,
  }

  const header = {
    type: 'session',
    version: 4,
    id: ID,
    createdAt: 1792379781409,
    cwd: A,
    isSeeded: false,
    delegationDepth: 1,
  }

  state.sessions.set(dirFor(ID, A), { dir: dirFor(ID, A), header: { ...header } })
  state.cache.set(ID, { identity: { createdAt: header.createdAt, cwd: A, isSeeded: false }, rows: {} })

  const workspaceById = (id) => state.workspaces.find((entry) => entry.workspaceId === id)

  const sessionGateway = {
    get: (id) => (state.live.has(id) ? { id } : undefined),
    async flush() { return state.live.has(ID) },
    detach(id) { return state.live.delete(id) },
    async cancel() { return true },
    async resume() { return { dispose() {} } },
  }

  const logStore = {
    async stat(id) {
      for (const entry of state.sessions.values()) {
        if (path.basename(entry.dir) === id) return { ...entry, header: entry.header, slug: path.basename(path.dirname(entry.dir)) }
      }
      return undefined
    },
    generations() { return [{ name: 'session.v4.jsonl.zstd', version: 4 }] },
    async patchCwd(dir, cwd) {
      if (faults.patchCwd === 'throw') throw new Error('patch failed')
      const entry = state.sessions.get(dir)
      if (entry === undefined) throw new Error('no such dir ' + dir)
      entry.header = { ...entry.header, cwd }
      return [{ name: 'session.v4.jsonl.zstd', bytes: 1 }]
    },
    async renameDir(from, to) {
      if (faults.renameDir === 'throw') throw new Error('rename failed')
      const entry = state.sessions.get(from)
      if (entry === undefined) throw new Error('no such dir ' + from)
      state.sessions.delete(from)
      entry.dir = to
      state.sessions.set(to, entry)
    },
    async removeDir(dir) {
      if (faults.removeDir === 'throw') throw new Error('remove failed')
      state.sessions.delete(dir)
    },
  }

  const registry = {
    list: () => state.workspaces.map((entry) => ({ ...entry, sessionIds: [...entry.sessionIds] })),
    async index(next) {
      for (const entry of state.sessions.values()) {
        if (entry.header.id === next.id) entry.header = { ...next }
      }
    },
    async attach(workspaceId, id) {
      const workspace = workspaceById(workspaceId)
      if (workspace === undefined) throw new Error('unknown workspace ' + workspaceId)
      if (!workspace.sessionIds.includes(id)) workspace.sessionIds = [id, ...workspace.sessionIds]
    },
    async detach(workspaceId, id) {
      const workspace = workspaceById(workspaceId)
      if (workspace === undefined) return
      workspace.sessionIds = workspace.sessionIds.filter((entry) => entry !== id)
    },
  }

  const durableStores = {
    cacheRow: (id) => state.cache.get(id),
    async patchCacheCwd(id, cwd) {
      const record = state.cache.get(id)
      if (record === undefined) return false
      record.identity = { ...record.identity, cwd }
      return true
    },
    async dropSession(id) {
      if (faults.dropSession === 'throw') throw new Error('drop failed')
      state.cache.delete(id)
      for (const workspace of state.workspaces) {
        workspace.sessionIds = workspace.sessionIds.filter((entry) => entry !== id)
      }
    },
  }

  const snapshotter = {
    async take(request) {
      state.snapshotCalls++
      const id = request.opId
      const entry = request.sessionDir === null ? undefined : state.sessions.get(request.sessionDir)
      state.snapshots.set(id, {
        dir: request.sessionDir,
        header: entry === undefined ? undefined : { ...entry.header },
        records: JSON.parse(JSON.stringify(request.records ?? {})),
      })
      return { id, path: '/snap/' + id }
    },
    copyBack(id, targetDir) {
      const snap = state.snapshots.get(id)
      if (snap === undefined || snap.header === undefined) return
      state.sessions.delete(targetDir)
      state.sessions.set(targetDir, { dir: targetDir, header: { ...snap.header } })
    },
    size: () => 0,
  }

  const journalEntries = []
  const journal = { async append(entry) { journalEntries.push(entry) } }
  const clock = { now: () => new Date('2026-10-19T17:00:00Z') }

  const runtime = {
    paths: { sessionsRoot: ROOT },
    clock, journal, snapshotter, logger: undefined,
    sessionGateway, logStore, registry, durableStores,
  }

  return { runtime, state, journalEntries, faults, header }
}

// ---------------------------------------------------------------- move

await check('move: happy path moves dir, header, index, accounting, cache', async () => {
  const env = makeRuntime()
  const move = createMove(env.runtime)
  const result = await move({ sessionId: ID, targetWorkspaceId: 'ws-b', title: 'demo' })

  assert.strictEqual(result.status, STATUS.COMMITTED)
  assert.strictEqual(env.state.sessions.has(dirFor(ID, A)), false)
  assert.strictEqual(env.state.sessions.has(dirFor(ID, B)), true)
  const entry = env.state.sessions.get(dirFor(ID, B))
  assert.strictEqual(entry.header.cwd, B)
  assert.deepStrictEqual(env.state.workspaces[0].sessionIds, [])
  assert.deepStrictEqual(env.state.workspaces[1].sessionIds, [ID])
  assert.strictEqual(env.state.cache.get(ID).identity.cwd, B)
  assert.strictEqual(env.state.live.has(ID), false)

  const statuses = env.journalEntries.map((e) => e.status)
  assert.deepStrictEqual(statuses, [STATUS.IN_PROGRESS, STATUS.COMMITTED])
  assert.strictEqual(env.journalEntries[0].kind, 'move')
  assert.strictEqual(env.journalEntries[0].from, A)
  assert.strictEqual(env.journalEntries[0].to, B)
})

await check('move: already there and accounted is a no-op (no snapshot, nothing written)', async () => {
  const env = makeRuntime()
  // the session already lives at B, is accounted there, and nothing else claims it
  env.state.sessions.delete(dirFor(ID, A))
  env.state.sessions.set(dirFor(ID, B), { dir: dirFor(ID, B), header: { ...env.header, cwd: B } })
  env.state.cache.set(ID, { identity: { createdAt: env.header.createdAt, cwd: B, isSeeded: false }, rows: {} })
  env.state.workspaces[0].sessionIds = []
  env.state.workspaces[1].sessionIds = [ID]

  const move = createMove(env.runtime)
  const result = await move({ sessionId: ID, targetWorkspaceId: 'ws-b' })
  assert.strictEqual(result.status, STATUS.NO_CHANGE)
  assert.strictEqual(env.state.snapshotCalls, 0)
  assert.strictEqual(env.state.sessions.get(dirFor(ID, B)).header.cwd, B)
})

await check('move: accounting missing is repaired without touching files', async () => {
  const env = makeRuntime()
  env.state.sessions.delete(dirFor(ID, A))
  env.state.sessions.set(dirFor(ID, B), { dir: dirFor(ID, B), header: { ...env.header, cwd: B } })
  env.state.live.delete(ID)
  env.state.cache.set(ID, { identity: { createdAt: env.header.createdAt, cwd: B, isSeeded: false }, rows: {} })
  const move = createMove(env.runtime)
  const result = await move({ sessionId: ID, targetWorkspaceId: 'ws-b' })
  assert.strictEqual(result.status, STATUS.COMMITTED)
  assert.deepStrictEqual(env.state.workspaces[1].sessionIds, [ID])
  assert.strictEqual(env.journalEntries[0].repairOnly, true)
})

await check('move: target with no path is rejected before any write', async () => {
  const env = makeRuntime()
  env.state.workspaces[1].reachable = false
  const move = createMove(env.runtime)
  await assert.rejects(
    () => move({ sessionId: ID, targetWorkspaceId: 'ws-b' }),
    (error) => error.code === 'INVALID' && error.message.includes('不可达'),
  )
  assert.strictEqual(env.state.snapshotCalls, 0)
})

await check('move: unknown session is rejected', async () => {
  const env = makeRuntime()
  env.state.sessions.clear()
  const move = createMove(env.runtime)
  await assert.rejects(
    () => move({ sessionId: '0a42141c-bbbb-cccc-dddd-111122223333', targetWorkspaceId: 'ws-b' }),
    (error) => error.code === 'INVALID',
  )
})

await check('move: failure at patch-header rolls everything back', async () => {
  const env = makeRuntime({
    faults: { patchCwd: 'throw' },
  })
  const move = createMove(env.runtime)
  await assert.rejects(
    () => move({ sessionId: ID, targetWorkspaceId: 'ws-b' }),
    (error) => error.code === 'ROLLED_BACK',
  )
  // dir is back under A, with the original header
  const entry = env.state.sessions.get(dirFor(ID, A))
  assert.ok(entry !== undefined, 'session directory must be back under A')
  assert.strictEqual(entry.header.cwd, A)
  assert.strictEqual(env.state.sessions.has(dirFor(ID, B)), false)
  // accounting and cache restored
  assert.deepStrictEqual(env.state.workspaces[0].sessionIds, [ID])
  assert.deepStrictEqual(env.state.workspaces[1].sessionIds, [])
  assert.strictEqual(env.state.cache.get(ID).identity.cwd, A)
  // journal records the rollback
  const last = env.journalEntries[env.journalEntries.length - 1]
  assert.strictEqual(last.status, STATUS.ROLLED_BACK)
  assert.strictEqual(last.failedStep, 'patch-header')
})

// -------------------------------------------------------------- delete

await check('delete: removes dir, cache and accounting', async () => {
  const env = makeRuntime()
  const remove = createDelete(env.runtime)
  const result = await remove({ sessionId: ID })
  assert.strictEqual(result.status, STATUS.COMMITTED)
  assert.strictEqual(env.state.sessions.size, 0)
  assert.strictEqual(env.state.cache.has(ID), false)
  assert.deepStrictEqual(env.state.workspaces[0].sessionIds, [])
  assert.deepStrictEqual(env.journalEntries.map((e) => e.status), [STATUS.IN_PROGRESS, STATUS.COMMITTED])
})

await check('delete: failure while dropping accounting restores the directory', async () => {
  const env = makeRuntime({ faults: { dropSession: 'throw' } })
  const remove = createDelete(env.runtime)
  await assert.rejects(
    () => remove({ sessionId: ID }),
    (error) => error.code === 'ROLLED_BACK',
  )
  assert.ok(env.state.sessions.has(dirFor(ID, A)), 'directory must be restored')
  assert.strictEqual(env.state.sessions.get(dirFor(ID, A)).header.cwd, A)
  assert.ok(env.state.cache.has(ID), 'cache row must be restored')
})

await check('delete: unknown session is rejected', async () => {
  const env = makeRuntime()
  env.state.sessions.clear()
  env.state.cache.clear()
  env.state.workspaces[0].sessionIds = []
  const remove = createDelete(env.runtime)
  await assert.rejects(
    () => remove({ sessionId: ID }),
    (error) => error.code === 'INVALID',
  )
})

if (failures.length > 0) {
  console.log('FAILED ' + failures.length + ' / ' + (passed + failures.length))
  for (const line of failures) console.log('  x ' + line)
  process.exit(1)
}
console.log('ops: ' + passed + ' passed, 0 failed')
