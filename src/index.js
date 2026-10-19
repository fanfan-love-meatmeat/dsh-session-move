// dsh-session-move — host half, assembly root.
//
// This file wires ports to adapters and surfaces to operations. It contains no
// business logic: everything below it is testable without a running Harness.
//
// Layers (dependency arrows point down):
//   http.js / tools.js        surfaces
//   ops/*                     step declarations
//   txn.js                    snapshot -> steps -> verify -> commit | restore
//   core/*                    pure: slug, log geometry, invariants, title input
//   ports/index.js            contracts
//   adapters/*                the only code that knows about @deepseek-ai/*

import path from 'node:path'

import { createHostAdapters, dshHome, sessionsRoot } from './adapters/dsh.js'
import { createJournal } from './adapters/journal.js'
import { createSnapshotter } from './adapters/snapshot.js'
import { createLlm } from './adapters/llm.js'
import { probeCapabilities, warnIfIncompatible } from './adapters/capabilities.js'
import { createHttpHandler, ROUTES } from './http.js'
import { registerTools } from './tools.js'
import { normalizeConfig } from './config.js'
import { createMove } from './ops/move.js'
import { createDelete } from './ops/delete.js'
import { createRename } from './ops/rename.js'

export const name = 'dsh-session-move'
export const inject = ['tools', 'sessions', 'llm']

/** Capabilities each operation cannot work without. */
const REQUIREMENTS = {
  move: [
    'sessions.get', 'sessions.detachEntered', 'sessions.flush',
    'workspaceRegistry.indexHeader', 'workspaceRegistry.attachSession', 'storageDomain.workspace',
  ],
  delete: ['sessions.get', 'sessions.detachEntered', 'storageDomain.workspace'],
  rename: ['sessions.get', 'sessionTitle.rename', 'llm.stream'],
}

export function apply(ctx, config) {
  const base = path.join(dshHome(), 'session-move')
  const journal = createJournal({ root: base, logger: ctx.logger })
  const snapshotter = createSnapshotter({ root: path.join(base, 'snapshots') })
  const host = createHostAdapters(ctx)

  const runtime = {
    paths: { sessionsRoot: sessionsRoot() },
    clock: { now: () => new Date() },
    journal,
    snapshotter,
    logger: ctx.logger,
    config: normalizeConfig(config),
    llm: createLlm(ctx),
    ...host,
  }

  const removeSession = createDelete(runtime)
  const ops = {
    move: createMove(runtime),
    delete: removeSession,
    rename: createRename(runtime),
  }

  // Capabilities are probed on EVERY report, never cached.
  //
  // ctx.get() is strict by default: it returns undefined unless the providing
  // fiber is ACTIVE. workspaceRegistry finishes its async init late in boot, so
  // a probe taken early sees "absent" and would otherwise pin that result for
  // the whole process — reporting a healthy host as incompatible forever.
  let warned = false
  const capabilityReport = () => {
    const report = probeCapabilities(ctx)
    if (!report.compatible && !warned) {
      warned = true
      warnIfIncompatible(ctx, report, ctx.logger)
    }
    return report
  }

  const handler = createHttpHandler({
    registry: host.registry,
    logStore: host.logStore,
    ops,
    snapshotter,
    journal,
    requirements: REQUIREMENTS,
    capabilityReport,
  })

  ctx.inject(['webServer'], (sub) => {
    for (const routePath of Object.values(ROUTES)) {
      sub.effect(() => sub.webServer.register({ kind: 'exact', path: routePath, handler }))
    }
  })

  registerTools(ctx, ops)
}
