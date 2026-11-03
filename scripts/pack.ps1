param([Parameter(Mandatory=$true)][string]$Manifest, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Entries = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$Stream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::CreateNew)
$Zip = New-Object System.IO.Compression.ZipArchive($Stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($Entry in $Entries) {
    $Source = Get-Item -LiteralPath $Entry.source -Force
    if ($Source.PSIsContainer) {
      $Prefix = $Source.FullName.TrimEnd('\') + '\'
      foreach ($File in Get-ChildItem -LiteralPath $Source.FullName -File -Recurse -Force) {
        if ($File.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
        $Relative = $File.FullName.Substring($Prefix.Length).Replace('\', '/')
        if ($Relative -match '(^|/)(\.git|\.cache|\.npmrc|\.env|credential\.dpapi)(/|$)') { continue }
        $Name = $Entry.target.TrimEnd('/') + '/' + $Relative
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Zip, $File.FullName, $Name, [System.IO.Compression.CompressionLevel]::Fastest) | Out-Null
      }
    } else {
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Zip, $Source.FullName, $Entry.target, [System.IO.Compression.CompressionLevel]::Fastest) | Out-Null
    }
  }
} finally { $Zip.Dispose(); $Stream.Dispose() }
