param([int]$Port = 5196)
$LogRoot = Join-Path $PSScriptRoot 'runtime'
$LockPath = Join-Path $LogRoot 'service.lock'
try { $Lock = [System.IO.File]::Open($LockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
catch { return }
try {
  while ($true) {
    foreach ($Name in @('server.stdout.log', 'server.stderr.log')) {
      $LogFile = Join-Path $LogRoot $Name
      if ((Test-Path -LiteralPath $LogFile) -and (Get-Item -LiteralPath $LogFile).Length -gt 5MB) {
        Move-Item -LiteralPath $LogFile -Destination ($LogFile + '.previous') -Force
      }
    }
    try {
      & (Join-Path $PSScriptRoot 'start.ps1') -Port $Port 1>> (Join-Path $LogRoot 'server.stdout.log') 2>> (Join-Path $LogRoot 'server.stderr.log')
    } catch { $_ | Out-File -LiteralPath (Join-Path $LogRoot 'server.stderr.log') -Append -Encoding UTF8 }
    Start-Sleep -Seconds 5
  }
} finally { $Lock.Dispose() }
