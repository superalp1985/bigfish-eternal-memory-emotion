param([int]$Port = 5196, [string]$MemoryRoot, [string]$Patch)
$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$BundledRuntime = Join-Path $ProjectRoot 'runtime'
$Profile = Join-Path $BundledRuntime 'dsh\profiles\fame-memory'
$InstalledDsh = if (Test-Path -LiteralPath (Join-Path $BundledRuntime 'app\node_modules\@deepseek-ai\dsh\package.json')) {
  (Get-Content -LiteralPath (Join-Path $BundledRuntime 'app\node_modules\@deepseek-ai\dsh\package.json') -Raw | ConvertFrom-Json).version
} else { $null }
$InstalledCompanion = if (Test-Path -LiteralPath (Join-Path $Profile 'node_modules\dsh-dafeiyu\package.json')) {
  (Get-Content -LiteralPath (Join-Path $Profile 'node_modules\dsh-dafeiyu\package.json') -Raw | ConvertFrom-Json).version
} else { $null }
if (-not (Test-Path -LiteralPath (Join-Path $BundledRuntime 'node\node.exe')) -or
    $InstalledDsh -ne '0.2.2-alpha.3' -or
    $InstalledCompanion -ne '0.1.23' -or
    -not (Test-Path -LiteralPath (Join-Path $BundledRuntime 'app\node_modules\@deepseek-ai\dsh\lib\bin.js'))) {
  & (Join-Path $ProjectRoot 'scripts\setup-runtime.ps1')
}
$DshRoot = $BundledRuntime
$env:BIGFISH_DSH_ROOT = $DshRoot
$env:BIGFISH_PLUGIN_PATH = (Join-Path $ProjectRoot 'src\plugin.mjs').Replace('\', '/')
$env:DSH_HOME = Join-Path $ProjectRoot 'runtime\dsh'
$env:HOME = Join-Path $ProjectRoot 'runtime\home'
$env:APPDATA = Join-Path $ProjectRoot 'runtime\appdata'
$env:LOCALAPPDATA = Join-Path $ProjectRoot 'runtime\localappdata'
$env:XDG_CONFIG_HOME = Join-Path $ProjectRoot 'runtime\config'
$env:XDG_CACHE_HOME = Join-Path $ProjectRoot 'runtime\cache'
$env:XDG_DATA_HOME = Join-Path $ProjectRoot 'runtime\share'
$env:XDG_STATE_HOME = Join-Path $ProjectRoot 'runtime\state'
$env:TEMP = Join-Path $ProjectRoot 'runtime\tmp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:npm_config_cache = Join-Path $ProjectRoot 'runtime\npm-cache'
$env:FAME_MEMORY_PORT = [string]$Port
$StorageConfig = Join-Path $ProjectRoot 'runtime\storage.json'
$SavedRoot = if (Test-Path -LiteralPath $StorageConfig) { (Get-Content -LiteralPath $StorageConfig -Raw | ConvertFrom-Json).root } else { Join-Path $ProjectRoot 'data' }
if (-not $MemoryRoot -and (Test-Path -LiteralPath $StorageConfig) -and -not (Test-Path -LiteralPath $SavedRoot)) {
  throw 'The selected memory drive is unavailable. BigFish will retry automatically.'
}
$env:FAME_MEMORY_HOME = if ($MemoryRoot) { $MemoryRoot } else { $SavedRoot }
$env:DSH_DAFEIYU_WEBUI_URL = "http://127.0.0.1:$Port/"
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$KeyFile = Join-Path $DshRoot 'config\deepseek-api-key.txt'
$CredentialFile = Join-Path $ProjectRoot 'runtime\credential.dpapi'
if (-not $env:DEEPSEEK_API_KEY -and (Test-Path -LiteralPath $CredentialFile)) {
  Add-Type -AssemblyName System.Security
  $ProtectedBytes = [System.IO.File]::ReadAllBytes($CredentialFile)
  $KeyBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($ProtectedBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  $env:DEEPSEEK_API_KEY = [System.Text.Encoding]::UTF8.GetString($KeyBytes)
  [Array]::Clear($KeyBytes, 0, $KeyBytes.Length)
}
$LocalCredential = Join-Path $ProjectRoot 'runtime\credential-local.aes'
if (-not $env:DEEPSEEK_API_KEY -and (Test-Path -LiteralPath $LocalCredential)) {
  $env:DEEPSEEK_API_KEY = & (Join-Path $DshRoot 'node\node.exe') (Join-Path $ProjectRoot 'scripts\local-credential.mjs') read
  if ($LASTEXITCODE -ne 0) { throw 'The saved model connection could not be loaded.' }
}
if (-not $env:DEEPSEEK_API_KEY) {
  try {
    if (Test-Path -LiteralPath $KeyFile) {
      $env:DEEPSEEK_API_KEY = [System.IO.File]::ReadAllText($KeyFile).Trim()
    }
  } catch {
    Write-Warning 'The original DSH credential is not readable. Set DEEPSEEK_API_KEY before launching to enable model requests.'
  }
}
Set-Location -LiteralPath $ProjectRoot
$DshArguments = @('--profile', 'fame-memory')
if ($Patch) { $DshArguments += @('--patch', $Patch) }
& (Join-Path $DshRoot 'node\node.exe') (Join-Path $DshRoot 'app\node_modules\@deepseek-ai\dsh\lib\bin.js') @DshArguments
if ($LASTEXITCODE -ne 0) { Write-Warning "BigFish exited with code $LASTEXITCODE." }
