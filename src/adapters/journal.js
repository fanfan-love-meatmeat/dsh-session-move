// Append-only operation journal.
//
// One JSON object per line, never rewritten: appending is the only write we can
// make safely from a plugin. A crash therefore leaves a visible 'in-progress'
// line, which is exactly the information recovery needs.

import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './fs.js'

const ROTATE_BYTES = 5 * 1024 * 1024

/**
 * @param {{root: string, logger?: object}} options
 */
export function createJournal(options) {
  const dir = options.root
  const file = path.join(dir, 'journal.jsonl')

  function rotateIfNeeded() {
    try {
      const stat = fs.statSync(file)
      if (stat.size < ROTATE_BYTES) return
      const rotated = path.join(dir, 'journal.' + Date.now() + '.jsonl')
      fs.renameSync(file, rotated)
    } catch { /* no journal yet */ }
  }

  return {
    path: file,
    roots: dir,
    /** Append one entry. Never throws: a journal problem must not fail an operation. */
    append(entry) {
      try {
        ensureDir(dir)
        rotateIfNeeded()
        fs.appendFileSync(file, JSON.stringify(entry) + '\n')
        return true
      } catch (error) {
        options.logger?.warn?.('[session-move] journal append failed: ' + String(error && error.message))
        return false
      }
    },
    /** Read back every entry, oldest first. Used by the CLI, never by the UI. */
    read() {
      let text
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        return []
      }
      const out = []
      for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue
        try {
          out.push(JSON.parse(line))
        } catch { /* skip a torn line */ }
      }
      return out
    },
  }
}
