@echo off
setlocal EnableDelayedExpansion

REM === Redbook Install Wrapper ===
REM Called by Inno Setup. Receives two arguments:
REM   %1 = Install directory (e.g., C:\Users\X\AppData\Local\Redbook)
REM   %2 = Path to install_helpers.ps1 (in Inno's {tmp} dir)

set "INSTALL_DIR=%~1"
set "PS_SCRIPT=%~2"
set "LOG_FILE=%INSTALL_DIR%\_install.log"

REM -- Pre-flight: log before touching PowerShell at all --
echo [%DATE% %TIME%] install_wrapper.cmd started >> "%LOG_FILE%"
echo [%DATE% %TIME%] INSTALL_DIR=%INSTALL_DIR% >> "%LOG_FILE%"
echo [%DATE% %TIME%] PS_SCRIPT=%PS_SCRIPT% >> "%LOG_FILE%"
echo [%DATE% %TIME%] USERNAME=%USERNAME% >> "%LOG_FILE%"
echo [%DATE% %TIME%] OS=%OS% PROCESSOR_ARCHITECTURE=%PROCESSOR_ARCHITECTURE% >> "%LOG_FILE%"

REM -- Verify the PS script file exists --
if not exist "%PS_SCRIPT%" (
    echo [%DATE% %TIME%] FATAL: PS script not found at: %PS_SCRIPT% >> "%LOG_FILE%"
    echo.
    echo ============================================================
    echo  ERROR: PowerShell script not found!
    echo  Expected: %PS_SCRIPT%
    echo  This is an installer bug. Please report it.
    echo ============================================================
    echo.
    echo Press any key to close...
    pause >nul
    exit /b 1
)
echo [%DATE% %TIME%] PS script found, size=%~z2 bytes >> "%LOG_FILE%"

REM -- Check PowerShell is available --
where powershell.exe >nul 2>&1
if errorlevel 1 (
    echo [%DATE% %TIME%] FATAL: powershell.exe not found in PATH >> "%LOG_FILE%"
    echo.
    echo ============================================================
    echo  ERROR: PowerShell not found on this system!
    echo ============================================================
    echo.
    pause >nul
    exit /b 1
)

REM -- Query PowerShell version for diagnostics --
for /f "tokens=*" %%v in ('powershell.exe -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"') do (
    echo [%DATE% %TIME%] PowerShell version: %%v >> "%LOG_FILE%"
)

REM -- Query execution policy for diagnostics --
for /f "tokens=*" %%p in ('powershell.exe -NoProfile -Command "Get-ExecutionPolicy"') do (
    echo [%DATE% %TIME%] ExecutionPolicy: %%p >> "%LOG_FILE%"
)

echo [%DATE% %TIME%] Launching PowerShell... >> "%LOG_FILE%"

REM -- Signal to PS script that wrapper is managing the window --
set "REDBOOK_WRAPPER=1"

REM -- Run the PowerShell script --
REM   -NoProfile: skip profile scripts
REM   -ExecutionPolicy Bypass: override machine policy
REM   No -NonInteractive: let errors display instead of silently crashing
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" "%INSTALL_DIR%"
set PS_EXIT=%ERRORLEVEL%

echo [%DATE% %TIME%] PowerShell exited with code: %PS_EXIT% >> "%LOG_FILE%"

REM -- If PS failed, keep window open so user can see the error --
if not "%PS_EXIT%"=="0" (
    echo.
    echo ============================================================
    echo  PowerShell exited with error code: %PS_EXIT%
    echo  Log file: %LOG_FILE%
    echo ============================================================
    echo.
    echo Press any key to close...
    pause >nul
)

exit /b %PS_EXIT%
