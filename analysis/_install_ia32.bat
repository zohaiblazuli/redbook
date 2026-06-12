@echo off
set npm_config_arch=ia32
set npm_config_target_arch=ia32
npm install electron@^39.0.0 --arch=ia32 --no-save --no-audit --no-fund --loglevel=error
echo INSTALL_EXIT=%ERRORLEVEL%
node_modules\.bin\electron.cmd --version
