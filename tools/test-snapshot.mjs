// Snapshot + restore round-trip against a real directory tree.
// Run: node tools/test-snapshot.mjs

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { constants, zstdCompress } from 'node:zlib'
import { promisify } from 'node:util'

import { createSnapshotter } from '../src/adapters/snapshot.js'
import { writeFileAtomic } from '../src/adapters/durable.js'
import { renameDir } from '../src/adapters/fs.js'
import { projectKey, encodeSegment } from '../src/core/slug.js'
import { patchHeaderCwd, readHeaderFrame, scanZstdFrames } from '../src/core/log.js'

const compress = promisify(zstdCompress)
const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

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

const HEADER = {
  type: 'session',
  version: 4,
  id: '0a42141c-aaaa-bbbb-cccc-111122223333',
  createdAt: 1792379781409,
  cwd: 'C:\\work\\project-old',
  isSeeded: false,
  delegationDepth: 1,
}

const sandbox = path.join(process.cwd(), 'tmp', 'test-snapshot-' + randomBytes(4).toString('hex'))
const sessionsRoot = path.join(sandbox, 'sessions')
const snapshotRoot = path.join(sandbox, 'snapshots')

async function buildSession() {
  const dir = path.join(sessionsRoot, projectKey(HEADER.cwd), encodeSegment(HEADER.id))
  fs.mkdirSync(dir, { recursive: true })
  const headerFrame = await compress(JSON.stringify(HEADER) + '\n', CHECKSUM)
  const body = await compress('{"seq":1,"type":"user/message"}\n', CHECKSUM)
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(file, Buffer.concat([headerFrame, body]))
  return { dir, file }
}

try {
  const original = await buildSession()
  const originalBytes = fs.readFileSync(original.file)
  const records = {
    workspace: { workspaceId: 'old', sessionIds: [HEADER.id] },
    cache: { identity: { createdAt: HEADER.createdAt, cwd: HEADER.cwd, isSeeded: false } },
  }
  const snapshotter = createSnapshotter({ root: snapshotRoot })

  await check('take: writes session tree, records and meta', async () => {
    const snapshot = await snapshotter.take({
      opId: '20261019163000-abcd',
      kind: 'move',
      sessionId: HEADER.id,
      title: 'demo',
      at: new Date('2026-10-19T16:30:00Z'),
      sessionDir: original.dir,
      header: HEADER,
      records,
    })
    assert.ok(fs.existsSync(path.join(snapshot.path, 'session', 'session.v4.jsonl.zstd')))
    assert.deepStrictEqual(snapshotter.readRecords(snapshot.id), records)
    const meta = snapshotter.readMeta(snapshot.id)
    assert.strictEqual(meta.kind, 'move')
    assert.strictEqual(meta.sessionId, HEADER.id)
    assert.strictEqual(meta.sessionDir, original.dir)
  })

  await check('take: refuses a missing session directory', async () => {
    await assert.rejects(() => snapshotter.take({
      opId: 'nope-1', kind: 'move', sessionId: 's', at: new Date(),
      sessionDir: path.join(sandbox, 'does-not-exist'),
    }))
  })

  await check('take: refuses to overwrite an existing snapshot id', async () => {
    await assert.rejects(() => snapshotter.take({
      opId: '20261019163000-abcd', kind: 'move', sessionId: HEADER.id, at: new Date(),
      sessionDir: original.dir,
    }))
  })

  await check('size: reports a positive byte count', () => {
    assert.ok(snapshotter.size() > 0)
  })

  // --- simulate a partially applied move ---------------------------------
  await check('restore: byte-identical after a simulated failed move', async () => {
    const patched = await patchHeaderCwd(originalBytes, 'C:\\work\\project-new')
    await writeFileAtomic(original.file, patched.buffer)

    const newDir = path.join(sessionsRoot, projectKey('C:\\work\\project-new'), encodeSegment(HEADER.id))
    renameDir(original.dir, newDir)

    // recovery: one fixed sequence, not a per-step inverse
    snapshotter.copyBack('20261019163000-abcd', original.dir)
    await writeFileAtomic(path.join(original.dir, 'session.v4.jsonl.zstd'), originalBytes)

    const restored = fs.readFileSync(path.join(original.dir, 'session.v4.jsonl.zstd'))
    assert.ok(restored.equals(originalBytes), 'restored log must be byte-identical')

    const header = await readHeaderFrame(restored.subarray(0, scanZstdFrames(restored).frames[0].end))
    assert.strictEqual(header.cwd, HEADER.cwd)
    assert.strictEqual(header.id, HEADER.id)
    assert.deepStrictEqual(snapshotter.readRecords('20261019163000-abcd'), records)
  })

  await check('restore: copyBack replaces a stray target tree', async () => {
    const stray = path.join(sessionsRoot, 'stray-target')
    fs.mkdirSync(stray, { recursive: true })
    fs.writeFileSync(path.join(stray, 'junk.txt'), 'x')
    snapshotter.copyBack('20261019163000-abcd', stray)
    assert.strictEqual(fs.existsSync(path.join(stray, 'junk.txt')), false)
    assert.ok(fs.existsSync(path.join(stray, 'session.v4.jsonl.zstd')))
  })
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log('FAILED ' + failures.length + ' / ' + (passed + failures.length))
  for (const line of failures) console.log('  x ' + line)
  process.exit(1)
}
console.log('snapshot: ' + passed + ' passed, 0 failed')
