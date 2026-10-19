// Durable single-file writes: temp sibling -> fsync -> rename, with retries for
// the Windows sharing violations that antivirus and the search indexer cause.
//
// Deliberately local instead of @deepseek-ai/dsh-atomic-write: that package
// lives inside the dsh installation, so importing it would put a host
// dependency on the write path and make these modules untestable outside a
// running profile. The semantics reproduced here are the ones we actually need.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RETRY_DELAYS_MS = [20, 60, 150, 400]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withRetries(operation) {
  let last
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await operation()
    } catch (error) {
      last = error
      if (!RETRY_CODES.has(error && error.code)) throw error
      if (attempt === RETRY_DELAYS_MS.length) break
      await sleep(RETRY_DELAYS_MS[attempt])
    }
  }
  throw last
}

/** fsync a directory so a rename survives a crash (best effort: unsupported on some platforms). */
async function syncDirectory(dir) {
  let handle
  try {
    handle = await fs.promises.open(dir, 'r')
    await handle.sync()
  } catch {
    /* directory fsync is not portable; the file itself is already synced */
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }
}

/**
 * Replace one file atomically.
 * The temp name carries a random suffix so concurrent writers never share one.
 * @param {string} file absolute path
 * @param {Buffer|string} content
 * @param {{mode?: number}} [options]
 */
export async function writeFileAtomic(file, content, options) {
  const dir = path.dirname(file)
  const mode = options && typeof options.mode === 'number' ? options.mode : 0o600
  const temp = path.join(dir, path.basename(file) + '.tmp-' + randomBytes(6).toString('hex'))

  await withRetries(async () => {
    const handle = await fs.promises.open(temp, 'wx', mode)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.promises.rename(temp, file)
  })

  await syncDirectory(dir)
}

/** Remove a file if present, tolerating Windows' transient locks. */
export async function removeFileQuietly(file) {
  try {
    await withRetries(() => fs.promises.unlink(file))
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    throw error
  }
}
