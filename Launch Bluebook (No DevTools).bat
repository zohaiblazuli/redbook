@echo off
cd /d "%~dp0"
echo Launching Bluebook with NO DevTools and NO mods.
echo Testing hypothesis: DevTools detection is locking out login.
echo.
"G:\redbook\analysis\node_modules\.bin\electron.cmd" _run_safe_nodt.js
