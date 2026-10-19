// Capability probes: answer "does this dsh version still give us what we need"
// once, at activation, instead of sprinkling typeof checks through the code.
//
// The report drives two things: the /info payload (the client shows a banner
// when incompatible) and a single startup warning that names what is missing.

import { reportCapabilities } from '../ports/index.js'

/** Build the probe table for one cordis context. */
export function buildProbes(ctx) {
  const service = (name) => ctx.get(name)

  return {
    'sessions.get': () => typeof service('sessions')?.get === 'function',
    'sessions.flush': () => typeof service('sessions')?.flush === 'function',
    'sessions.detachEntered': () => typeof service('sessions')?.detachEntered === 'function',
    'agents.resume': () => typeof service('agents')?.resume === 'function',
    'agents.cancel': () => typeof service('agents')?.get === 'function',
    'sessionTitle.rename': () => typeof service('sessionTitle')?.rename === 'function',
    'sessionPersistence': () => service('sessionPersistence') !== undefined,
    'workspaceRegistry.indexHeader': () => typeof service('workspaceRegistry')?.indexHeader === 'function',
    'workspaceRegistry.attachSession': () => {
      const registry = service('workspaceRegistry')
      if (registry === undefined || typeof registry.list !== 'function') return false
      const first = registry.list()[0]
      return first === undefined ? true : typeof first.attachSession === 'function'
    },
    'storageDomain.workspace': () => typeof service('storageDomain')?.get === 'function',
    'webServer.register': () => typeof service('webServer')?.register === 'function',
    'tools.register': () => typeof service('tools')?.register === 'function',
    'llm.stream': () => typeof service('llm')?.stream === 'function',
  }
}

/**
 * @returns {{compatible: boolean, missing: string[], services: Record<string, string>}}
 *   services maps each host service to 'present' | 'absent' at probe time, so a
 *   false negative can be told apart from a genuinely missing capability.
 */
export function probeCapabilities(ctx) {
  const report = reportCapabilities(buildProbes(ctx))
  report.services = {}
  for (const name of [
    'workspaceRegistry', 'storageDomain', 'sessions', 'agents',
    'sessionTitle', 'sessionPersistence', 'tools', 'llm', 'webServer',
  ]) {
    let value
    try {
      value = ctx.get(name)
    } catch {
      value = undefined
    }
    report.services[name] = value === undefined ? 'absent' : 'present'
  }
  return report
}

/** One clear line instead of a hundred silent degradations. */
export function warnIfIncompatible(ctx, report, logger) {
  if (report.compatible) return report
  const text = '[dsh-session-move] 与当前 dsh 版本不兼容，缺少：' + report.missing.join(', ')
    + '。请升级 dsh-session-move。'
  logger?.warn?.(text)
  return report
}
