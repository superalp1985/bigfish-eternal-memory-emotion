param([switch]$Bundled)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $ProjectRoot 'runtime'
$DshRoot = $Runtime
New-Item -ItemType Directory -Path $Runtime -Force | Out-Null
$env:TEMP = Join-Path $Runtime 'tmp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $Runtime 'npm-cache'
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$Node = Join-Path $DshRoot 'node\node.exe'
if (-not (Test-Path -LiteralPath $Node)) {
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'BigFish requires 64-bit Windows.' }
  $Version = '24.22.1'
  $Zip = Join-Path $env:TEMP "node-v$Version-win-x64.zip"
  $Url = "https://nodejs.org/dist/v$Version/node-v$Version-win-x64.zip"
  Write-Host 'Downloading the verified Node runtime into the installation folder...'
  $Curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($Curl) {
    & $Curl.Source --fail --location --retry 2 --silent --show-error --output $Zip $Url
    if ($LASTEXITCODE -ne 0) { throw 'Node download failed. Check your connection and run Install.cmd again.' }
  } else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing
  }
  $ExpectedHash = 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5'
  if ((Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedHash) {
    throw 'Node download checksum mismatch. Run Install.cmd again to download a fresh copy.'
  }
  $Extract = Join-Path $env:TEMP ('node-unpack-' + [guid]::NewGuid().ToString('N'))
  Expand-Archive -LiteralPath $Zip -DestinationPath $Extract
  $Extracted = Join-Path $Extract "node-v$Version-win-x64"
  New-Item -ItemType Directory -Path (Join-Path $Runtime 'node') -Force | Out-Null
  Get-ChildItem -LiteralPath $Extracted -Force | Copy-Item -Destination (Join-Path $Runtime 'node') -Recurse -Force
  $CheckedExtract = [IO.Path]::GetFullPath($Extract)
  $CheckedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
  if (-not $CheckedExtract.StartsWith($CheckedTemp, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unexpected runtime extraction path.'
  }
  Remove-Item -LiteralPath $CheckedExtract -Recurse -Force
  Remove-Item -LiteralPath $Zip -Force
}
$env:PATH = (Join-Path $DshRoot 'node') + ';' + $env:PATH
$Npm = Join-Path $DshRoot 'node\node_modules\npm\bin\npm-cli.js'
$Cli = Join-Path $DshRoot 'app\node_modules\@deepseek-ai\dsh\lib\bin.js'
$InstalledVersion = if (Test-Path -LiteralPath (Join-Path $DshRoot 'app\node_modules\@deepseek-ai\dsh\package.json')) {
  (Get-Content -LiteralPath (Join-Path $DshRoot 'app\node_modules\@deepseek-ai\dsh\package.json') -Raw | ConvertFrom-Json).version
} else { $null }
if (-not (Test-Path -LiteralPath $Cli) -or $InstalledVersion -ne '0.2.2-alpha.3') {
  Write-Host 'Installing the project-private DeepSeek Harness 0.2.2-alpha.3...'
  $App = Join-Path $Runtime 'app'
  New-Item -ItemType Directory -Path $App -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $ProjectRoot 'config\runtime-package.json') -Destination (Join-Path $App 'package.json') -Force
  & $Node $Npm install --prefix $App --omit=dev --no-audit --no-fund | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'DSH installation failed. Run Install.cmd again to retry.' }
}
$Profile = Join-Path $Runtime 'dsh\profiles\fame-memory'
New-Item -ItemType Directory -Path $Profile -Force | Out-Null
foreach ($Name in @('package.json', 'cordis.patch.yml')) {
  $Destination = Join-Path $Profile $Name
  Copy-Item -LiteralPath (Join-Path $ProjectRoot "config\profile\$Name") -Destination $Destination -Force
}
$CompanionVersion = if (Test-Path -LiteralPath (Join-Path $Profile 'node_modules\dsh-dafeiyu\package.json')) {
  (Get-Content -LiteralPath (Join-Path $Profile 'node_modules\dsh-dafeiyu\package.json') -Raw | ConvertFrom-Json).version
} else { $null }
if ($CompanionVersion -ne '0.1.23') {
  Write-Host 'Installing the BigFish companion...'
  & $Node $Npm install --prefix $Profile --omit=dev --no-audit --no-fund | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Companion installation failed. Run Install.cmd again to retry.' }
}
$Modules = Join-Path $ProjectRoot 'node_modules'
$DesiredModules = Join-Path $DshRoot 'app\node_modules'
if (Test-Path -LiteralPath $Modules) {
  $Item = Get-Item -LiteralPath $Modules -Force
  if (-not ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Project node_modules exists but is not the managed runtime link. Move it aside and rerun Install.cmd.'
  }
  if ([IO.Path]::GetFullPath([string]$Item.Target) -ne [IO.Path]::GetFullPath($DesiredModules)) {
    Remove-Item -LiteralPath $Modules -Force
  }
}
if (-not (Test-Path -LiteralPath $Modules)) {
  New-Item -ItemType Junction -Path $Modules -Target $DesiredModules | Out-Null
}
$Plugin = Join-Path $Profile 'node_modules\bigfish-eternal-memory-emotion'
if (-not (Test-Path -LiteralPath $Plugin)) {
  New-Item -ItemType Junction -Path $Plugin -Target $ProjectRoot | Out-Null
}
Write-Host 'BigFish runtime is ready.'
