param(
    [Parameter(Mandatory = $true)][string]$Registry,
    [Parameter(Mandatory = $true)][string]$Tag,
    [switch]$Push
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$registryName = $Registry.TrimEnd('/')
$apiImage = "$registryName/aigc-api`:$Tag"
$portalImage = "$registryName/aigc-portal`:$Tag"
$publicApiUrl = 'https://aigcbackend.boschhuayu-steering.com'

if ($Registry -match 'REPLACE|example' -or $Tag -match 'REPLACE|example') {
    throw 'Provide the actual registry and immutable image tag.'
}

docker build --pull -t $apiImage (Join-Path $repoRoot 'server/AigcHub.Api')
if ($LASTEXITCODE -ne 0) { throw 'API image build failed.' }

docker build --pull --build-arg "NEXT_PUBLIC_API_BASE_URL=$publicApiUrl" -t $portalImage (Join-Path $repoRoot 'portal')
if ($LASTEXITCODE -ne 0) { throw 'Portal image build failed.' }

if ($Push) {
    docker push $apiImage
    if ($LASTEXITCODE -ne 0) { throw 'API image push failed.' }
    docker push $portalImage
    if ($LASTEXITCODE -ne 0) { throw 'Portal image push failed.' }
}

Write-Output "API: $apiImage"
Write-Output "Portal: $portalImage"
Write-Output "Portal build-time API URL: $publicApiUrl"
