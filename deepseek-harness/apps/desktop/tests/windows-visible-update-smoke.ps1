[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer,
      [Parameter(Mandatory)][string]$ProductName,
      [Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-installer-ui.ps1')
[InstallerCapture]::Initialize()
[InstallerCapture]::ProductName = $ProductName
# This script is only for the uniquely named inert fixture built by test-windows-installer.mjs.
if ($ProductName -notmatch '^Harness Installer Test [a-f0-9]{8}$') { throw 'Expected isolated installer fixture' }
$installPath=Join-Path $OutputDirectory 'Visible Update App'
$appPath=Join-Path $installPath ($ProductName + '.exe')
$marker=Join-Path $installPath 'launched.txt'
$uninstaller=Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')
$baseline=$null
$update=$null
try {
    $baseline=Start-Process -FilePath $Installer -ArgumentList ('/S /D=' + $installPath) -PassThru -WindowStyle Hidden
    if (-not $baseline.WaitForExit(60000) -or $baseline.ExitCode -ne 0) { throw 'Isolated baseline installation failed' }
    if (Test-Path -LiteralPath $marker) { throw 'Baseline unexpectedly started test application' }
    $update=Start-Process -FilePath $Installer -ArgumentList '/S --updated --force-run' -PassThru -WindowStyle Hidden
    $shown=$false
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while (-not $update.HasExited -and $timer.Elapsed.TotalSeconds -lt 60) {
        if ([InstallerCapture]::Find($update.Id) -ne [IntPtr]::Zero) { $shown=$true }
        Start-Sleep -Milliseconds 5
    }
    if (-not $update.HasExited -or $update.ExitCode -ne 0) { throw 'Visible updater did not finish automatically' }
    if (-not $shown) { throw 'Updater progress window was never shown' }
    $timer.Restart()
    while (-not (Test-Path -LiteralPath $marker) -and $timer.Elapsed.TotalSeconds -lt 10) { Start-Sleep -Milliseconds 20 }
    if (-not (Test-Path -LiteralPath $marker)) { throw 'New application was not launched automatically' }
    Write-Output 'PASS: visible update progress, automatic installer completion and application restart'
} finally {
    foreach ($owned in @($baseline,$update)) {
        if ($owned -and -not $owned.HasExited) { $owned.Kill(); [void]$owned.WaitForExit(10000) }
    }
    # Stop only this test executable, never another installed DSH instance.
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $appPath } | Stop-Process -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $uninstaller) {
        # NSIS uninstallers spawn a temporary child; wait for that child before the next language fixture.
        $cleanup=Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
        if (-not $cleanup.WaitForExit(30000) -or $cleanup.ExitCode -ne 0) { throw 'Isolated fixture cleanup failed' }
    }
}
