// Port contracts: the only seams between operations and the host.
//
// This module carries no implementation and imports nothing. adapters/ owns the
// implementations; ops/ and txn.js may only depend on the shapes documented here.

/**
 * SessionGateway — the host's live-session bookkeeping.
 * get(id)      -> live session or undefined
 * flush(id)    -> true when a durability barrier ran
 * detach(id)   -> true when the session left the store (this is what releases the write lock)
 * cancel(id)   -> boolean (stop an in-flight turn, bounded wait; tolerated when absent)
 * resume(id)   -> { dispose() } or undefined (wakes a cold session)
 */
export const SESSION_GATEWAY = ['get', 'flush', 'detach', 'resume']

/**
 * LogStore — the on-disk session artifacts.
 * stat(id)            -> { dir, slug, header, generation } or undefined
 * generations(dir)    -> [{ name, version }]
 * patchCwd(dir, cwd)  -> [{ name, bytes }]
 * renameDir(from, to) -> void
 * removeDir(dir)      -> void
 */
export const LOG_STORE = ['stat', 'generations', 'patchCwd', 'renameDir', 'removeDir']

/**
 * Registry — the in-memory workspace index.
 * list()             -> [{ workspaceId, path, title, sessionIds }]
 * index(header)      -> void
 * attach(wsId, id)   -> void
 * detach(wsId, id)   -> void
 */
export const REGISTRY = ['list', 'index', 'attach', 'detach']

/**
 * DurableStores — the two persisted copies of a session's identity.
 * cacheRow(id)             -> record or undefined
 * patchCacheCwd(id, cwd)   -> boolean
 * dropSession(id)          -> void
 */
export const DURABLE_STORES = ['cacheRow', 'patchCacheCwd', 'dropSession']

/**
 * TitleService — applying a generated title.
 * apply(session, title) -> accepted title
 */
export const TITLE_SERVICE = ['apply']

/**
 * Snapshotter — the escape hatch.
 * take(request) -> { id, path }   request: { sessionDir, records, header, ... }
 * copyBack(id, targetDir) -> void  a fixed sequence, never a per-step inverse
 * readRecords(id) -> object        the two persisted records as they were
 * size()        -> number (bytes currently used by snapshots)
 */
export const SNAPSHOTTER = ['take', 'size']

/** Throw unless the object carries every named method. */
export function assertShape(name, value, methods) {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new Error(name + ' port is missing')
  }
  const absent = methods.filter((method) => typeof value[method] !== 'function')
  if (absent.length > 0) throw new Error(name + ' port lacks: ' + absent.join(', '))
  return value
}

/** Build the capability report consumed by /info and the client banner. */
export function reportCapabilities(checks) {
  const missing = []
  for (const [id, probe] of Object.entries(checks)) {
    let ok = false
    try {
      ok = probe() === true
    } catch {
      ok = false
    }
    if (!ok) missing.push(id)
  }
  return { compatible: missing.length === 0, missing }
}
