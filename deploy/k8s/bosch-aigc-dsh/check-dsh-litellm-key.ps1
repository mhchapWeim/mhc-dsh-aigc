param(
    [string]$AigcBaseUrl = 'https://aigcbackend.boschhuayu-steering.com',
    [string]$Model = 'DeepSeek-V4-Flash',
    [switch]$UseAccessToken,
    [switch]$CompareKey
)

$ErrorActionPreference = 'Stop'

function Read-Secret([string]$Prompt) {
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $secure.Dispose()
    }
}

function Get-Fingerprint([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')
    }
    finally {
        $sha.Dispose()
    }
}

$aigcToken = $null
$password = $null
$issuedKey = $null
$expectedKey = $null

try {
    $root = $AigcBaseUrl.TrimEnd('/')
    $uri = [Uri]$root
    if ($uri.Scheme -ne 'https' -and $uri.Host -notin @('localhost', '127.0.0.1', '::1')) {
        throw 'AIGC 地址必须使用 HTTPS（仅本机测试允许 HTTP）。'
    }

    if ($UseAccessToken) {
        $aigcToken = Read-Secret '输入 DSH 的 AIGC access_token（不会显示）'
    }
    else {
        $credential = Get-Credential -Message '请输入与 DSH 相同的 AIGC 用户名和密码'
        if ($null -eq $credential) { throw '已取消输入凭据。' }
        $password = $credential.GetNetworkCredential().Password
        $body = @{ username = $credential.UserName; password = $password } | ConvertTo-Json -Compress
        $login = Invoke-RestMethod -Uri "$root/v1/auth/login" -Method Post `
            -ContentType 'application/json' -Body $body -TimeoutSec 20
        $aigcToken = $login.access_token
        $body = $null
        $login = $null
        $password = $null
        $credential = $null
    }

    if ([string]::IsNullOrWhiteSpace($aigcToken)) { throw '没有取得 AIGC access_token。' }
    $catalog = Invoke-RestMethod -Uri "$root/v1/models" -Method Get `
        -Headers @{ Authorization = "Bearer $aigcToken" } -TimeoutSec 20

    $models = @($catalog.models | ForEach-Object { $_.id })
    Write-Output "AIGC 可见模型数: $($models.Count)"
    Write-Output "目标模型 $Model : $($Model -cin $models)"
    if ($catalog.notice) { Write-Output "AIGC 提示: $($catalog.notice)" }

    $issuedKey = $catalog.connection.apiKey
    if ([string]::IsNullOrWhiteSpace($issuedKey)) {
        Write-Output 'AIGC 没有返回 LiteLLM 虚拟 Key；请先处理上面的提示或模型授权。'
        return
    }

    $liteLlmBase = [string]$catalog.connection.baseURL
    Write-Output "DSH 收到的 LiteLLM 地址: $liteLlmBase"
    Write-Output "DSH 收到的虚拟 Key SHA256: $(Get-Fingerprint $issuedKey)"

    if ($CompareKey) {
        $expectedKey = Read-Secret '输入新 LiteLLM 虚拟 Key 以比较（不会显示）'
        Write-Output "与输入的新 Key 一致: $([string]::Equals($issuedKey, $expectedKey, [StringComparison]::Ordinal))"
    }

    if ([string]::IsNullOrWhiteSpace($liteLlmBase)) { return }
    try {
        $liteLlmModels = Invoke-RestMethod -Uri "$($liteLlmBase.TrimEnd('/'))/models" -Method Get `
            -Headers @{ Authorization = "Bearer $issuedKey" } -TimeoutSec 20
        $allowed = @($liteLlmModels.data | ForEach-Object { $_.id })
        Write-Output '新 LiteLLM 使用此 Key 查询 /models: 成功'
        Write-Output "此 Key 可见目标模型 $Model : $($Model -cin $allowed)"
    }
    catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { '无 HTTP 响应' }
        Write-Output "LiteLLM /models 查询失败，状态: $status"
    }
}
finally {
    $aigcToken = $null
    $password = $null
    $issuedKey = $null
    $expectedKey = $null
    $body = $null
    $login = $null
    $catalog = $null
    $credential = $null
}
