// Transaction-skeleton tests on fake ports: no host, no filesystem.
// Run: node tools/test-ops.mjs

import assert from 'node:assert'
import { runTransaction, OpError, STATUS } from '../src/txn.js'

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed++
  } catch (error) {
    failures.push(name + ' :: ' + (error && error.message ? error.message : String(error)))
  }
}

function makeClock() {
  let tick = 0
  const base = new Date('2026-10-19T16:30:00Z').getTime()
  return { now: () => new Date(base + tick++ * 1000) }
}

function makeJournal() {
  const entries = []
  return {
    entries,
    async append(entry) { entries.push(entry) },
  }
}

function makeSnapshotter(options) {
  const state = { calls: 0 }
  return {
    state,
    async take() {
      state.calls++
      if (options && options.fail === true) throw new Error('disk full')
      return { id: 'snap-1', path: '/snap/snap-1' }
    },
  }
}

function baseOptions(overrides) {
  return Object.assign({
    kind: 'move',
    sessionId: 's1',
    title: 'demo',
    source: 'ui',
    clock: makeClock(),
    journal: makeJournal(),
    snapshotter: makeSnapshotter(),
    steps: [],
    verify: async () => ({ ok: true, reason: '' }),
  }, overrides ?? {})
}

await check('commit: steps run in order, restore never runs', async () => {
  const order = []
  let restored = 0
  const journal = makeJournal()
  const result = await runTransaction(baseOptions({
    journal,
    steps: [
      { name: 'one', run: async () => { order.push('one') } },
      { name: 'two', run: async () => { order.push('two') } },
    ],
    restore: async () => { restored++ },
  }))
  assert.strictEqual(result.status, STATUS.COMMITTED)
  assert.deepStrictEqual(order, ['one', 'two'])
  assert.strictEqual(restored, 0)
  assert.deepStrictEqual(journal.entries.map((e) => e.status), [STATUS.IN_PROGRESS, STATUS.COMMITTED])
})

await check('no steps: reports no-change and skips the snapshot', async () => {
  const snapshotter = makeSnapshotter()
  const journal = makeJournal()
  const result = await runTransaction(baseOptions({ journal, snapshotter, steps: [] }))
  assert.strictEqual(result.status, STATUS.NO_CHANGE)
  assert.strictEqual(snapshotter.state.calls, 0)
  assert.deepStrictEqual(journal.entries.map((e) => e.status), [STATUS.NO_CHANGE])
})

await check('snapshot failure: aborts before any step and records a rejection', async () => {
  const journal = makeJournal()
  let ran = 0
  await assert.rejects(
    () => runTransaction(baseOptions({
      journal,
      snapshotter: makeSnapshotter({ fail: true }),
      steps: [{ name: 'one', run: async () => { ran++ } }],
    })),
    (error) => error instanceof OpError && error.code === 'SNAPSHOT_FAILED',
  )
  assert.strictEqual(ran, 0)
  assert.deepStrictEqual(journal.entries.map((e) => e.status), [STATUS.REJECTED])
  assert.ok(journal.entries[0].reason.includes('disk full'))
})

await check('step failure with a clean restore: rolled-back, one restore call', async () => {
  const journal = makeJournal()
  let restored = 0
  let restoredAfterStep = null
  await assert.rejects(
    () => runTransaction(baseOptions({
      journal,
      steps: [
        { name: 'one', run: async () => {} },
        { name: 'two', run: async () => { throw new Error('rename failed') } },
      ],
      restore: async () => { restored++; restoredAfterStep = 'two' },
    })),
    (error) => error instanceof OpError && error.code === 'ROLLED_BACK' && error.message.includes('已还原'),
  )
  assert.strictEqual(restored, 1)
  assert.strictEqual(restoredAfterStep, 'two')
  const last = journal.entries[journal.entries.length - 1]
  assert.strictEqual(last.status, STATUS.ROLLED_BACK)
  assert.strictEqual(last.failedStep, 'two')
})

await check('step-level verify failure also rolls back', async () => {
  let restored = 0
  await assert.rejects(
    () => runTransaction(baseOptions({
      steps: [{
        name: 'header',
        run: async () => {},
        verify: async () => ({ ok: false, reason: 'cwd not applied' }),
      }],
      restore: async () => { restored++ },
    })),
    (error) => error instanceof OpError && error.code === 'ROLLED_BACK',
  )
  assert.strictEqual(restored, 1)
})

await check('restore throws: partial, message carries the snapshot path', async () => {
  const journal = makeJournal()
  await assert.rejects(
    () => runTransaction(baseOptions({
      journal,
      steps: [{ name: 'one', run: async () => { throw new Error('boom') } }],
      restore: async () => { throw new Error('copy failed') },
    })),
    (error) => error instanceof OpError
      && error.code === 'PARTIAL'
      && error.message.includes('/snap/snap-1'),
  )
  const last = journal.entries[journal.entries.length - 1]
  assert.strictEqual(last.status, STATUS.PARTIAL)
  assert.ok(last.restoreError.includes('copy failed'))
})

await check('restore ok but verification still fails: partial, no restore error', async () => {
  const journal = makeJournal()
  await assert.rejects(
    () => runTransaction(baseOptions({
      journal,
      steps: [{ name: 'one', run: async () => { throw new Error('boom') } }],
      restore: async () => {},
      verify: async () => ({ ok: false, reason: 'still inconsistent' }),
    })),
    (error) => error instanceof OpError
      && error.code === 'PARTIAL'
      && error.message.includes('still inconsistent'),
  )
  const last = journal.entries[journal.entries.length - 1]
  assert.strictEqual(last.status, STATUS.PARTIAL)
  assert.strictEqual(last.restoreError, undefined)
  assert.strictEqual(last.verifyReason, 'still inconsistent')
})

await check('journal entries carry the operation identity', async () => {
  const journal = makeJournal()
  await runTransaction(baseOptions({
    journal,
    source: 'tool',
    steps: [{ name: 'one', run: async () => {} }],
  }))
  const first = journal.entries[0]
  assert.ok(first.opId.length > 8)
  assert.strictEqual(first.kind, 'move')
  assert.strictEqual(first.source, 'tool')
  assert.strictEqual(first.sessionId, 's1')
  assert.strictEqual(first.snapshot, 'snap-1')
  assert.strictEqual(journal.entries[1].opId, first.opId)
})

if (failures.length > 0) {
  console.log('FAILED ' + failures.length + ' / ' + (passed + failures.length))
  for (const line of failures) console.log('  x ' + line)
  process.exit(1)
}
console.log('txn: ' + passed + ' passed, 0 failed')
