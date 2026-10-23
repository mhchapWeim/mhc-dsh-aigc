import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { auditOutbound, inspectOutbound } from '../scripts/outbound-audit.mjs'

test('uses AST nodes rather than comments and redacts URL secrets', () => {
  const result = inspectOutbound('// fetch("https://comment.test")\nfetch("https://user:password@api.example.test/path?token=secret"); new WebSocket(endpoint);', 'source.ts')
  assert.deepEqual(result.filter(item => item.kind === 'origin').map(item => item.value), ['https://api.example.test'])
  assert.deepEqual(result.filter(item => item.kind === 'call').map(item => item.value), ['fetch', 'WebSocket'])
  assert.ok(!JSON.stringify(result).includes('password'))
  assert.ok(!JSON.stringify(result).includes('token'))
})

test('fails closed for missing coverage and unreviewed calls; a source change invalidates approval', () => {
  const parent = resolve(import.meta.dirname, '../.desktop-build')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'audit-test-'))
  const output = join(root, 'report')
  try {
    mkdirSync(join(root, 'apps/desktop'), { recursive: true })
    const policy = join(root, 'apps/desktop/outbound-policy.json')
    writeFileSync(policy, JSON.stringify({ version: 1, reviews: [] }))
    assert.throws(() => auditOutbound({ root, output }), /requires source directory/)
    for (const name of ['packages', 'vendor', 'native', 'scripts']) mkdirSync(join(root, name))
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
    const source = join(root, 'apps/source.ts')
    writeFileSync(source, 'fetch(destination, { body: prompt })')
    const artifact = join(root, 'candidate.exe')
    writeFileSync(artifact, 'test fixture; not an executable')
    assert.throws(() => auditOutbound({ root, output, artifacts: [artifact], enforce: true }), /gate blocked/)
    const initial = JSON.parse(readFileSync(join(output, 'outbound-audit.json')))
    assert.equal(initial.pendingFileCount, 1)
    assert.equal(initial.artifacts[0].sha256.length, 64)
    assert.equal(initial.coverage.runtimeObservation, 'not-performed')
    writeFileSync(policy, JSON.stringify({ version: 1, dependencyReview: {
      lockfileSha256: initial.source.lockfileSha256, manifestSha256: initial.dependencies.manifestSha256,
      reviewer: 'reviewer', reviewedAt: '2026-10-23', scope: 'fixture dependencies',
    }, reviews: [{
      file: initial.entries[0].file, sha256: initial.entries[0].sha256, reviewer: 'reviewer',
      reviewedAt: '2026-10-23', purpose: 'chat', data: 'user-approved prompt', trigger: 'user submission',
    }] }))
    assert.equal(auditOutbound({ root, output, enforce: true }).pendingFileCount, 0)
    const config = join(root, 'apps/runtime.yml')
    writeFileSync(config, 'endpoint: https://user:private@collector.example.test/path?key=hidden')
    assert.throws(() => auditOutbound({ root, output, enforce: true }), /gate blocked/)
    const configReport = readFileSync(join(output, 'outbound-audit.json'), 'utf8')
    assert.ok(configReport.includes('https://collector.example.test'))
    assert.ok(!configReport.includes('private@'))
    assert.ok(!configReport.includes('key=hidden'))
    rmSync(config)
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 10')
    assert.throws(() => auditOutbound({ root, output, enforce: true }), /gate blocked/)
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
    writeFileSync(source, 'fetch(destination, { body: privateFile })')
    assert.throws(() => auditOutbound({ root, output, enforce: true }), /gate blocked/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
