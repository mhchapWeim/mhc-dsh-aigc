import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { prepareWorkspacePermissions } from '../src/workspace-permissions.ts'

const run = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('allows an unconfigured managed root', async () => {
  await prepareWorkspacePermissions(undefined)
})

it('creates a managed root and permits repeated initialization', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-permissions-'))
  roots.push(base)
  const root = join(base, "workspace ' quoted")
  await prepareWorkspacePermissions(root)
  await prepareWorkspacePermissions(root)
  expect((await stat(root)).isDirectory()).toBe(true)
})

it.skipIf(process.platform !== 'win32')('repairs an owner with Modify permission so Windows can set the sandbox label', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-permissions-'))
  roots.push(root)
  const script = `
$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1"
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $env:DSH_TEST_WORKSPACE
$acl.SetAccessRuleProtection($true, $false)
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $env:DSH_TEST_WORKSPACE -AclObject $acl
`
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, DSH_TEST_WORKSPACE: root }, windowsHide: true,
  })
  await prepareWorkspacePermissions(root)
  // Setting the integrity label exercises WRITE_OWNER, which Modify does not grant.
  await run('icacls.exe', [root, '/setintegritylevel', '(OI)(CI)L'], { windowsHide: true })
  await prepareWorkspacePermissions(root)
})
