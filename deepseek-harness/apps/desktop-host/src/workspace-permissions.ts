import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Paths travel through the environment, never through PowerShell source interpolation.
const prepareScript = `
$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1"
$path = $env:DSH_PREPARE_WORKSPACE
$directory = [IO.DirectoryInfo]::new($path)
for ($ancestor = $directory; $null -ne $ancestor; $ancestor = $ancestor.Parent) {
  if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Workspace permission preparation refuses reparse points'
  }
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $path
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$full = [Security.AccessControl.FileSystemRights]::FullControl
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.IdentityReference -eq $sid -and $rule.AccessControlType -eq 'Allow' -and
      ($rule.FileSystemRights -band $full) -eq $full -and
      ($rule.InheritanceFlags -band $inheritance) -eq $inheritance -and
      $rule.PropagationFlags -eq 'None') { exit 0 }
}
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid) {
  throw 'Workspace must be owned by the running Windows account before automatic permission repair'
}
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, $full, $inheritance, 'None', 'Allow')
$null = $acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($path, $acl)
`

/** Create the managed root and prepare inheritable permissions for Windows ACL sandbox grants.
 * @param root - Managed workspace root, or undefined when no root is configured.
 */
export async function prepareWorkspacePermissions(root: string | undefined): Promise<void> {
  if (root === undefined) return
  await mkdir(root, { recursive: true })
  if (process.platform !== 'win32') return
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prepareScript, 'utf16le').toString('base64')], {
      env: { ...process.env, DSH_PREPARE_WORKSPACE: root }, windowsHide: true, timeout: 60_000,
    })
  } catch (cause) {
    throw new Error(`Cannot prepare Windows sandbox permissions for workspace ${root}. The running account needs Full Control including WRITE_OWNER. Ask the directory owner or administrator to repair its permissions; explicit deny rules are preserved. ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}
