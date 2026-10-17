<# Exercise legacy-name upgrades through the production installer with a private product identity. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$ProductName,
    [Parameter(Mandatory)][string]$RegistryKey, [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$DefaultDirectory)
$ErrorActionPreference = 'Stop'
if ($ProductName -notmatch '^Harness Installer Test [a-f0-9]{8}$' -or $RegistryKey -notmatch '^[a-f0-9-]{36}$') {
    throw 'Expected isolated installer fixture'
}
$installPath = Join-Path $OutputDirectory 'Legacy Application'
$appPath = Join-Path $installPath 'bhssAiWork.exe'
$uninstaller = Join-Path $installPath 'Uninstall bhssAiWork.exe'
$registryPath = 'HKCU:\Software\' + $RegistryKey
$results = [Collections.Generic.List[string]]::new()
$legacyNames = @(
    ('BHSS' + (-join [char[]](0x529e, 0x516c, 0x52a9, 0x624b)) + '.exe'),
    ((-join [char[]](0x5f2f, 0x5d3d, 0x5de5, 0x4f5c, 0x4f19, 0x4f34)) + '.exe'),
    'deepseek-harness.exe'
)
$running = $null
$dataPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) $ProductName
$dataMarker = Join-Path $dataPath 'upgrade-preserved.txt'
function Run-Installer([string]$Arguments, [int]$ExpectedExit) {
    Write-Output "Installer check: arguments=$Arguments expected=$ExpectedExit"
    $process = Start-Process -FilePath $Installer -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    try {
        if (-not $process.WaitForExit(60000)) {
            $process.Kill(); $process.WaitForExit()
            throw 'Installer fixture timed out'
        }
        if ($process.ExitCode -ne $ExpectedExit) { throw "Expected exit $ExpectedExit, received $($process.ExitCode)" }
    } finally { $process.Dispose() }
}
try {
    Run-Installer ('/S /D=' + $installPath) 0
    if (-not (Test-Path -LiteralPath $appPath)) { throw 'Stable executable missing after fresh install' }
    $results.Add('fresh-install-stable-executable')
    New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
    Set-Content -LiteralPath $dataMarker -Value 'preserve user data'
    foreach ($legacyName in $legacyNames) {
        Run-Installer ('/S /D=' + $installPath) 0
        $appPath = Join-Path $installPath 'bhssAiWork.exe'
        $legacyPath = Join-Path $installPath $legacyName
        Move-Item -LiteralPath $appPath -Destination $legacyPath
        $marker = Join-Path $installPath 'launched.txt'
        if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker }
        $running = Start-Process -FilePath $legacyPath -WindowStyle Hidden -PassThru
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while (-not (Test-Path -LiteralPath $marker)) {
            if ($running.HasExited -or $timer.Elapsed.TotalSeconds -gt 10) { throw 'Legacy fixture did not start' }
            Start-Sleep -Milliseconds 50
        }
        Run-Installer '/S --updated' 2
        if ($running.HasExited -or -not (Test-Path -LiteralPath $legacyPath)) { throw 'Running legacy app was disturbed' }
        if (Get-ChildItem -LiteralPath $OutputDirectory -Directory | Where-Object { $_.Name -like 'Legacy Application.new-*' }) {
            throw 'Blocked upgrade retained a staged payload'
        }
        $running.Kill(); $running.WaitForExit(); $running.Dispose(); $running = $null
        Run-Installer '/S --updated' 0
        $appPath = Join-Path $DefaultDirectory 'bhssAiWork.exe'
        $uninstaller = Join-Path $DefaultDirectory 'Uninstall bhssAiWork.exe'
        if (-not (Test-Path -LiteralPath $appPath) -or (Test-Path -LiteralPath $legacyPath)) {
            throw "Legacy executable was not replaced: $legacyName"
        }
        if ((Get-ItemProperty $registryPath).InstallLocation.TrimEnd('\') -ne $DefaultDirectory) {
            throw 'Upgrade did not migrate to the default installation directory'
        }
        if ((Get-Content -LiteralPath $dataMarker) -ne 'preserve user data') { throw 'Upgrade removed user data' }
        $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) ($ProductName + '.lnk')
        $shell = New-Object -ComObject WScript.Shell
        if ($shell.CreateShortcut($shortcut).TargetPath -ne $appPath) { throw 'Start menu shortcut has the wrong target' }
        $results.Add("registered-migration-user-data-and-running-process:$legacyName")
    }
    Run-Installer '/S --updated' 0
    $results.Add('stable-name-repeat-upgrade')
    $foreign = Join-Path $OutputDirectory 'Foreign Application'
    New-Item -ItemType Directory -Path $foreign | Out-Null
    $foreignFile = Join-Path $foreign $legacyNames[0]
    Set-Content -LiteralPath $foreignFile -Value 'preserved'
    Run-Installer ('/S /D=' + $foreign) 2
    if ((Get-Content -LiteralPath $foreignFile) -ne 'preserved') { throw 'Unregistered directory changed' }
    $results.Add('unregistered-legacy-name-directory-rejected')
} finally {
    if ($null -ne $running) {
        if (-not $running.HasExited) { $running.Kill(); $running.WaitForExit() }
        $running.Dispose()
    }
    if (Test-Path -LiteralPath $uninstaller) {
        $cleanup = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru
        try {
            if (-not $cleanup.WaitForExit(60000)) { $cleanup.Kill(); $cleanup.WaitForExit(); throw 'Fixture uninstall timed out' }
            if ($cleanup.ExitCode -ne 0) { throw 'Fixture uninstall failed' }
        } finally { $cleanup.Dispose() }
    }
}
$results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'brand-upgrade-results.json') -Encoding UTF8
$results | ForEach-Object { Write-Output "PASS: $_" }
