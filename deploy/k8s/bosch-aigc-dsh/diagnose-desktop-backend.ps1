param(
    [string]$ExecutablePath,
    [string]$BackendUrl = 'https://aigcbackend.boschhuayu-steering.com'
)

$ErrorActionPreference = 'Stop'

try {
    $origin = [Uri]::new($BackendUrl)
    if ($origin.Scheme -ne 'https' -or $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment) {
        throw 'BackendUrl must be an HTTPS origin without path, query, or fragment.'
    }
} catch {
    Write-Error "Invalid backend URL: $($_.Exception.Message)"
    exit 2
}

if (-not $ExecutablePath) {
    $process = Get-CimInstance Win32_Process |
        Where-Object { $_.Name -like 'BHSS*.exe' } |
        Select-Object -First 1
    if ($process) { $ExecutablePath = $process.ExecutablePath }
}

if (-not $ExecutablePath -or -not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    Write-Error 'BHSS desktop process was not found. Start the app, or pass -ExecutablePath with the installed exe path.'
    exit 2
}

$healthUrl = "$($origin.GetLeftPart([System.UriPartial]::Authority))/health"
Write-Host "Desktop executable: $ExecutablePath"
Write-Host "Backend test URL: $healthUrl"
Write-Host 'This tests the specified URL; it does not extract the URL embedded in the installed app.'

try {
    $addresses = Resolve-DnsName -Name $origin.DnsSafeHost -Type A -ErrorAction Stop |
        Where-Object { $_.IPAddress } | Select-Object -ExpandProperty IPAddress -Unique
    Write-Host "DNS IPv4: $($addresses -join ', ')"
} catch {
    Write-Host "DNS lookup failed: $($_.Exception.Message)"
}

try {
    $response = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 10 -UseBasicParsing
    Write-Host "Windows HTTPS: HTTP $($response.StatusCode)"
} catch {
    $errorDetail = $_.Exception
    while ($errorDetail.InnerException) { $errorDetail = $errorDetail.InnerException }
    Write-Host "Windows HTTPS failed: $($errorDetail.Message)"
}

$nodeScript = @'
const url = process.argv[2];
fetch(url, { signal: AbortSignal.timeout(10000) })
  .then(async response => {
    console.log(`Desktop Node HTTPS: HTTP ${response.status}`);
    process.exitCode = response.ok ? 0 : 1;
  })
  .catch(error => {
    console.error(`Desktop Node HTTPS failed: ${error.cause?.code ?? error.name}: ${error.cause?.message ?? error.message}`);
    process.exitCode = 1;
  });
'@

$priorRunAsNode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process')
$priorSystemCa = [Environment]::GetEnvironmentVariable('NODE_USE_SYSTEM_CA', 'Process')
$temporaryRoot = [System.IO.Path]::GetTempPath()
$temporaryId = [Guid]::NewGuid().ToString('N')
$scriptPath = Join-Path $temporaryRoot "dsh-backend-$temporaryId.cjs"
$stdoutPath = Join-Path $temporaryRoot "dsh-backend-$temporaryId.stdout"
$stderrPath = Join-Path $temporaryRoot "dsh-backend-$temporaryId.stderr"
try {
    [System.IO.File]::WriteAllText($scriptPath, $nodeScript)
    $env:ELECTRON_RUN_AS_NODE = '1'
    foreach ($trustMode in @('bundled-ca', 'system-ca')) {
        $env:NODE_USE_SYSTEM_CA = if ($trustMode -eq 'system-ca') { '1' } else { '0' }
        Write-Host "Testing trust mode: $trustMode"
        $process = Start-Process -FilePath $ExecutablePath -ArgumentList @("`"$scriptPath`"", "`"$healthUrl`"") `
            -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath `
            -WindowStyle Hidden -PassThru -Wait
        $nodeExitCode = $process.ExitCode
        if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath | ForEach-Object { Write-Host $_ } }
        if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath | ForEach-Object { Write-Host $_ } }
        Write-Host "Desktop Node exit code ($trustMode): $nodeExitCode"
    }
} finally {
    if ($null -eq $priorRunAsNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    else { $env:ELECTRON_RUN_AS_NODE = $priorRunAsNode }
    if ($null -eq $priorSystemCa) { Remove-Item Env:NODE_USE_SYSTEM_CA -ErrorAction SilentlyContinue }
    else { $env:NODE_USE_SYSTEM_CA = $priorSystemCa }
    foreach ($path in @($scriptPath, $stdoutPath, $stderrPath)) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
}

if ($nodeExitCode -ne 0) { exit 1 }
