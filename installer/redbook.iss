[Setup]
AppName=Redbook
AppVersion=0.10.2
AppPublisher=Redbook
DefaultDirName={localappdata}\Redbook
DefaultGroupName=Redbook
UninstallDisplayName=Redbook v0.10.2
UninstallDisplayIcon={app}\media\logo.ico
OutputDir=Output
OutputBaseFilename=Redbook-v0.10.2-win32-setup
SetupIconFile=..\media\logo.ico
Compression=lzma2/max
SolidCompression=yes
PrivilegesRequired=admin
UsedUserAreasWarning=no
DisableDirPage=yes
DisableProgramGroupPage=yes
WizardStyle=modern
WizardImageFile=wizard.bmp
WizardSmallImageFile=wizard_small.bmp

[Files]
; Wrapper launcher
Source: "Redbook.exe"; DestDir: "{app}"; Flags: ignoreversion

; Core launcher scripts
Source: "..\_run.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\_run_safe.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\_run_safe_nodt.js"; DestDir: "{app}"; Flags: ignoreversion

; Version metadata
Source: "..\version.json"; DestDir: "{app}"; Flags: ignoreversion

; Desktop integration tool
Source: "..\tools.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\tools.ps1"; DestDir: "{app}"; Flags: ignoreversion

; Mod files
Source: "..\mods\redbook.css"; DestDir: "{app}\mods"; Flags: ignoreversion
Source: "..\mods\switcher.js"; DestDir: "{app}\mods"; Flags: ignoreversion
Source: "..\mods\devpanel.js"; DestDir: "{app}\mods"; Flags: ignoreversion

; Media (provider logos + app icon)
Source: "..\media\Claude_AI_symbol.svg.webp"; DestDir: "{app}\media"; Flags: ignoreversion
Source: "..\media\Google_Gemini_icon_2025.svg.png"; DestDir: "{app}\media"; Flags: ignoreversion
Source: "..\media\ChatGPT-Logo.png"; DestDir: "{app}\media"; Flags: ignoreversion
Source: "..\media\logo.ico"; DestDir: "{app}\media"; Flags: ignoreversion
Source: "..\media\bluebook.ico"; DestDir: "{app}\media"; Flags: ignoreversion

; Post-install wrapper and helper
Source: "install_wrapper.cmd"; DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "install_helpers.ps1"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Dirs]
Name: "{app}\mods\sessions"
Name: "{app}\mods\recordings"
Name: "{app}\resources"
Name: "{app}\electron"

[Icons]
Name: "{userdesktop}\Bluebook"; Filename: "{app}\Redbook.exe"; WorkingDir: "{app}"; IconFilename: "{app}\media\bluebook.ico"; Comment: "The Bluebook App"

[Run]
; Download Electron + locate app.asar (visible PS window so user sees download progress)
Filename: "{tmp}\install_wrapper.cmd"; Parameters: """{app}"" ""{tmp}\install_helpers.ps1"""; StatusMsg: "Downloading Electron runtime and configuring Redbook..."; Flags: waituntilterminated shellexec

; Option to launch after install (wizard mode -- shown as checkbox on Finish page)
Filename: "{app}\Redbook.exe"; Description: "Launch Redbook"; Flags: postinstall skipifsilent nowait

; Auto-relaunch after a silent install initiated from the CLI's /update install command
Filename: "{app}\Redbook.exe"; Flags: nowait runasoriginaluser; Check: ShouldAutoLaunch

[UninstallDelete]
; Electron runtime (downloaded at install, not tracked by Inno)
Type: filesandordirs; Name: "{app}\electron"
; Copied app.asar
Type: filesandordirs; Name: "{app}\resources"
; Session and recording data
Type: filesandordirs; Name: "{app}\mods\sessions"
Type: filesandordirs; Name: "{app}\mods\recordings"
; Mods folder (in case any runtime-generated files)
Type: filesandordirs; Name: "{app}\mods"
; Media folder
Type: filesandordirs; Name: "{app}\media"
; Runtime logs
Type: files; Name: "{app}\_run.log"
Type: files; Name: "{app}\_inspect.txt"
Type: files; Name: "{app}\_bg_dump.txt"
Type: files; Name: "{app}\_install_ok"
; Nuke the install dir itself if empty
Type: dirifempty; Name: "{app}"

[UninstallRun]
; Kill Redbook/Electron before uninstalling so files aren't locked
Filename: "taskkill.exe"; Parameters: "/F /IM electron.exe"; Flags: runhidden; RunOnceId: "KillElectron"
Filename: "taskkill.exe"; Parameters: "/F /IM Redbook.exe"; Flags: runhidden; RunOnceId: "KillRedbook"

[Code]
// True when the installer was invoked with /AUTOLAUNCH
// (used by the CLI's /update install flow to relaunch Redbook silently)
function ShouldAutoLaunch(): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), '/AUTOLAUNCH') = 0 then begin
      Result := True;
      Exit;
    end;
end;

// Check if post-install download succeeded — warn on finish page if not
procedure CurStepChanged(CurStep: TSetupStep);
var
  MarkerPath, ElectronPath: String;
begin
  if CurStep = ssPostInstall then
  begin
    MarkerPath := ExpandConstant('{app}\_install_ok');
    ElectronPath := ExpandConstant('{app}\electron\electron.exe');
    if not FileExists(MarkerPath) then
    begin
      if not FileExists(ElectronPath) then
        MsgBox('Electron download failed or was interrupted.' + #13#10 + #13#10 +
               'Redbook will not work until Electron is installed.' + #13#10 +
               'Re-run the installer to retry the download.', mbError, MB_OK)
      else
        MsgBox('Setup completed with warnings. Check the install log for details.' + #13#10 +
               'Log: ' + ExpandConstant('{app}\_install.log'), mbInformation, MB_OK);
    end;
  end;
end;

// Suppress restart prompt — VC++ Redist sets PendingFileRenameOperations
// but Redbook works fine without a reboot
function NeedRestart(): Boolean;
begin
  Result := False;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  InstallDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    InstallDir := ExpandConstant('{app}');
    // Clean up any remaining files Inno didn't track
    if DirExists(InstallDir) then
      DelTree(InstallDir, True, True, True);
  end;
end;
