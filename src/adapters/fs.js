// Filesystem primitives for session directories: listing, moving, removing,
// copying a tree, and measuring it. No host knowledge lives here.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/** Entry names inside a directory, or [] when it cannot be read. */
export function listNames(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** True when the path exists and is a directory. */
export function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** True when the path exists (any kind). */
export function exists(target) {
  try {
    fs.statSync(target)
    return true
  } catch {
    return false
  }
}

/** Create a directory and its parents. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** Rename a directory; the parent must exist. Cross-device moves are refused loudly. */
export function renameDir(from, to) {
  if (exists(to)) throw new Error('target already exists: ' + to)
  ensureDir(path.dirname(to))
  fs.renameSync(from, to)
}

/** Remove a directory tree, tolerating an already-absent target. */
export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

/** Total bytes of every file under a directory. */
export function dirSize(dir) {
  let total = 0
  let stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size
        } catch { /* vanished mid-walk */ }
      }
    }
  }
  return total
}

/**
 * Copy a directory tree, preserving file mode.
 * Files are copied to a temp sibling when target files exist, so a partially
 * written copy never looks like a complete one.
 */
export function copyTree(from, to) {
  const stat = fs.statSync(from)
  if (!stat.isDirectory()) throw new Error('not a directory: ' + from)
  ensureDir(to)
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(source, target)
    else if (entry.isFile()) {
      const temp = target + '.tmp-' + randomBytes(4).toString('hex')
      fs.copyFileSync(source, temp)
      fs.chmodSync(temp, fs.statSync(source).mode)
      fs.renameSync(temp, target)
    }
  }
}

/** Copy a tree to a fresh temp directory and swap it into place in one rename. */
export function replaceTree(from, to) {
  const staging = to + '.staging-' + randomBytes(4).toString('hex')
  copyTree(from, staging)
  removeDir(to)
  fs.renameSync(staging, to)
}
