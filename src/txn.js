// The transaction skeleton every state-changing operation runs through.
//
// Contract (see report/deepseek/T3_实现推演/202610191545_事务骨架.md):
//   snapshot -> steps in order -> verify -> commit
//   on any failure -> restore from the snapshot -> verify -> rolled-back | partial
//
// There is deliberately NO per-step undo. The snapshot holds the complete disk
// state, so recovery is one fixed sequence, not a pile of inverse operations.

/** Terminal and intermediate statuses recorded in the journal. */
export const STATUS = {
  REJECTED: 'rejected',
  IN_PROGRESS: 'in-progress',
  COMMITTED: 'committed',
  ROLLED_BACK: 'rolled-back',
  PARTIAL: 'partial',
  NO_CHANGE: 'no-change',
  /** Failed before touching anything, and nothing needed undoing (no snapshot taken). */
  FAILED: 'failed',
}

/** A failure a caller can report to the user without leaking internals. */
export class OpError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'OpError'
    this.code = code
    this.detail = detail
  }
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomSuffix(length) {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return out
}

/** Collision-resistant operation id: sortable timestamp + random suffix. */
export function createOpId(now, suffix) {
  const stamp = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  return stamp + '-' + (suffix === undefined ? randomSuffix(4) : suffix)
}

async function runChecks(checks, label) {
  for (const check of checks) {
    const result = check === undefined || check === null ? { ok: true, reason: '' } : await check()
    if (result.ok !== true) {
      throw new OpError('VERIFY_FAILED', label + ': ' + (result.reason || 'invariant violated'))
    }
  }
}

/**
 * Run one operation as a transaction.
 *
 * @param {object} options
 * @param {string} options.kind          move | delete | rename
 * @param {string} options.sessionId     the session the operation acts on
 * @param {string} [options.title]       display title, when known
 * @param {string} options.source        ui | tool | script
 * @param {object} options.clock         { now(): Date }
 * @param {object} options.journal       { append(entry): Promise<void> }
 * @param {object} options.snapshotter   { take(request): Promise<object> }
 * @param {Array}  options.steps         [{ name, run(): Promise<void>, verify?(): Promise<object> }]
 * @param {Function} options.verify      () => Promise<invariant result>
 * @param {Function} [options.restore]   () => Promise<void>  (required when steps exist)
 * @param {object} [options.logger]
 * @param {object} [options.meta]        extra journal fields for this operation kind
 * @returns {Promise<{status: string, opId: string, snapshot: object|undefined, failedStep: string|null}>}
 */
export async function runTransaction(options) {
  const {
    kind, sessionId, title, source, clock, journal, snapshotter, steps,
    verify, restore, logger, meta,
  } = options

  const startedAt = clock.now()
  const opId = createOpId(startedAt)
  const base = Object.assign(
    { opId, at: startedAt.toISOString(), kind, source, sessionId, title: title ?? null },
    meta === undefined ? {} : meta,
  )

  const fail = async (status, reason, extra) => {
    await journal.append(Object.assign({}, base, { status, reason }, extra ?? {}))
    return { status, opId, snapshot: extra === undefined ? undefined : extra.snapshot, failedStep: extra === undefined ? null : extra.failedStep ?? null }
  }

  if (steps.length === 0) {
    await journal.append(Object.assign({}, base, { status: STATUS.NO_CHANGE, reason: 'nothing to do' }))
    return { status: STATUS.NO_CHANGE, opId, snapshot: undefined, failedStep: null }
  }

  // --- snapshot first: no fallback, no work -----------------------------------
  const needsSnapshot = options.requiresSnapshot !== false
  let snapshot
  try {
    snapshot = needsSnapshot
      ? await snapshotter.take(Object.assign(
        {},
        options.snapshotRequest === undefined ? {} : options.snapshotRequest,
        { opId, kind, sessionId, title, at: startedAt },
      ))
      : { id: null, path: null }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    logger?.warn?.('[session-move] snapshot failed, operation not started: ' + message)
    await fail(STATUS.REJECTED, 'snapshot failed: ' + message)
    throw new OpError('SNAPSHOT_FAILED', '无法创建快照，操作未开始：' + message)
  }

  await journal.append(Object.assign({}, base, { status: STATUS.IN_PROGRESS, snapshot: snapshot.id }))

  // --- forward pass ----------------------------------------------------------
  let failedStep = null
  try {
    for (const step of steps) {
      failedStep = step.name
      await step.run()
      if (typeof step.verify === 'function') await runChecks([step.verify], 'step ' + step.name)
    }
    failedStep = 'verify'
    await runChecks([verify], 'final verification')
    await journal.append(Object.assign({}, base, {
      status: STATUS.COMMITTED,
      snapshot: snapshot.id,
      durationMs: clock.now().getTime() - startedAt.getTime(),
    }))
    return { status: STATUS.COMMITTED, opId, snapshot, failedStep: null }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    logger?.warn?.('[session-move] ' + kind + ' failed at ' + failedStep + ': ' + message)

    if (!needsSnapshot) {
      await journal.append(Object.assign({}, base, {
        status: STATUS.FAILED,
        failedStep,
        reason: message,
        durationMs: clock.now().getTime() - startedAt.getTime(),
      }))
      throw new OpError('FAILED', message, { opId, failedStep })
    }

    // --- recovery: one fixed sequence, never a per-step inverse ---------------
    let restoreError = null
    if (typeof restore === 'function') {
      try {
        await restore(snapshot)
      } catch (inner) {
        restoreError = inner && inner.message ? inner.message : String(inner)
      }
    }

    const verifyRestored = typeof options.verifyRestored === 'function' ? options.verifyRestored : verify
    let verification = { ok: false, reason: restoreError === null ? 'restore was not attempted' : restoreError }
    try {
      verification = await verifyRestored()
    } catch (inner) {
      verification = { ok: false, reason: 'verification threw: ' + (inner && inner.message ? inner.message : String(inner)) }
    }

    const status = verification.ok === true && restoreError === null ? STATUS.ROLLED_BACK : STATUS.PARTIAL
    await journal.append(Object.assign({}, base, {
      status,
      snapshot: snapshot.id,
      failedStep,
      reason: message,
      restoreError: restoreError === null ? undefined : restoreError,
      verifyReason: verification.ok === true ? undefined : verification.reason,
      durationMs: clock.now().getTime() - startedAt.getTime(),
    }))

    const userMessage = status === STATUS.ROLLED_BACK
      ? '操作失败，已还原到执行前：' + message
      : '操作失败且未能完整还原（' + (restoreError ?? verification.reason) + '），快照位于 ' + snapshot.path
    throw new OpError(status === STATUS.ROLLED_BACK ? 'ROLLED_BACK' : 'PARTIAL', userMessage, {
      opId, failedStep, snapshot: snapshot.path,
    })
  }
}
