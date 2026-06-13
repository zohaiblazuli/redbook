@echo off
setlocal EnableDelayedExpansion

title Redbook Tools

REM === Redbook Desktop Integration Tool ===

set "LOGFILE=%LOCALAPPDATA%\Redbook\_tools.log"
set "PSSCRIPT=%TEMP%\redbook_tools_%RANDOM%.ps1"

:MENU
cls
echo.
echo  ========================================
echo   Redbook Desktop Integration Tool
echo  ========================================
echo.
echo   [1] Full setup (extract icon + update shortcuts)
echo   [2] Extract icon only
echo   [3] Update shortcuts only
echo   [4] Exit
echo.
set /p "CHOICE=  Select option (1-4): "

if "%CHOICE%"=="4" goto :CLEANUP
if "%CHOICE%"=="1" goto :RUN
if "%CHOICE%"=="2" goto :RUN
if "%CHOICE%"=="3" goto :RUN

echo.
echo   Invalid choice. Try again.
timeout /t 2 /nobreak >nul
goto :MENU

:RUN
echo.
echo  Running...
echo.

REM ── Write the PowerShell script to a temp file (line by line, no block escaping) ──
if exist "%PSSCRIPT%" del /q "%PSSCRIPT%"

>> "%PSSCRIPT%" echo param([int]$Action, [string]$LogFile)
>> "%PSSCRIPT%" echo.
>> "%PSSCRIPT%" echo # ── Logging
>> "%PSSCRIPT%" echo function Write-Log {
>> "%PSSCRIPT%" echo     param([string]$Msg, [string]$Color = 'White')
>> "%PSSCRIPT%" echo     $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
>> "%PSSCRIPT%" echo     $line = "[$ts] $Msg"
>> "%PSSCRIPT%" echo     Write-Host $line -ForegroundColor $Color
>> "%PSSCRIPT%" echo     try { Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue } catch {}
>> "%PSSCRIPT%" echo }
>> "%PSSCRIPT%" echo.
>> "%PSSCRIPT%" echo # ── Find source application
>> "%PSSCRIPT%" echo function Find-SourceApp {
>> "%PSSCRIPT%" echo     $paths = @(
>> "%PSSCRIPT%" echo         (Join-Path $env:LOCALAPPDATA 'Programs\bluebook\Bluebook.exe'),
>> "%PSSCRIPT%" echo         (Join-Path $env:LOCALAPPDATA 'Programs\Bluebook\Bluebook.exe'),
>> "%PSSCRIPT%" echo         (Join-Path $env:ProgramFiles 'College Board\Bluebook\Bluebook.exe')
>> "%PSSCRIPT%" echo     )
>> "%PSSCRIPT%" echo     foreach ($p in $paths) {
>> "%PSSCRIPT%" echo         if (Test-Path $p) { return $p }
>> "%PSSCRIPT%" echo     }
>> "%PSSCRIPT%" echo     return $null
>> "%PSSCRIPT%" echo }
>> "%PSSCRIPT%" echo.
>> "%PSSCRIPT%" echo # ── Find Redbook
>> "%PSSCRIPT%" echo function Find-Redbook {
>> "%PSSCRIPT%" echo     $rbExe = Join-Path $env:LOCALAPPDATA 'Redbook\Redbook.exe'
>> "%PSSCRIPT%" echo     if (Test-Path $rbExe) { return $rbExe }
>> "%PSSCRIPT%" echo     return $null
>> "%PSSCRIPT%" echo }
>> "%PSSCRIPT%" echo.
>> "%PSSCRIPT%" echo # ── Extract icon
>> "%PSSCRIPT%" echo function Extract-AppIcon {
>> "%PSSCRIPT%" echo     param([string]$SourceExe, [string]$OutputDir)
>> "%PSSCRIPT%" echo     try {
>> "%PSSCRIPT%" echo         Add-Type -AssemblyName System.Drawing
>> "%PSSCRIPT%" echo         if (-not (Test-Path $OutputDir)) {
>> "%PSSCRIPT%" echo             New-Item -ItemType Directory -Path $OutputDir -Force ^| Out-Null
>> "%PSSCRIPT%" echo         }
>> "%PSSCRIPT%" echo         $outPath = Join-Path $OutputDir 'bluebook.ico'
>> "%PSSCRIPT%" echo         $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($SourceExe)
>> "%PSSCRIPT%" echo         $fs = [System.IO.File]::Create($outPath)
>> "%PSSCRIPT%" echo         $icon.Save($fs)
>> "%PSSCRIPT%" echo         $fs.Close()
>> "%PSSCRIPT%" echo         $icon.Dispose()
>> "%PSSCRIPT%" echo         Write-Log "[OK] Icon extracted to: $outPath" 'Green'
>> "%PSSCRIPT%" echo         return $outPath
>> "%PSSCRIPT%" echo     } catch {
>> "%PSSCRIPT%" echo         $errMsg = $_.Exception.Message
>> "%PSSCRIPT%" echo         Write-Log "[FAIL] Icon extraction failed: $errMsg" 'Red'
>> "%PSSCRIPT%" echo         return $null
>> "%PSSCRIPT%" echo     }
>> "%PSSCRIPT%" echo }
>> "%PSSCRIPT%" echo.
>> "%PSSCRIPT%" echo # ── Update shortcuts
>> "%PSSCRIPT%" echo function Update-Shortcuts {
>> "%PSSCRIPT%" echo     param([string]$RbExe, [string]$RbDir, [string]$IconPath)
>> "%PSSCRIPT%" echo     try {
>> "%PSSCRIPT%" echo         $desktop = [Environment]::GetFolderPath('Desktop')
>> "%PSSCRIPT%" echo         $removed = @()
>> "%PSSCRIPT%" echo         foreach ($name in @('Bluebook.lnk', 'Redbook.lnk')) {
>> "%PSSCRIPT%" echo             $lnkPath = Join-Path $desktop $name
>> "%PSSCRIPT%" echo             if (Test-Path $lnkPath) {
>> "%PSSCRIPT%" echo                 Remove-Item $lnkPath -Force
>> "%PSSCRIPT%" echo                 $removed += $name
>> "%PSSCRIPT%" echo                 Write-Log "[OK] Removed: $name" 'Green'
>> "%PSSCRIPT%" echo             }
>> "%PSSCRIPT%" echo         }
>> "%PSSCRIPT%" echo         if ($removed.Count -eq 0) {
>> "%PSSCRIPT%" echo             Write-Log "[--] No existing shortcuts to remove" 'DarkGray'
>> "%PSSCRIPT%" echo         }
>> "%PSSCRIPT%" echo.
>> "%PSSCRIPT%" echo         $sh = New-Object -ComObject WScript.Shell
>> "%PSSCRIPT%" echo         $lnk = $sh.CreateShortcut((Join-Path $desktop 'Bluebook.lnk'))
>> "%PSSCRIPT%" echo         $lnk.TargetPath = $RbExe
>> "%PSSCRIPT%" echo         $lnk.WorkingDirectory = $RbDir
>> "%PSSCRIPT%" echo         if ($IconPath) { $lnk.IconLocation = $IconPath }
>> "%PSSCRIPT%" echo         $lnk.Description = 'The Bluebook App'
>> "%PSSCRIPT%" echo         $lnk.Save()
>> "%PSSCRIPT%" echo         Write-Log "[OK] Created shortcut: Bluebook.lnk -> $RbExe" 'Green'
>> "%PSSCRIPT%" echo         if ($IconPath) { Write-Log "     Icon: $IconPath" 'DarkGray' }
>> "%PSSCRIPT%" echo         return $true
>> "%PSSCRIPT%" echo     } catch {
>> "%PSSCRIPT%" echo         $errMsg = $_.Exception.Message
>> "%PSSCRIPT%" echo         Write-Log "[FAIL] Shortcut update failed: $errMsg" 'Red'
>> "%PSSCRIPT%" echo         return $false
>> "%PSSCRIPT%" echo     }
>> "%PSSCRIPT%" echo }
>> "%PSSCRIPT%" echo.
>> "%PSSCRIPT%" echo # ── Main
>> "%PSSCRIPT%" echo Write-Log '=== Redbook Tools started ==='
>> "%PSSCRIPT%" echo Write-Log "Action: $Action"
>> "%PSSCRIPT%" echo.
>> "%PSSCRIPT%" echo $srcExe = Find-SourceApp
>> "%PSSCRIPT%" echo if (-not $srcExe) {
>> "%PSSCRIPT%" echo     Write-Log '[FAIL] Source application not found. Is it installed?' 'Red'
>> "%PSSCRIPT%" echo     Write-Log '       Checked known install locations.' 'DarkGray'
>> "%PSSCRIPT%" echo     exit 1
>> "%PSSCRIPT%" echo }
>> "%PSSCRIPT%" echo Write-Log "[OK] Source app: $srcExe" 'Green'
>> "%PSSCRIPT%" echo.
>> "%PSSCRIPT%" echo $rbExe = Find-Redbook
>> "%PSSCRIPT%" echo if (-not $rbExe) {
>> "%PSSCRIPT%" echo     Write-Log '[FAIL] Redbook not installed.' 'Red'
>> "%PSSCRIPT%" echo     exit 1
>> "%PSSCRIPT%" echo }
>> "%PSSCRIPT%" echo $rbDir = Split-Path $rbExe -Parent
>> "%PSSCRIPT%" echo Write-Log "[OK] Redbook: $rbExe" 'Green'
>> "%PSSCRIPT%" echo.
>> "%PSSCRIPT%" echo $mediaDir = Join-Path $rbDir 'media'
>> "%PSSCRIPT%" echo $icoPath = $null
>> "%PSSCRIPT%" echo.
>> "%PSSCRIPT%" echo if ($Action -eq 1 -or $Action -eq 2) {
>> "%PSSCRIPT%" echo     $icoPath = Extract-AppIcon -SourceExe $srcExe -OutputDir $mediaDir
>> "%PSSCRIPT%" echo }
>> "%PSSCRIPT%" echo.
>> "%PSSCRIPT%" echo if ($Action -eq 1 -or $Action -eq 3) {
>> "%PSSCRIPT%" echo     if (-not $icoPath) {
>> "%PSSCRIPT%" echo         $existingIco = Join-Path $mediaDir 'bluebook.ico'
>> "%PSSCRIPT%" echo         if (Test-Path $existingIco) { $icoPath = $existingIco }
>> "%PSSCRIPT%" echo     }
>> "%PSSCRIPT%" echo     Update-Shortcuts -RbExe $rbExe -RbDir $rbDir -IconPath $icoPath
>> "%PSSCRIPT%" echo }
>> "%PSSCRIPT%" echo.
>> "%PSSCRIPT%" echo Write-Log ''
>> "%PSSCRIPT%" echo Write-Log '=== Done ===' 'Cyan'

REM ── Execute the PowerShell script ───────────────────────────────────────────
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PSSCRIPT%" -Action %CHOICE% -LogFile "%LOGFILE%"
set "PSERR=%ERRORLEVEL%"

echo.
if "%PSERR%"=="0" (
    echo  [OK] Completed successfully.
) else (
    echo  [!!] Errors occurred. See output above.
)
echo  Log: %LOGFILE%

:CLEANUP
if exist "%PSSCRIPT%" del /q "%PSSCRIPT%" >nul 2>&1

echo.
echo  Press any key to close...
pause >nul
exit /b 0
