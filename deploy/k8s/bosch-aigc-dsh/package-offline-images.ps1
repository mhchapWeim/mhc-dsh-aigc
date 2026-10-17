param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]*$')][string]$Tag,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'artifacts')
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$apiImage = "aigc-api`:$Tag"
$portalImage = "aigc-portal`:$Tag"
$nginxImage = "aigc-edge-nginx`:$Tag"
$postgresImage = "aigc-postgres`:$Tag"
$tarPath = Join-Path $OutputDirectory "aigc-dsh-images-$Tag-linux-amd64.tar"
$publicApiUrl = 'https://aigcbackend.boschhuayu-steering.com'

function Invoke-Docker {
    param([string[]]$DockerArguments)
    & docker @DockerArguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker $($DockerArguments[0]) failed with exit code $LASTEXITCODE"
    }
}

Invoke-Docker @('info', '--format', '{{.ServerVersion}}')
Invoke-Docker @('build', '--platform', 'linux/amd64', '-t', $apiImage, (Join-Path $repoRoot 'server/AigcHub.Api'))
Invoke-Docker @('build', '--platform', 'linux/amd64', '--build-arg', "NEXT_PUBLIC_API_BASE_URL=$publicApiUrl", '-t', $portalImage, (Join-Path $repoRoot 'portal'))
Invoke-Docker @('pull', '--platform', 'linux/amd64', 'nginx:1.27-alpine')
Invoke-Docker @('tag', 'nginx:1.27-alpine', $nginxImage)
Invoke-Docker @('tag', 'postgres:17-alpine', $postgresImage)

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Invoke-Docker @('save', '--platform', 'linux/amd64', '-o', $tarPath, $apiImage, $portalImage, $nginxImage, $postgresImage)
Get-FileHash -Algorithm SHA256 -Path $tarPath | Format-List
Get-Item $tarPath | Select-Object FullName, Length
