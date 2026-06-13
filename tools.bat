@echo off
setlocal EnableDelayedExpansion

REM === Redbook Desktop Integration Tool ===
REM Consolidates desktop shortcuts and extracts application icon.
REM No admin required — all paths are user-scoped.

echo.
echo  ====================================
echo   Redbook Desktop Integration Tool
echo  ====================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
^"^
Add-Type -AssemblyName System.Drawing;^
^
$srcPaths = @(^
  (Join-Path $env:LOCALAPPDATA 'Programs\bluebook\Bluebook.exe'),^
  (Join-Path $env:LOCALAPPDATA 'Programs\Bluebook\Bluebook.exe'),^
  (Join-Path $env:ProgramFiles 'College Board\Bluebook\Bluebook.exe')^
);^
^
$srcExe = $null;^
foreach ($p in $srcPaths) {^
  if (Test-Path $p) { $srcExe = $p; break }^
}^
^
if (-not $srcExe) {^
  Write-Host '[!] Source application not found. Checked:' -ForegroundColor Red;^
  foreach ($p in $srcPaths) { Write-Host ('    ' + $p) -ForegroundColor DarkGray };^
  Write-Host '';^
  Write-Host 'Install the source application first, then re-run this tool.' -ForegroundColor Yellow;^
  exit 1^
}^
Write-Host ('[OK] Source: ' + $srcExe) -ForegroundColor Green;^
^
$rbDir = Join-Path $env:LOCALAPPDATA 'Redbook';^
$rbExe = Join-Path $rbDir 'Redbook.exe';^
if (-not (Test-Path $rbExe)) {^
  Write-Host '[!] Redbook not found at:' $rbExe -ForegroundColor Red;^
  exit 1^
}^
Write-Host ('[OK] Redbook: ' + $rbExe) -ForegroundColor Green;^
^
$mediaDir = Join-Path $rbDir 'media';^
if (-not (Test-Path $mediaDir)) { New-Item -ItemType Directory -Path $mediaDir -Force | Out-Null }^
$icoPath = Join-Path $mediaDir 'bluebook.ico';^
try {^
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($srcExe);^
  $fs = [System.IO.File]::Create($icoPath);^
  $icon.Save($fs);^
  $fs.Close();^
  $icon.Dispose();^
  Write-Host ('[OK] Icon extracted: ' + $icoPath) -ForegroundColor Green^
} catch {^
  Write-Host ('[!] Icon extraction failed: ' + $_.Exception.Message) -ForegroundColor Red;^
  $icoPath = $srcExe + ',0'^
}^
^
$desktop = [Environment]::GetFolderPath('Desktop');^
$removed = @();^
foreach ($name in @('Bluebook.lnk', 'Redbook.lnk')) {^
  $lnk = Join-Path $desktop $name;^
  if (Test-Path $lnk) { Remove-Item $lnk -Force; $removed += $name }^
}^
if ($removed.Count -gt 0) {^
  Write-Host ('[OK] Removed: ' + ($removed -join ', ')) -ForegroundColor Green^
} else {^
  Write-Host '[--] No existing shortcuts to remove' -ForegroundColor DarkGray^
}^
^
$sh = New-Object -ComObject WScript.Shell;^
$lnk = $sh.CreateShortcut((Join-Path $desktop 'Bluebook.lnk'));^
$lnk.TargetPath = $rbExe;^
$lnk.WorkingDirectory = $rbDir;^
$lnk.IconLocation = $icoPath;^
$lnk.Description = 'The Bluebook App';^
$lnk.Save();^
Write-Host ('[OK] Created: Bluebook.lnk -> ' + $rbExe) -ForegroundColor Green;^
Write-Host ('     Icon: ' + $icoPath) -ForegroundColor DarkGray;^
^
Write-Host '';^
Write-Host '  Done. Desktop consolidated.' -ForegroundColor Cyan;^
Write-Host '';"

echo.
echo  Press any key to close...
pause >nul
