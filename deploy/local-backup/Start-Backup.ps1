param([switch]$RunApi)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$local = Join-Path $repo '.verification/local-backup'
New-Item -ItemType Directory -Force $local | Out-Null
$configPath = Join-Path $local 'settings.json'
if (!(Test-Path $configPath)) {
    @{
        RootUser = 'aigc-local-root'
        RootPassword = [guid]::NewGuid().ToString('N')
        AccessKey = 'aigc-local-backup'
        SecretKey = [guid]::NewGuid().ToString('N')
        Endpoint = 'http://127.0.0.1:19000'
        Bucket = 'dsh-backups'
        MaximumBytes = 1073741824
        AccountQuotaBytes = 10737418240
        PartBytes = 8388608
        UploadLifetimeHours = 168
    } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
}
$settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed ($LASTEXITCODE)" }
}
$name = 'aigc-backup-minio-local'
$exists = & docker ps -a --filter "name=^/$name$" --format '{{.Names}}'
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is unavailable' }
if ($exists -eq $name) {
    Invoke-Docker start $name | Out-Null
} else {
    @("MINIO_ROOT_USER=$($settings.RootUser)", "MINIO_ROOT_PASSWORD=$($settings.RootPassword)") |
        Set-Content -LiteralPath (Join-Path $local 'minio.env') -Encoding ascii
    Invoke-Docker run -d --name $name --restart unless-stopped --env-file (Join-Path $local 'minio.env') `
        -p '127.0.0.1:19000:9000' -p '127.0.0.1:19001:9001' `
        -v 'aigc_backup_minio_local:/data' quay.io/minio/minio:RELEASE.2025-06-13T11-33-47Z `
        server /data --console-address ':9001' | Out-Null
}
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { Invoke-WebRequest "$($settings.Endpoint)/minio/health/live" -TimeoutSec 2 | Out-Null; $ready = $true; break }
    catch { Start-Sleep -Seconds 1 }
}
if (!$ready) { throw 'Local MinIO did not become ready' }
$policy = @{
    Version = '2012-10-17'
    Statement = @(
        @{ Effect = 'Allow'; Action = @('s3:GetBucketLocation','s3:ListBucket','s3:ListBucketMultipartUploads'); Resource = @("arn:aws:s3:::$($settings.Bucket)") },
        @{ Effect = 'Allow'; Action = @('s3:GetObject','s3:PutObject','s3:DeleteObject','s3:AbortMultipartUpload','s3:ListMultipartUploadParts'); Resource = @("arn:aws:s3:::$($settings.Bucket)/accounts/*") }
    )
}
$policy | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $local 'policy.json') -Encoding utf8
Invoke-Docker cp (Join-Path $local 'policy.json') "${name}:/tmp/backup-policy.json"
Invoke-Docker exec $name mc alias set bootstrap http://127.0.0.1:9000 $settings.RootUser $settings.RootPassword | Out-Null
Invoke-Docker exec $name mc mb --ignore-existing "bootstrap/$($settings.Bucket)" | Out-Null
Invoke-Docker exec $name mc anonymous set none "bootstrap/$($settings.Bucket)" | Out-Null
Invoke-Docker exec $name mc admin user add bootstrap $settings.AccessKey $settings.SecretKey | Out-Null
Invoke-Docker exec $name mc admin policy create bootstrap dsh-backups /tmp/backup-policy.json | Out-Null
Invoke-Docker exec $name mc admin policy attach bootstrap dsh-backups --user $settings.AccessKey | Out-Null
Write-Host "MinIO ready: $($settings.Endpoint); console: http://127.0.0.1:19001"
Write-Host "Local settings (contains credentials, git-ignored): $configPath"
if ($RunApi) {
    $previous = @{}
    try {
        $values = @{ Enabled = 'true' }
        foreach ($key in @('Endpoint','Bucket','AccessKey','SecretKey','MaximumBytes','AccountQuotaBytes','PartBytes','UploadLifetimeHours')) { $values[$key] = [string]$settings.$key }
        foreach ($key in $values.Keys) {
            $envName = "BackupStorage__$key"
            $previous[$envName] = [Environment]::GetEnvironmentVariable($envName, 'Process')
            [Environment]::SetEnvironmentVariable($envName, $values[$key], 'Process')
        }
        & dotnet run --project (Join-Path $repo 'server/AigcHub.Api') --launch-profile http
        if ($LASTEXITCODE -ne 0) { throw 'Local API exited with an error' }
    } finally {
        foreach ($envName in $previous.Keys) { [Environment]::SetEnvironmentVariable($envName, $previous[$envName], 'Process') }
    }
}
