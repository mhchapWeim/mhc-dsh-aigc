param(
    [Parameter(Mandatory = $true)]
    [string]$Image
)
$ErrorActionPreference = 'Stop'
$packageDir = $PSScriptRoot
$archivePath = Join-Path $packageDir 'nginx-image.tar'
docker image inspect $Image | Out-Null
if ($LASTEXITCODE -ne 0) { throw '指定镜像不存在或 Docker 未连接。' }
$platform = docker image inspect --format '{{.Os}}/{{.Architecture}}' $Image
if ($LASTEXITCODE -ne 0 -or $platform -ne 'linux/amd64') {
    throw "需要 linux/amd64 镜像，实际为 $platform"
}
docker save --platform linux/amd64 --output $archivePath $Image
if ($LASTEXITCODE -ne 0) { throw '镜像导出失败。' }
[IO.File]::WriteAllText((Join-Path $packageDir 'image-ref.txt'), $Image.Trim() + "`n", [Text.UTF8Encoding]::new($false))
Get-FileHash -Algorithm SHA256 $archivePath
Write-Host "镜像已导出到 $archivePath"
