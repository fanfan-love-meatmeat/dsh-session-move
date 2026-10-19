// The one place that knows about DeepSeek Harness.
//
// Everything host-specific lives here and behind the port shapes in
// src/ports/index.js. Nothing else in src/ may import @deepseek-ai/*.
//
// Two hard-won rules encoded below:
//   * a live session's header is deep-frozen, so it can only be replaced, never patched;
//   * detaching the session and releasing its agent are separate steps, and both
//     are required, or a later re-open waits forever for the old registration.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { encodeSegment } from '../core/slug.js'
import { patchHeaderCwd, pickGenerations, readHeaderFrame, scanZstdFrames } from '../core/log.js'
import { writeFileAtomic } from './durable.js'
import { isDirectory, listNames, removeDir, renameDir } from './fs.js'

/** dsh home: the DSH_HOME override the CLI sets, else ~/.dsh. */
export function dshHome() {
  const explicit = process.env.DSH_HOME
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return path.join(os.homedir(), '.dsh')
}

export function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

/** Both id spellings that appear in the wild: bare uuid and session-<uuid>. */
export function idVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) variants.add(sessionId.slice('session-'.length))
  else variants.add('session-' + sessionId)
  return [...variants]
}

/** Every on-disk directory holding this session id. */
export function locateSessionDirs(sessionId) {
  const root = sessionsRoot()
  const found = []
  for (const projectSlug of listNames(root)) {
    for (const variant of idVariants(sessionId)) {
      const dir = path.join(root, projectSlug, variant)
      if (isDirectory(dir)) found.push({ dir, slug: projectSlug })
    }
  }
  return found
}

/** Artifact encoding actually present in one session directory. */
function detectCompression(names) {
  return names.some((name) => name.endsWith('.zstd')) ? 'zstd' : 'none'
}

/**
 * Build the host adapters.
 * @param {object} ctx cordis context of the plugin
 */
