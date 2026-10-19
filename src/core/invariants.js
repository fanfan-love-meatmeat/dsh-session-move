// The four invariants every state-changing operation must leave true.
//
// They are the ONLY thing verification can rely on, so they stay deliberately
// narrow: identity, location, accounting, and the header frame's shape.
// Content integrity is out of scope here (the snapshot covers that).

import path from 'node:path'
import { encodeSegment, projectKey } from './slug.js'

/** Where a session's log directory must live for a given header. */
export function expectedSessionDir(sessionsRoot, header) {
  if (typeof header !== 'string' && (header === null || typeof header !== 'object')) {
    throw new Error('expectedSessionDir: header is required')
  }
  const cwd = header.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('expectedSessionDir: header has no cwd')
  if (typeof header.id !== 'string' || header.id.length === 0) throw new Error('expectedSessionDir: header has no id')
  return path.join(sessionsRoot, projectKey(cwd), encodeSegment(header.id))
}

/** Compare two paths the way a filesystem does, per platform. */
export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const strip = (value) => value.replace(/[\\/]+$/, '')
  const left = strip(a)
  const right = strip(b)
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function fail(reason) {
  return { ok: false, reason }
}

const OK = { ok: true, reason: '' }

/**
 * I1 — the log directory on disk is the one its own header implies.
 * Pass the realpath'd directory once the adapter has resolved links and case.
 */
export function checkLocation(sessionsRoot, header, actualDir) {
  let expected
  try {
    expected = expectedSessionDir(sessionsRoot, header)
  } catch (error) {
    return fail(error.message)
  }
  return samePath(expected, actualDir) ? OK : fail('log lives at ' + actualDir + ' but its header implies ' + expected)
}

/** I2 — the session is accounted in the target workspace and in no other. */
export function checkAccounting(workspaces, sessionId, targetWorkspaceId) {
  if (!Array.isArray(workspaces)) return fail('workspace list unavailable')
  let inTarget = false
  const elsewhere = []
  for (const workspace of workspaces) {
    const owns = Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)
    if (workspace.workspaceId === targetWorkspaceId) inTarget = owns
    else if (owns) elsewhere.push(workspace.workspaceId)
  }
  if (!inTarget) return fail('target workspace does not account this session')
  if (elsewhere.length > 0) return fail('session is still accounted in: ' + elsewhere.join(', '))
  return OK
}

/**
 * I3 — the projection-cache record still describes this exact lifecycle.
 * The host compares createdAt + cwd + isSeeded; a mismatch makes it ignore the
 * row (titles fall back to the directory name), so this is a quality check.
 */
export function checkCacheIdentity(record, header) {
  if (record === undefined || record === null) return OK
  const identity = record.identity
  if (identity === undefined || identity === null || typeof identity !== 'object') {
    return fail('projection record carries no identity')
  }
  if (identity.createdAt !== header.createdAt) return fail('projection identity createdAt differs')
  if (identity.cwd !== header.cwd) return fail('projection identity cwd is ' + String(identity.cwd))
  if ((identity.isSeeded ?? false) !== (header.isSeeded ?? false)) return fail('projection identity isSeeded differs')
  return OK
}

/** Collect the first failure, or OK when every check passes. */
export function allOf(...checks) {
  for (const check of checks) {
    if (check === undefined || check === null) continue
    if (check instanceof Promise) throw new Error('allOf is synchronous; await checks first')
    if (check.ok !== true) return check
  }
  return OK
}
