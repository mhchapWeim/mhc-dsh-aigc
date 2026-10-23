/** Static outbound inventory. Findings require review; this is not runtime traffic evidence. */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync } from 'node:fs'
import { join, relative, resolve, extname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const rootDefault = resolve(import.meta.dirname, '../../..')
const ignored = new Set(['node_modules', '.git', '.desktop-build', 'lib', 'dist', 'tests', '__tests__', 'fixtures', 'snapshots', 'benchmarks', 'website', '.agents'])
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'])
const configExtensions = new Set(['.json', '.yml', '.yaml', '.ps1', '.sh', '.nsh', '.nsi', '.cmd', '.bat'])
const sinkPattern = /(?:fetch|request|connect|WebSocket|XMLHttpRequest|sendBeacon|captureException|captureEvent|captureMessage|track|telemetry|spawn|exec|execFile|fork)$/i
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const slash = path => path.replaceAll('\\', '/')

/** Inspect AST literals and calls without recording URL credentials, paths, queries, or request data. */
export function inspectOutbound(text, file) {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const findings = []
  const add = (node, kind, value) => findings.push({ kind, value, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) {
      for (const match of node.text.matchAll(/(?:https?|wss?):\/\/[^\s"'`<>]+/gi)) {
        try {
          const url = new URL(match[0])
          add(node, 'origin', url.origin)
        } catch { /* Dynamic or incomplete destinations are covered by call-site review. */ }
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression
      const name = ts.isPropertyAccessExpression(expression) ? expression.name.text : ts.isIdentifier(expression) ? expression.text : ''
      if (sinkPattern.test(name)) add(node, 'call', name)
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && /sentry|telemetry|analytics|posthog|amplitude|mixpanel|@segment\//i.test(node.moduleSpecifier.text)) {
      add(node, 'telemetry-import', node.moduleSpecifier.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return findings
}

function sourceFiles(root) {
  const files = []
  const walk = directory => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isSymbolicLink()) continue
      const path = join(directory, item.name)
      if (item.isDirectory()) {
        if (!ignored.has(item.name)) walk(path)
      } else if ((extensions.has(extname(path)) || configExtensions.has(extname(path)) || item.name.startsWith('.env'))
        && item.name !== 'outbound-policy.json' && !/\.(?:spec|test|d)\.[cm]?[jt]sx?$/.test(path)) files.push(path)
    }
  }
  for (const name of ['apps', 'packages', 'vendor', 'native', 'scripts']) {
    if (!existsSync(join(root, name))) throw new Error(`Outbound audit requires source directory: ${name}`)
    walk(join(root, name))
  }
  for (const name of ['package.json', 'pnpm-workspace.yaml']) if (existsSync(join(root, name))) files.push(join(root, name))
  if (files.length === 0) throw new Error('Outbound audit refuses an empty source corpus')
  return files
}

/** Write a source inventory and optional installer binding. No finding is approved automatically. */
export function auditOutbound({ root = rootDefault, output, artifacts = [], enforce = false }) {
  root = resolve(root)
  const policyPath = join(root, 'apps/desktop/outbound-policy.json')
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
  if (policy.version !== 1 || !Array.isArray(policy.reviews)) throw new Error('Invalid outbound review policy')
  for (const review of policy.reviews) {
    if (typeof review.file !== 'string' || !/^[a-f0-9]{64}$/.test(review.sha256)
      || !review.reviewer || !review.reviewedAt || !review.purpose || !review.data || !review.trigger) {
      throw new Error('Each outbound approval requires file hash, reviewer, date, purpose, data, and trigger')
    }
  }
  const files = sourceFiles(root)
  const corpus = []
  const entries = []
  for (const path of files) {
    const bytes = readFileSync(path)
    const file = slash(relative(root, path))
    const sha256 = digest(bytes)
    corpus.push({ file, sha256 })
    const text = bytes.toString('utf8')
    const findings = extensions.has(extname(path)) ? inspectOutbound(text, file) : []
    if (!extensions.has(extname(path))) {
      for (const match of text.matchAll(/(?:https?|wss?):\/\/[^\s"'`<>]+/gi)) {
        try { findings.push({ kind: 'configuration-origin', value: new URL(match[0]).origin,
          line: text.slice(0, match.index).split('\n').length }) } catch { /* Computed config values need manual review. */ }
      }
      if (['.ps1', '.sh', '.nsh', '.nsi', '.cmd', '.bat'].includes(extname(path))) findings.push({ kind: 'script', value: 'manual-review', line: 1 })
      if (file.endsWith('package.json') && Object.keys(JSON.parse(text).scripts ?? {}).length > 0) {
        findings.push({ kind: 'package-scripts', value: 'manual-review', line: 1 })
      }
    }
    if (findings.length === 0) continue
    const review = policy.reviews.find(item => item.file === file && item.sha256 === sha256)
    entries.push({ file, sha256, status: review ? 'reviewed' : 'needs-review', findings,
      ...(review ? { review } : {}) })
  }
  const manifests = []
  const manifestWalk = directory => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isDirectory() && !ignored.has(item.name)) manifestWalk(join(directory, item.name))
      else if (item.isFile() && item.name === 'package.json') {
        const path = join(directory, item.name)
        const value = JSON.parse(readFileSync(path, 'utf8'))
        const dependencies = input => Object.fromEntries(Object.entries(input ?? {}).map(([name, version]) => {
          if (typeof version === 'string' && /^(?:git\+)?https?:\/\//i.test(version)) {
            try { return [name, `${new URL(version.replace(/^git\+/i, '')).origin}/[redacted]`] } catch { return [name, '[unparsed URL]'] }
          }
          return [name, version]
        }))
        manifests.push({ file: slash(relative(root, path)), name: value.name,
          version: value.version, dependencies: dependencies(value.dependencies), optionalDependencies: dependencies(value.optionalDependencies), scripts: Object.keys(value.scripts ?? {}) })
      }
    }
  }
  for (const name of ['apps', 'packages', 'vendor', 'native']) manifestWalk(join(root, name))
  const lockPath = join(root, 'pnpm-lock.yaml')
  const sourceDigest = digest(JSON.stringify(corpus))
  const lockfileSha256 = digest(readFileSync(lockPath))
  const dependencyDigest = digest(JSON.stringify(manifests))
  const dependencyReview = policy.dependencyReview
  const dependenciesReviewed = dependencyReview?.lockfileSha256 === lockfileSha256
    && dependencyReview?.manifestSha256 === dependencyDigest && Boolean(dependencyReview.reviewer && dependencyReview.reviewedAt && dependencyReview.scope)
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error(`Cannot record Git state: ${result.stderr}`)
    return result.stdout.trim()
  }
  const boundArtifacts = artifacts.map(path => {
    const absolute = resolve(path)
    if (!lstatSync(absolute).isFile()) throw new Error(`Not an artifact file: ${absolute}`)
    return { file: slash(relative(resolve(output), absolute)), bytes: lstatSync(absolute).size, sha256: digest(readFileSync(absolute)) }
  })
  const pending = entries.filter(item => item.status === 'needs-review').length
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), status: pending || !dependenciesReviewed ? 'needs-review' : 'source-review-passed-runtime-unverified',
    source: { commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0,
      fileCount: files.length, sha256: sourceDigest, lockfileSha256, policySha256: digest(readFileSync(policyPath)) },
    dependencies: { manifestSha256: dependencyDigest, reviewed: dependenciesReviewed },
    coverage: { source: 'JS/TS AST literals and selected call names; URL text in configuration and scripts; script files require review',
      exclusions: [...ignored], runtimeObservation: 'not-performed', installedDependencies: 'not-inspected',
      packagedCodeInspection: 'not-performed', nativeBinaryInspection: 'not-performed',
      limitation: 'Not proof of absence of malicious behavior. Aliased APIs, computed destinations, non-JavaScript scripts, dependencies, and native code require additional review. An artifact hash binds identity only; it does not prove source-to-binary correspondence.' },
    artifacts: boundArtifacts, pendingFileCount: pending, entries, manifests,
  }
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'outbound-audit.json'), JSON.stringify(report, null, 2) + '\n')
  const cell = value => String(value ?? '待确认').replaceAll('|', '\\|').replaceAll('\n', ' ')
  const rows = entries.flatMap(entry => [...new Set(entry.findings.filter(f => f.kind.endsWith('origin')).map(f => f.value))]
    .map(origin => `| ${origin} | ${cell(entry.file)} | ${cell(entry.review?.purpose)} | ${cell(entry.review?.data)} | ${cell(entry.review?.trigger)} | ${entry.status} |`))
  writeFileSync(join(output, '出站审查清单.md'), [
    '# DSH 出站审查清单', '', `状态：${report.status}；待审查文件：${pending}。`,
    `依赖清单/锁文件审查：${dependenciesReviewed ? '已登记' : '待审查'}。`,
    `源码：${report.source.commit}；包含未提交修改：${report.source.dirty}；扫描文件：${files.length}。`,
    '', '**此报告是静态线索清单，不是“无恶意出站”证明。未执行运行时流量观察、安装依赖代码审查、安装包代码审查及原生二进制审查。**',
    '', '域名可能只是链接或配置默认值，不代表实际发送请求。动态地址和同域名下的数据变化需人工检查 JSON 中的调用位置。',
    '', '| 地址（已去掉凭据、路径和查询参数） | 源码位置 | 用途 | 发送的数据 | 触发条件 | 审查状态 |', '|---|---|---|---|---|---|', ...rows,
    '', '## 产物 SHA-256', '', ...boundArtifacts.map(item => `- ${item.file}：\`${item.sha256}\``),
    '', '完整文件哈希、调用行号、依赖声明和覆盖边界见 outbound-audit.json。',
  ].join('\n') + '\n')
  writeFileSync(join(output, 'SHA256SUMS.txt'), boundArtifacts.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n')
  if (enforce && (pending || !dependenciesReviewed)) throw new Error(`Outbound release gate blocked: ${pending} source files need review; dependency review: ${dependenciesReviewed}. Report: ${output}`)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--enforce')) throw new Error('Supported option: --enforce')
  const output = join(rootDefault, 'apps/desktop/.desktop-build/outbound-audit')
  const report = auditOutbound({ output, enforce: args.includes('--enforce') })
  console.log(`Outbound inventory: ${report.source.fileCount} files, ${report.pendingFileCount} need review; ${output}`)
}
