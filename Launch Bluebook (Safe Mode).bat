@echo off
cd /d "%~dp0"
echo Launching Bluebook in SAFE MODE (no dev panel, no theme switcher).
echo This is the bare-bones launcher to test whether login itself is broken.
echo.
"G:\redbook\analysis\node_modules\.bin\electron.cmd" _run_safe.js
