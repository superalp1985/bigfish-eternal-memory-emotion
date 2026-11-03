param([string]$Current)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$Dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$Dialog.Description = 'BigFish Eternal Memory & Emotion - Choose memory folder'
$Dialog.ShowNewFolderButton = $true
if ($Current -and (Test-Path -LiteralPath $Current)) { $Dialog.SelectedPath = $Current }
try {
  if ($Dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $Selected = $Dialog.SelectedPath
    if ($Selected -ne $Current -and (Get-ChildItem -LiteralPath $Selected -Force | Select-Object -First 1)) {
      $Selected = Join-Path $Selected 'BigFish-Memories'
      if ((Test-Path -LiteralPath $Selected) -and (Get-ChildItem -LiteralPath $Selected -Force | Select-Object -First 1)) {
        $Selected += '-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
      }
    }
    [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Selected))
  }
} finally { $Dialog.Dispose() }
