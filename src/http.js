// The HTTP surface: one GET for facts, one POST for operations.
//
// Both share a single JSON envelope and a single error mapping, so the client
// has exactly one shape to understand.

import { OpError } from './txn.js'

export const ROUTES = {
  info: '/__sessionmove/info',
  op: '/__sessionmove/op',
}

const STATUS_BY_CODE = {
  INVALID: 400,
  CONFLICT: 409,
  NOT_SUPPORTED: 501,
  ROLLED_BACK: 500,
  PARTIAL: 500,
  FAILED: 500,
  SNAPSHOT_FAILED: 500,
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function failureStatus(error) {
  if (error instanceof OpError) return STATUS_BY_CODE[error.code] ?? 500
  return 500
}

/**
 * @param {object} deps registry, ops, capabilities, snapshotter, journal
 */
export function createHttpHandler(deps) {
  return async function handle(req, res) {
    const url = req.url ?? ''
    const pathname = url.split('?')[0]
    const capabilities = typeof deps.capabilityReport === 'function'
      ? deps.capabilityReport()
      : { compatible: true, missing: [] }

    if (pathname !== ROUTES.info && pathname !== ROUTES.op) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'unknown endpoint' })
      return
    }

    if (pathname === ROUTES.info) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, code: 'INVALID', message: 'method not allowed' })
        return
      }
      try {
        const query = new URLSearchParams(url.split('?')[1] ?? '')
        const sessionId = query.get('sessionId') ?? ''
        const workspaces = deps.registry.list()
        let currentWorkspaceId = null
        if (sessionId.length > 0) {
          const stat = await deps.logStore.stat(sessionId)
          if (stat !== undefined) {
            const cwd = stat.header.cwd
            const match = workspaces.find((entry) => entry.path === cwd)
            if (match !== undefined) currentWorkspaceId = match.workspaceId
          }
        }
        sendJson(res, 200, {
          ok: true,
          workspaces: workspaces.map((entry) => ({
            workspaceId: entry.workspaceId,
            title: entry.title,
            path: entry.path,
            reachable: entry.reachable !== false,
          })),
          currentWorkspaceId,
          capabilities,
          snapshotsBytes: typeof deps.snapshotter.size === 'function' ? deps.snapshotter.size() : 0,
          journal: deps.journal.path,
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, code: 'FAILED', message: String(error && error.message) })
      }
      return
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'INVALID', message: 'method not allowed' })
      return
    }

    let body
    try {
      const raw = await readBody(req)
      body = raw.length === 0 ? {} : JSON.parse(raw)
    } catch {
      sendJson(res, 400, { ok: false, code: 'INVALID', message: 'bad json body' })
      return
    }

    const op = String(body.op ?? '').trim()
    const args = body.args !== null && typeof body.args === 'object' ? body.args : {}
    if (op !== 'move' && op !== 'delete' && op !== 'rename') {
      sendJson(res, 400, { ok: false, code: 'INVALID', message: 'unknown operation: ' + op })
      return
    }

    const required = (deps.requirements ?? {})[op] ?? []
    const missing = required.filter((capability) => capabilities.missing.includes(capability))
    if (missing.length > 0) {
      sendJson(res, 501, {
        ok: false,
        code: 'NOT_SUPPORTED',
        message: '当前 dsh 版本不兼容（缺 ' + missing.join(', ') + '），请升级 dsh-session-move',
      })
      return
    }

    try {
      const result = await deps.ops[op]({ ...args, source: 'ui' })
      sendJson(res, 200, { ok: true, result })
    } catch (error) {
      sendJson(res, failureStatus(error), {
        ok: false,
        code: error instanceof OpError ? error.code : 'FAILED',
        message: error && error.message ? error.message : String(error),
        detail: error instanceof OpError ? error.detail : undefined,
      })
    }
  }
}
