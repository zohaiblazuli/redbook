[Setup]
AppName=Redbook
AppVersion=0.9.7
AppPublisher=Redbook
DefaultDirName={localappdata}\Redbook
DefaultGroupName=Redbook
UninstallDisplayIcon={app}\media\logo.ico
OutputDir=Output
OutputBaseFilename=RedbookSetup
SetupIconFile=..\media\logo.ico
Compression=lzma2/max
SolidCompression=yes
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
WizardStyle=modern

[Files]
; Wrapper launcher
Source: "Redbook.exe"; DestDir: "{app}"; Flags: ignoreversion

; Core launcher scripts
Source: "..\_run.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\_run_safe.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\_run_safe_nodt.js"; DestDir: "{app}"; Flags: ignoreversion

; Version metadata
Source: "..\version.json"; DestDir: "{app}"; Flags: ignoreversion

; Mod files
Source: "..\mods\redbook.css"; DestDir: "{app}\mods"; Flags: ignoreversion
Source: "..\mods\switcher.js"; DestDir: "{app}\mods"; Flags: ignoreversion
Source: "..\mods\devpanel.js"; DestDir: "{app}\mods"; Flags: ignoreversion

; Media (provider logos + app icon)
Source: "..\media\Claude_AI_symbol.svg.webp"; DestDir: "{app}\media"; Flags: ignoreversion
Source: "..\media\Google_Gemini_icon_2025.svg.png"; DestDir: "{app}\media"; Flags: ignoreversion
Source: "..\media\ChatGPT-Logo.png"; DestDir: "{app}\media"; Flags: ignoreversion
Source: "..\media\logo.ico"; DestDir: "{app}\media"; Flags: ignoreversion

; Post-install helper
Source: "install_helpers.ps1"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Dirs]
Name: "{app}\mods\sessions"
Name: "{app}\mods\recordings"
Name: "{app}\resources"
Name: "{app}\electron"

[Icons]
Name: "{userdesktop}\Redbook"; Filename: "{app}\Redbook.exe"; WorkingDir: "{app}"; IconFilename: "{app}\media\logo.ico"

[Run]
; Download Electron + locate app.asar
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{tmp}\install_helpers.ps1"" ""{app}"""; StatusMsg: "Downloading Electron and configuring Redbook..."; Flags: runhidden waituntilterminated

; Option to launch after install
Filename: "{app}\Redbook.exe"; Description: "Launch Redbook"; Flags: postinstall skipifsilent nowait

[UninstallDelete]
Type: filesandordirs; Name: "{app}\electron"
Type: filesandordirs; Name: "{app}\mods\sessions"
Type: filesandordirs; Name: "{app}\mods\recordings"
Type: files; Name: "{app}\_run.log"
Type: files; Name: "{app}\_inspect.txt"
Type: files; Name: "{app}\_bg_dump.txt"