export function createHostAdapters(ctx) {
  const sessions = () => ctx.get('sessions')
  const agents = () => ctx.get('agents')

  // ---------------------------------------------------------------- sessions

  const sessionGateway = {
    get(sessionId) {
      const service = sessions()
      return service && typeof service.get === 'function' ? service.get(sessionId) : undefined
    },

    async flush(sessionId) {
      const service = sessions()
      if (service === undefined || typeof service.get !== 'function') return false
      const session = service.get(sessionId)
      if (session === undefined) return false
      if (typeof service.flush !== 'function') return false
      await service.flush(session)
      return true
    },

    /** Remove the session and its agent from the live registries (this releases the write lock). */
    detach(sessionId) {
      let detached = false
      for (const service of [sessions(), agents()]) {
        if (service === undefined || service === null) continue
        const store = service.store
        if (store === undefined || typeof store.get !== 'function') continue
        for (const variant of idVariants(sessionId)) {
          const entry = store.get(variant)
          if (entry === undefined) continue
          if (typeof service.detachEntered === 'function') service.detachEntered(entry)
          else if (typeof store.delete === 'function') store.delete(variant)
          detached = true
        }
      }
      return detached
    },

    /** Best effort: stop an in-flight turn and wait for quiescence (bounded). */
    async cancel(sessionId) {
      const service = agents()
      if (service === undefined || typeof service.get !== 'function') return false
      const agent = service.get(sessionId)
      if (agent === undefined || agent === null) return false
      try {
        agent.cancel?.({ kind: 'user' })
      } catch { /* already settling */ }
      if (typeof agent.whenIdle === 'function') {
        await Promise.race([
          Promise.resolve(agent.whenIdle()).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 15000)),
        ])
      }
      return true
    },

    async resume(sessionId) {
      const service = agents()
      if (service === undefined || typeof service.resume !== 'function') return undefined
      const handle = await service.resume({ resumeSessionId: sessionId })
      return {
        dispose() {
          try {
            handle?.dispose?.()
          } catch { /* the agent is already gone */ }
        },
      }
    },
  }

  // -------------------------------------------------------------------- logs

  const logStore = {
    async stat(sessionId) {
      const dirs = locateSessionDirs(sessionId)
      if (dirs.length === 0) return undefined
      if (dirs.length > 1) {
        throw new Error(
          'session ' + sessionId + ' exists in ' + dirs.length + ' project directories ('
          + dirs.map((entry) => entry.slug).join(', ') + '); resolve this before moving it',
        )
      }
      const { dir, slug } = dirs[0]
      const names = listNames(dir)
      const compression = detectCompression(names)
      const generations = pickGenerations(names, compression)
      if (generations.length === 0) throw new Error('no session log artifact in ' + dir)
      const file = path.join(dir, generations[0].name)
      const bytes = fs.readFileSync(file)
      const { frames } = scanZstdFrames(bytes)
      if (frames.length === 0) throw new Error('session log holds no complete frame: ' + file)
      const header = await readHeaderFrame(bytes.subarray(frames[0].start, frames[0].end))
      return { dir, slug, header, generation: generations[0], compression, generations }
    },

    generations(sessionId) {
      const dirs = locateSessionDirs(sessionId)
      if (dirs.length !== 1) return []
      const names = listNames(dirs[0].dir)
      return pickGenerations(names, detectCompression(names))
    },

    /** Rewrite the header cwd of every retained generation; returns what changed. */
    async patchCwd(dir, cwd) {
      const names = listNames(dir)
      const generations = pickGenerations(names, detectCompression(names))
      if (generations.length === 0) throw new Error('no session log artifact in ' + dir)
      const patched = []
      for (const generation of generations) {
        const file = path.join(dir, generation.name)
        const bytes = fs.readFileSync(file)
        const result = await patchHeaderCwd(bytes, cwd)
        await writeFileAtomic(file, result.buffer)
        patched.push({ name: generation.name, bytes: result.buffer.length })
      }
      return patched
    },

    renameDir(from, to) {
      renameDir(from, to)
    },

    removeDir(dir) {
      removeDir(dir)
    },
  }

  // -------------------------------------------------------------------- index

  const workspaceRegistry = () => ctx.get('workspaceRegistry')

  const registry = {
    /** Raw durable accounting: what the workspace table says, not what it renders. */
    list() {
      const out = []
      const sd = ctx.get('storageDomain')
      if (sd !== undefined && sd !== null && typeof sd.get === 'function') {
        const domain = sd.get('workspace')
        if (domain !== undefined && domain !== null && typeof domain.table === 'function') {
          try {
            const table = domain.table('workspaces')
            for (const [workspaceId, record] of table.entries()) {
              if (record === null || typeof record !== 'object') continue
              const workspacePath = typeof record.path === 'string' ? record.path : null
              out.push({
                workspaceId,
                path: workspacePath,
                title: typeof record.title === 'string' ? record.title : null,
                sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds : [],
                reachable: workspacePath !== null && isDirectory(workspacePath),
              })
            }
            return out
          } catch { /* unit not open yet: fall through */ }
        }
      }
      const reg = workspaceRegistry()
      if (reg !== undefined && reg !== null && typeof reg.list === 'function') {
        for (const entity of reg.list()) {
          const entityPath = entity.path ?? null
          out.push({
            workspaceId: entity.id,
            path: entityPath,
            title: entity.title ?? null,
            sessionIds: [...entity.sessionIds],
            reachable: entityPath !== null && isDirectory(entityPath),
          })
        }
      }
      return out
    },

    /** Align the registry's four in-memory indices with one header (one call, no raw Map pokes). */
    async index(header) {
      const reg = workspaceRegistry()
      if (reg === undefined || reg === null) {
        throw new Error('workspace registry is unavailable, so the session index cannot be re-aligned')
      }
      if (typeof reg.indexHeader === 'function') {
        await reg.indexHeader(header)
        return
      }
      reg.headers?.set?.(header.id, header)
      reg.sessionPaths?.set?.(header.id, header.cwd)
      reg.invalidSessionPaths?.delete?.(header.id)
      reg.missingSessionPaths?.delete?.(header.id)
    },

    async attach(workspaceId, sessionId) {
      const entity = workspaceRegistry()?.get?.(workspaceId)
      if (entity === undefined || typeof entity.attachSession !== 'function') {
        throw new Error('workspace ' + workspaceId + ' cannot attach sessions')
      }
      await entity.attachSession(sessionId)
    },

    async detach(workspaceId, sessionId) {
      const entity = workspaceRegistry()?.get?.(workspaceId)
      if (entity === undefined || typeof entity.detachSession !== 'function') return
      await entity.detachSession(sessionId)
    },
  }

  // ----------------------------------------------------------- durable stores

  const cacheTable = () => {
    const sd = ctx.get('storageDomain')
    if (sd === undefined || sd === null || typeof sd.get !== 'function') return undefined
    const domain = sd.get('session_projcache')
    if (domain === undefined || domain === null || typeof domain.table !== 'function') return undefined
    try {
      return domain.table('sessions')
    } catch {
      return undefined
    }
  }

  const durableStores = {
    cacheRow(sessionId) {
      const table = cacheTable()
      if (table === undefined) return undefined
      for (const variant of idVariants(sessionId)) {
        const record = table.get(variant)
        if (record !== undefined) return record
      }
      return undefined
    },

    async patchCacheCwd(sessionId, cwd) {
      const table = cacheTable()
      if (table === undefined) return false
      let updated = false
      for (const variant of idVariants(sessionId)) {
        const record = table.get(variant)
        if (record === undefined || record === null || typeof record !== 'object') continue
        const identity = record.identity
        if (identity === undefined || identity === null || typeof identity !== 'object') continue
        if (identity.cwd === cwd) continue
        await table.put(variant, Object.assign({}, record, {
          identity: Object.assign({}, identity, { cwd }),
        }))
        updated = true
      }
      return updated
    },

    /** Drop every durable trace of a session: cache row, workspace accounting, archive/pin sets. */
    async dropSession(sessionId) {
      const variants = idVariants(sessionId)
      const table = cacheTable()
      if (table !== undefined) {
        for (const variant of variants) {
          if (table.get(variant) !== undefined) await table.delete(variant)
        }
      }

      const sd = ctx.get('storageDomain')
      if (sd === undefined || sd === null || typeof sd.get !== 'function') return
      const domain = sd.get('workspace')
      if (domain === undefined || domain === null || typeof domain.table !== 'function') return

      const workspaces = domain.table('workspaces')
      for (const [workspaceId, record] of workspaces.entries()) {
        if (record === null || typeof record !== 'object') continue
        if (!Array.isArray(record.sessionIds)) continue
        if (!variants.some((variant) => record.sessionIds.includes(variant))) continue
        await workspaces.put(workspaceId, Object.assign({}, record, {
          sessionIds: record.sessionIds.filter((id) => !variants.includes(id)),
        }))
      }

      try {
        const global = domain.global
        if (global !== undefined && typeof global.get === 'function' && typeof global.set === 'function') {
          const state = global.get()
          if (state !== null && typeof state === 'object') {
            const trim = (list) => (Array.isArray(list) ? list.filter((id) => !variants.includes(id)) : list)
            await global.set(Object.assign({}, state, {
              archivedSessionIds: trim(state.archivedSessionIds),
              pinnedSessionIds: trim(state.pinnedSessionIds),
            }))
          }
        }
      } catch { /* no global slot in this composition */ }
    },
  }

  // -------------------------------------------------------------------- title

  const titleService = {
    apply(session, title) {
      const service = ctx.get('sessionTitle')
      if (service === undefined || typeof service.rename !== 'function') {
        throw new Error('session title service is unavailable')
      }
      return service.rename(session, title).title
    },
  }

  return { sessionGateway, logStore, registry, durableStores, titleService }
}
