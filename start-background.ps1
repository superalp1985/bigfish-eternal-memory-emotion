param([int]$Port = 0)
$ErrorActionPreference = 'Stop'
$LaunchConfig = Join-Path $PSScriptRoot 'runtime\launch.json'
if ($Port -eq 0) {
  $Port = if (Test-Path -LiteralPath $LaunchConfig) { (Get-Content -LiteralPath $LaunchConfig -Raw | ConvertFrom-Json).port } else { 5196 }
}
$StorageConfig = Join-Path $PSScriptRoot 'runtime\storage.json'
$StorageRoot = if (Test-Path -LiteralPath $StorageConfig) { (Get-Content -LiteralPath $StorageConfig -Raw | ConvertFrom-Json).root } else { Join-Path $PSScriptRoot 'data' }
try {
  $Existing = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/bootstrap" -TimeoutSec 2
  if ($Existing.project -eq $PSScriptRoot -or $Existing.root -eq $StorageRoot) {
    Write-Output "BigFish is already running at http://127.0.0.1:$Port."
    return
  }
} catch {}
for ($Attempt = 0; $Attempt -lt 20; $Attempt++) {
  $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  try { $Listener.Start(); break }
  catch { $Port++ }
  finally { $Listener.Stop() }
}
[System.IO.File]::WriteAllText($LaunchConfig, (@{port=$Port} | ConvertTo-Json -Compress))
$ShellPath = (Get-Process -Id $PID).Path
$Arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'background-runner.ps1'), '-Port', [string]$Port)
$ServerProcess = Start-Process -FilePath $ShellPath -ArgumentList $Arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
Write-Output "BigFish is starting at http://127.0.0.1:$Port (launcher process $($ServerProcess.Id))."
