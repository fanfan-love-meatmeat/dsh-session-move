// Path-identity helpers, pure and host-free.
//
// These MUST stay byte-identical to the host's own encoding: a session's log
// lives at sessions/<projectKey(cwd)>/<encodeSegment(id)>/<generation-name>,
// and the host refuses to read a log whose path disagrees with its header.
// tools/test-core.mjs pins the behaviour against known-good values.

const SAFE = /^[A-Za-z0-9._-]$/

/** Escape one path segment: safe code units stay literal, everything else becomes ~XXXX. */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && SAFE.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Readable project directory key for one cwd.
 * Separators collapse to a single '-', unsafe code units escape like ids, the
 * leading '-' run is dropped, and the result is wrapped in '--...--'.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && SAFE.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return '--' + (readable.replace(/^-+/, '') || 'root').slice(0, 251) + '--'
}
