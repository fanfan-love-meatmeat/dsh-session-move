// Plugin configuration: what the row's config block may say.
//
// Only these keys are read. Anything else is ignored rather than rejected, so a
// stale config from an older version never blocks activation.

export const DEFAULTS = {
  targetWords: 6,
  targetCjkCharacters: 14,
  maxInputBytes: 8192,
  maxOutputTokens: 256,
  timeoutMs: 60000,
}

const ALLOWED = new Set([
  'targetWords', 'targetCjkCharacters', 'maxInputBytes', 'maxOutputTokens', 'timeoutMs',
  'provider', 'model',
])

/**
 * Accept either a bare object or the documented { renameAi: {...} } wrapper.
 * @param {object|undefined} raw plugin row config
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && raw.renameAi !== undefined ? raw.renameAi : raw
  const out = { ...DEFAULTS }
  if (source === null || source === undefined || typeof source !== 'object') return out
  for (const key of ALLOWED) {
    const value = source[key]
    if (value === undefined) continue
    if (key === 'provider' || key === 'model') {
      if (typeof value === 'string' && value.length > 0) out[key] = value
      continue
    }
    if (Number.isInteger(value) && value > 0) out[key] = value
  }
  return out
}
