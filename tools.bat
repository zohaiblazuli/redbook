@echo off
setlocal EnableDelayedExpansion

title Redbook Tools

set "LOGFILE=%LOCALAPPDATA%\Redbook\_tools.log"
set "PSSCRIPT=%~dp0tools.ps1"

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

if "%CHOICE%"=="4" goto :END
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

if not exist "%PSSCRIPT%" (
    echo  [ERROR] tools.ps1 not found at: %PSSCRIPT%
    echo  Make sure tools.ps1 is in the same folder as tools.bat.
    goto :END
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PSSCRIPT%" -Action %CHOICE% -LogFile "%LOGFILE%"
set "PSERR=%ERRORLEVEL%"

echo.
if "%PSERR%"=="0" (
    echo  [OK] Completed successfully.
) else (
    echo  [!!] Errors occurred. See output above.
)
echo  Log: %LOGFILE%

:END
echo.
echo  Press any key to close...
pause >nul
exit /b 0
