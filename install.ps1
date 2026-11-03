param([string]$StorageRoot, [switch]$NoPicker, [switch]$NoAutostart, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$BundledRuntime = Join-Path $ProjectRoot 'runtime'
$Profile = Join-Path $BundledRuntime 'dsh\profiles\fame-memory'
$DshRoot = if (Test-Path -LiteralPath (Join-Path $BundledRuntime 'node\node.exe')) { $BundledRuntime } else { 'D:\AI\DeepSeekHarness' }
$Node = Join-Path $DshRoot 'node\node.exe'
if (-not (Test-Path -LiteralPath $Node) -or
    -not (Test-Path -LiteralPath (Join-Path $DshRoot 'app\node_modules\@deepseek-ai\dsh\lib\bin.js')) -or
    -not (Test-Path -LiteralPath (Join-Path $Profile 'cordis.patch.yml')) -or
    -not (Test-Path -LiteralPath (Join-Path $Profile 'node_modules\dsh-dafeiyu\package.json'))) {
  & (Join-Path $ProjectRoot 'scripts\setup-runtime.ps1')
  $DshRoot = if (Test-Path -LiteralPath (Join-Path $BundledRuntime 'node\node.exe')) { $BundledRuntime } else { 'D:\AI\DeepSeekHarness' }
  $Node = Join-Path $DshRoot 'node\node.exe'
}
$StorageConfig = Join-Path $ProjectRoot 'runtime\storage.json'
if (-not $StorageRoot) {
  if (Test-Path -LiteralPath $StorageConfig) { $StorageRoot = (Get-Content -LiteralPath $StorageConfig -Raw | ConvertFrom-Json).root }
  else { $StorageRoot = Join-Path $ProjectRoot 'data' }
}
if (-not $NoPicker) {
  $Choice = & (Join-Path $ProjectRoot 'scripts\choose-folder.ps1') -Current $StorageRoot
  if (-not $Choice) { return }
  $StorageRoot = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Choice))
}
if (-not [System.IO.Path]::IsPathRooted($StorageRoot)) { throw 'Choose an absolute local memory folder.' }
$env:TEMP = Join-Path $ProjectRoot 'runtime\tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$Modules = Join-Path $ProjectRoot 'node_modules'
if (-not (Test-Path -LiteralPath $Modules)) {
  New-Item -ItemType Junction -Path $Modules -Target (Join-Path $DshRoot 'app\node_modules') | Out-Null
}
$PluginLink = Join-Path $ProjectRoot 'runtime\dsh\profiles\fame-memory\node_modules\bigfish-eternal-memory-emotion'
if (-not (Test-Path -LiteralPath $PluginLink)) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $PluginLink) -Force | Out-Null
  New-Item -ItemType Junction -Path $PluginLink -Target $ProjectRoot | Out-Null
}
& $Node (Join-Path $ProjectRoot 'scripts\restore-transfer.mjs') $StorageRoot
if ($LASTEXITCODE -ne 0) { throw 'Memory restoration did not complete.' }
$CredentialFile = Join-Path $ProjectRoot 'runtime\credential.dpapi'
$LocalCredential = Join-Path $ProjectRoot 'runtime\credential-local.aes'
if (-not (Test-Path -LiteralPath $CredentialFile) -and -not (Test-Path -LiteralPath $LocalCredential)) {
  $ApiKey = $env:DEEPSEEK_API_KEY
  if (-not $ApiKey) {
    $Secret = Read-Host 'DeepSeek API key (installation only)' -AsSecureString
    $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
    try { $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer) }
  }
  if (-not $ApiKey) { throw 'A DeepSeek API key is required.' }
  Add-Type -AssemblyName System.Security
  $KeyBytes = [System.Text.Encoding]::UTF8.GetBytes($ApiKey)
  try {
    try {
      $ProtectedBytes = [System.Security.Cryptography.ProtectedData]::Protect($KeyBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      [System.IO.File]::WriteAllBytes($CredentialFile, $ProtectedBytes)
    } catch [System.Security.Cryptography.CryptographicException] {
      $PreviousKey = $env:DEEPSEEK_API_KEY
      try {
        $env:DEEPSEEK_API_KEY = $ApiKey
        & $Node (Join-Path $ProjectRoot 'scripts\local-credential.mjs') store
        if ($LASTEXITCODE -ne 0) { throw 'Local model connection could not be saved.' }
      } finally { $env:DEEPSEEK_API_KEY = $PreviousKey }
    }
  } finally { [Array]::Clear($KeyBytes, 0, $KeyBytes.Length); $ApiKey = $null }
}
if (-not $NoAutostart) {
  $Startup = [Environment]::GetFolderPath('Startup')
  $Wsh = New-Object -ComObject WScript.Shell
  $LocalLink = Join-Path $ProjectRoot 'runtime\BigFish Eternal Memory.lnk'
  $Link = $Wsh.CreateShortcut($LocalLink)
  $Link.TargetPath = Join-Path $PSHOME 'powershell.exe'
  $Link.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $ProjectRoot 'start-background.ps1') + '"'
  $Link.WorkingDirectory = $ProjectRoot
  $Link.WindowStyle = 7
  $Link.Save()
  Copy-Item -LiteralPath $LocalLink -Destination (Join-Path $Startup 'BigFish Eternal Memory.lnk') -Force
}
if (-not $NoLaunch) {
  & (Join-Path $ProjectRoot 'start-background.ps1')
  $LaunchConfig = Join-Path $ProjectRoot 'runtime\launch.json'
  $Port = if (Test-Path -LiteralPath $LaunchConfig) { (Get-Content -LiteralPath $LaunchConfig -Raw | ConvertFrom-Json).port } else { 5196 }
  Start-Process "http://127.0.0.1:$Port/"
}
Write-Output 'BigFish Eternal Memory & Emotion installed.'
