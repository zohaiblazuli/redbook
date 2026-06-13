param(
    [string]$InstallDir
)

# -- Validate InstallDir (replaces [Mandatory] which crashes under -NonInteractive) --
if (-not $InstallDir -or $InstallDir -eq '') {
    $candidate = Join-Path $env:LOCALAPPDATA 'Redbook'
    if (Test-Path $candidate) {
        $InstallDir = $candidate
    } else {
        Write-Host ""
        Write-Host "  [FATAL] InstallDir parameter is empty and could not be derived." -ForegroundColor Red
        Write-Host "  Usage: install_helpers.ps1 <InstallDir>" -ForegroundColor Yellow
        exit 1
    }
}
$InstallDir = $InstallDir.TrimEnd('\', '/')
if (-not (Test-Path $InstallDir)) {
    Write-Host "  [WARN] InstallDir does not exist yet: $InstallDir -- creating it." -ForegroundColor Yellow
    try { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
    catch {
        Write-Host "  [FATAL] Cannot create InstallDir: $_" -ForegroundColor Red
        exit 1
    }
}

# -- Logging FIRST - before anything else can crash ------------------------------
$logFile = Join-Path $InstallDir '_install.log'
try { Set-Content -Path $logFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] install_helpers.ps1 started" -Encoding utf8 } catch {}
function Log($msg) {
    $ts = Get-Date -Format 'HH:mm:ss'
    $line = "[$ts] $msg"
    try { Add-Content -Path $logFile -Value $line -Encoding utf8 } catch {}
}
Log "InstallDir=$InstallDir"
Log "OS=$([Environment]::OSVersion.VersionString) 64bit=$([Environment]::Is64BitOperatingSystem)"
Log "PS=$($PSVersionTable.PSVersion) Host=$($host.Name)"
Log "User=$env:USERNAME Elevated=$([Security.Principal.WindowsIdentity]::GetCurrent().Groups -match 'S-1-5-32-544')"

# -- Safe init - protect every startup op ----------------------------------------
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Log "TLS 1.2 set" }
catch { Log "TLS 1.2 failed: $_ - continuing" }

$hasWinForms = $false
try { Add-Type -AssemblyName System.Windows.Forms; $hasWinForms = $true; Log "WinForms loaded" }
catch { Log "WinForms failed: $_ - no message boxes available" }

try { $host.UI.RawUI.WindowTitle = 'Redbook Setup' } catch { Log "WindowTitle set failed, cosmetic" }

function Show-Error($title, $msg) {
    if ($hasWinForms) {
        try { [System.Windows.Forms.MessageBox]::Show($msg, $title, 'OK', 'Error') } catch {}
    }
    Log "ERROR DIALOG: $title - $msg"
}

function Show-Warning($title, $msg) {
    if ($hasWinForms) {
        try { [System.Windows.Forms.MessageBox]::Show($msg, $title, 'OK', 'Warning') } catch {}
    }
    Log "WARNING DIALOG: $title - $msg"
}

# -- Config ----------------------------------------------------------------------
$electronVersion = '39.8.10'
$electronUrl = "https://github.com/electron/electron/releases/download/v$electronVersion/electron-v$electronVersion-win32-ia32.zip"
$electronDir = Join-Path $InstallDir 'electron'
$electronExe = Join-Path $electronDir 'electron.exe'
$resourcesDir = Join-Path $InstallDir 'resources'
$asarDest = Join-Path $resourcesDir 'app.asar'
$vcRedistUrl = 'https://aka.ms/vs/17/release/vc_redist.x86.exe'

# -- Helper functions ------------------------------------------------------------

function Write-Step($icon, $msg) {
    Write-Host ""
    Write-Host "  $icon  $msg" -ForegroundColor Cyan
    Write-Host ("  " + ("-" * ($msg.Length + 3))) -ForegroundColor DarkGray
    Log "STEP $icon $msg"
}

function Write-Ok($msg) {
    Write-Host "     [OK] $msg" -ForegroundColor Green
    Log "[OK] $msg"
}

function Write-Skip($msg) {
    Write-Host "     [SKIP] $msg" -ForegroundColor Yellow
    Log "[SKIP] $msg"
}

function Write-Warn($msg) {
    Write-Host "     [WARN] $msg" -ForegroundColor Yellow
    Log "[WARN] $msg"
}

function Write-Err($msg) {
    Write-Host "     [ERR] $msg" -ForegroundColor Red
    Log "[ERR] $msg"
}

function Format-Bytes($bytes) {
    if ($bytes -ge 1073741824) { return "$([math]::Round($bytes / 1073741824, 1)) GB" }
    if ($bytes -ge 1048576)    { return "$([math]::Round($bytes / 1048576, 1)) MB" }
    if ($bytes -ge 1024)       { return "$([math]::Round($bytes / 1024, 1)) KB" }
    return "$bytes B"
}

function Format-Time($seconds) {
    if ($seconds -lt 0 -or $seconds -gt 3600) { return '--:--' }
    $m = [int][math]::Floor($seconds / 60)
    $s = [int][math]::Floor($seconds % 60)
    return "$m`:$($s.ToString().PadLeft(2,'0'))"
}

function Download-WithProgress($url, $destPath, $label) {
    Log "Downloading $label from $url"
    $uri = [System.Uri]::new($url)
    $request = [System.Net.HttpWebRequest]::Create($uri)
    $request.AllowAutoRedirect = $true
    $request.UserAgent = 'RedbookSetup/1.0'
    $request.Timeout = 30000

    $response = $request.GetResponse()
    $totalBytes = $response.ContentLength
    Log "$label response: $totalBytes bytes, status=$($response.StatusCode)"
    $stream = $response.GetResponseStream()
    $stream.ReadTimeout = 30000   # 30s -- if no data arrives for this long, throw instead of hanging
    $fileStream = [System.IO.File]::Create($destPath)
    $buffer = New-Object byte[] 65536
    $downloaded = 0
    $startTime = [DateTime]::Now
    $lastUpdate = [DateTime]::MinValue

    if ($totalBytes -gt 0) {
        Write-Host "     Size: $(Format-Bytes $totalBytes)" -ForegroundColor Gray
    }

    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $fileStream.Write($buffer, 0, $read)
        $downloaded += $read
        $now = [DateTime]::Now

        if (($now - $lastUpdate).TotalMilliseconds -ge 250) {
            $lastUpdate = $now
            $elapsed = ($now - $startTime).TotalSeconds
            if ($totalBytes -gt 0) {
                $pct = [math]::Round(($downloaded / $totalBytes) * 100, 1)
                $speed = if ($elapsed -gt 0) { $downloaded / $elapsed } else { 0 }
                $remaining = if ($speed -gt 0) { ($totalBytes - $downloaded) / $speed } else { 0 }
                $barLen = 30
                $filled = [math]::Floor($pct / 100 * $barLen)
                $bar = ("=" * $filled) + ("." * ($barLen - $filled))
                $line = "     [$bar] $pct%  $(Format-Bytes $downloaded)/$(Format-Bytes $totalBytes)  $(Format-Bytes $speed)/s  ETA $(Format-Time $remaining)"
                Write-Host "`r$line" -NoNewline
            } else {
                Write-Host "`r     Downloaded $(Format-Bytes $downloaded)  $(Format-Bytes ($downloaded / [math]::Max($elapsed, 0.1)))/s" -NoNewline
            }
        }
    }

    $fileStream.Close()
    $stream.Close()
    $response.Close()

    $elapsed = ([DateTime]::Now - $startTime).TotalSeconds
    $avgSpeed = if ($elapsed -gt 0) { $downloaded / $elapsed } else { 0 }
    Write-Host ""
    Write-Host "     Downloaded $(Format-Bytes $downloaded) in $([math]::Round($elapsed, 1))s (avg $(Format-Bytes $avgSpeed)/s)" -ForegroundColor Gray
    Log "Downloaded ${label}: $(Format-Bytes $downloaded) in $([math]::Round($elapsed, 1))s"
}

function Test-VCRedist {
    $paths = @(
        'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x86',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x86'
    )
    foreach ($p in $paths) {
        try {
            $val = Get-ItemProperty -Path $p -Name 'Installed' -ErrorAction Stop
            if ($val.Installed -eq 1) { return $true }
        } catch {}
    }
    $dllPaths = @(
        "$env:SystemRoot\System32\vcruntime140.dll",
        "$env:SystemRoot\SysWOW64\vcruntime140.dll"
    )
    foreach ($d in $dllPaths) {
        if (Test-Path $d) { return $true }
    }
    return $false
}

# ===============================================================================
# MAIN - wrapped in global try/catch so ANY crash gets logged
# ===============================================================================

try {

Write-Host ""
Write-Host "  ================================================================" -ForegroundColor DarkCyan
Write-Host "       Redbook Setup - Post-Install Configuration" -ForegroundColor White
Write-Host "  ================================================================" -ForegroundColor DarkCyan
Write-Host ""

# -- Step 1: Visual C++ Redistributable ------------------------------------------

Write-Step "1/5" "Checking Visual C++ Redistributable x86"

if (Test-VCRedist) {
    Write-Skip "Visual C++ Redistributable already installed."
} else {
    Write-Host "     VC++ 2015-2022 x86 is required by Electron." -ForegroundColor Gray
    Write-Host "     Downloading from Microsoft..." -ForegroundColor Gray

    $vcRedistPath = Join-Path $env:TEMP 'vc_redist.x86.exe'
    $vcInstalled = $false

    try {
        Download-WithProgress $vcRedistUrl $vcRedistPath 'VC++ Redist'

        if ((Test-Path $vcRedistPath) -and (Get-Item $vcRedistPath).Length -gt 1000000) {
            Write-Host "     Installing..." -ForegroundColor Gray

            try {
                $proc = Start-Process -FilePath $vcRedistPath -ArgumentList '/install /quiet /norestart' -Wait -PassThru
                $exitCode = $proc.ExitCode
                Log "VC++ installer exit code: $exitCode"

                if ($exitCode -eq 0) {
                    Write-Ok "Visual C++ Redistributable installed."
                    $vcInstalled = $true
                } elseif ($exitCode -eq 1638) {
                    Write-Ok "Visual C++ Redistributable already up to date."
                    $vcInstalled = $true
                } elseif ($exitCode -eq 3010) {
                    Write-Ok "Visual C++ Redistributable installed - reboot recommended."
                    $vcInstalled = $true
                } else {
                    Write-Warn "VC++ installer returned exit code $exitCode"
                }
            } catch {
                Write-Warn "VC++ install failed: $_"
            }
        } else {
            Write-Warn "VC++ download appears incomplete."
        }
    } catch {
        Write-Warn "Could not download VC++ Redistributable: $_"
    }

    try { Remove-Item $vcRedistPath -Force } catch {}

    if (-not $vcInstalled) {
        Write-Host ""
        Write-Host "     Redbook may not launch without Visual C++ Redistributable." -ForegroundColor Yellow
        Write-Host "     You can install it manually from:" -ForegroundColor Yellow
        Write-Host "     https://aka.ms/vs/17/release/vc_redist.x86.exe" -ForegroundColor White
        Write-Host ""
    }
}

# -- Step 2: Download Electron ---------------------------------------------------

Write-Step "2/5" "Downloading Electron v$electronVersion ia32"

if (Test-Path $electronExe) {
    Write-Skip "Electron already installed."
} else {
    $zipPath = Join-Path $env:TEMP "electron-v$electronVersion-win32-ia32.zip"

    try {
        Download-WithProgress $electronUrl $zipPath 'Electron'
    } catch {
        Write-Host ""
        Write-Err "Download failed: $_"
        Show-Error 'Redbook Setup' "Failed to download Electron.`n`nURL: $electronUrl`nError: $_`n`nCheck your internet connection and try again."
        # Don't exit - continue to app.asar step so log captures everything
    }

    if ((Test-Path $zipPath) -and (Get-Item $zipPath).Length -gt 1000000) {
        # -- Step 3: Extract -----------------------------------------------------

        Write-Step "3/5" "Extracting Electron"

        if (!(Test-Path $electronDir)) {
            try { New-Item -ItemType Directory -Path $electronDir -Force | Out-Null } catch { Log "mkdir electron failed: $_" }
        }

        try {
            Write-Host "     Unpacking to $electronDir ..." -ForegroundColor Gray
            Expand-Archive -Path $zipPath -DestinationPath $electronDir -Force
            Log "Extraction complete"
        } catch {
            Write-Err "Extraction failed: $_"
            Show-Error 'Redbook Setup' "Failed to extract Electron zip.`nError: $_"
        }

        try { Remove-Item $zipPath -Force } catch {}

        if (Test-Path $electronExe) {
            Write-Ok "Electron v$electronVersion installed."
        } else {
            Write-Err "electron.exe not found after extraction."
        }
    } else {
        Write-Step "3/5" "Extracting Electron"
        Write-Err "Electron zip missing or corrupt - skipping extraction."
    }
}

# -- Step 4: Locate and copy app.asar --------------------------------------------

Write-Step "4/5" "Locating Bluebook app.asar"

if (Test-Path $asarDest) {
    Write-Skip "app.asar already present."
} else {
    $searchPaths = @()
    if ($env:LOCALAPPDATA) {
        $searchPaths += Join-Path $env:LOCALAPPDATA 'Programs\bluebook\resources\app.asar'
        $searchPaths += Join-Path $env:LOCALAPPDATA 'Programs\Bluebook\resources\app.asar'
    }
    if ($env:ProgramFiles) {
        $searchPaths += Join-Path $env:ProgramFiles 'College Board\Bluebook\resources\app.asar'
    }
    $pf86 = [Environment]::GetFolderPath('ProgramFilesX86')
    if ($pf86) {
        $searchPaths += Join-Path $pf86 'College Board\Bluebook\resources\app.asar'
    }

    Write-Host "     Searching $($searchPaths.Count) known locations..." -ForegroundColor Gray
    Log "Searching $($searchPaths.Count) paths for app.asar"
    $found = $null
    foreach ($p in $searchPaths) {
        $shortP = $p
        if ($env:LOCALAPPDATA) { $shortP = $p -replace [regex]::Escape($env:LOCALAPPDATA), '%LOCALAPPDATA%' }
        Log "  checking: $p"
        if (Test-Path $p) {
            $found = $p
            Write-Host "     Found: $shortP" -ForegroundColor Green
            Log "  FOUND: $p"
            break
        } else {
            Write-Host "       miss: $shortP" -ForegroundColor DarkGray
        }
    }

    if (!(Test-Path $resourcesDir)) {
        try { New-Item -ItemType Directory -Path $resourcesDir -Force | Out-Null } catch { Log "mkdir resources failed: $_" }
    }

    if ($found) {
        $sizeMB = [math]::Round((Get-Item $found).Length / 1MB, 1)
        Write-Host "     Copying app.asar - ${sizeMB} MB..." -ForegroundColor Gray
        try {
            Copy-Item $found $asarDest -Force
            Write-Ok "app.asar copied, ${sizeMB} MB."
        } catch {
            Write-Err "Copy failed: $_"
        }
    } else {
        Write-Warn "Bluebook not found on this machine."
        Show-Warning 'Redbook Setup - Bluebook Not Found' "Bluebook was not found on this computer.`n`nRedbook needs Bluebook's app.asar file to work.`n`nPlease either:`n  1. Install Bluebook from collegeboard.org, then re-run this installer`n  2. Manually copy app.asar to:`n     $resourcesDir"
    }
}

# -- Summary ---------------------------------------------------------------------

Write-Host ""
Write-Host "  ================================================================" -ForegroundColor DarkCyan

$allGood = $true
if (Test-Path $electronExe) {
    Write-Host "     Electron:  OK" -ForegroundColor Green
} else {
    Write-Host "     Electron:  MISSING" -ForegroundColor Red
    $allGood = $false
}
if (Test-Path $asarDest) {
    Write-Host "     app.asar:  OK" -ForegroundColor Green
} else {
    Write-Host "     app.asar:  MISSING" -ForegroundColor Red
    $allGood = $false
}
if (Test-VCRedist) {
    Write-Host "     VC++ x86:  OK" -ForegroundColor Green
} else {
    Write-Host "     VC++ x86:  MISSING - install from aka.ms/vs/17/release/vc_redist.x86.exe" -ForegroundColor Red
    $allGood = $false
}

if ($allGood) {
    Write-Host ""
    Write-Host "       Setup complete. Ready to launch!" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "       Setup finished with issues. See above." -ForegroundColor Yellow
}

Write-Host "  ================================================================" -ForegroundColor DarkCyan
Write-Host ""
Log "Install finished. electron=$(Test-Path $electronExe) asar=$(Test-Path $asarDest) vcredist=$(Test-VCRedist)"

# -- Step 5: Desktop Integration (retarget shortcuts + extract icon) -----------

Write-Step "5/5" "Desktop Integration"

# 5a: Retarget Bluebook shortcuts in Public Desktop and Start Menu
$redbookExe = Join-Path $InstallDir 'Redbook.exe'
if (Test-Path $redbookExe) {
    try {
        $wsh = New-Object -ComObject WScript.Shell
        $retargetPaths = @(
            (Join-Path $env:PUBLIC 'Desktop\Bluebook.lnk'),
            (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Bluebook.lnk')
        )

        $retargeted = 0
        foreach ($lnkPath in $retargetPaths) {
            if (Test-Path $lnkPath) {
                $lnk = $wsh.CreateShortcut($lnkPath)
                $oldTarget = $lnk.TargetPath
                Log "Found shortcut: $lnkPath (target: $oldTarget)"
                $lnk.TargetPath = $redbookExe
                $lnk.WorkingDirectory = $InstallDir
                $lnk.Save()

                $verify = $wsh.CreateShortcut($lnkPath)
                if ($verify.TargetPath -eq $redbookExe) {
                    Write-Ok "Retargeted: $lnkPath"
                    $retargeted++
                } else {
                    Write-Warn "Retarget verify failed for $lnkPath (got $($verify.TargetPath))"
                }
            }
        }

        if ($retargeted -gt 0) {
            Write-Ok "Retargeted $retargeted extra shortcut(s)"
        } else {
            Write-Host "     No extra shortcuts found (Public Desktop / Start Menu)" -ForegroundColor DarkGray
            Log "No extra Bluebook shortcuts found to retarget"
        }
    } catch {
        Write-Warn "Shortcut retarget failed: $_"
    }

    # 5b: Delete stale Redbook.lnk from user desktop (Inno created this in older versions)
    $staleRedbook = Join-Path $env:USERPROFILE 'Desktop\Redbook.lnk'
    if (Test-Path $staleRedbook) {
        try {
            Remove-Item $staleRedbook -Force
            Write-Ok "Removed stale Redbook.lnk from desktop"
        } catch {
            Write-Warn "Could not remove Redbook.lnk: $_"
        }
    }
} else {
    Write-Warn "Redbook.exe not found at $redbookExe -- skipping shortcut retarget"
}

# 5c: Extract fresh bluebook.ico from Bluebook.exe (for Electron window icon in _run.js)
$bbExePaths = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\bluebook\Bluebook.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Bluebook\Bluebook.exe')
)
$bbExe = $null
foreach ($p in $bbExePaths) { if (Test-Path $p) { $bbExe = $p; break } }

if ($bbExe) {
    $mediaDir = Join-Path $InstallDir 'media'
    $icoOut = Join-Path $mediaDir 'bluebook.ico'
    try {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public class RbSetupIconUtil {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern int PrivateExtractIcons(
        string lpszFile, int nIconIndex, int cxIcon, int cyIcon,
        IntPtr[] phicon, int[] piconid, int nIcons, int flags);
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);
}
'@
        Add-Type -AssemblyName System.Drawing

        $hicons = New-Object IntPtr[] 1
        $ids = New-Object int[] 1
        [RbSetupIconUtil]::PrivateExtractIcons($bbExe, 0, 256, 256, $hicons, $ids, 1, 0) | Out-Null

        if ($hicons[0] -ne [IntPtr]::Zero) {
            $icon = [System.Drawing.Icon]::FromHandle($hicons[0])
            $bmp = $icon.ToBitmap()
            $pngStream = New-Object System.IO.MemoryStream
            $bmp.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
            [RbSetupIconUtil]::DestroyIcon($hicons[0])

            $pngBytes = $pngStream.ToArray()
            $pngStream.Close()

            # Build ICO: header(6) + directory(16) + PNG payload
            $ms = New-Object System.IO.MemoryStream
            $ms.Write([BitConverter]::GetBytes([UInt16]0), 0, 2)
            $ms.Write([BitConverter]::GetBytes([UInt16]1), 0, 2)
            $ms.Write([BitConverter]::GetBytes([UInt16]1), 0, 2)
            $ms.WriteByte(0); $ms.WriteByte(0); $ms.WriteByte(0); $ms.WriteByte(0)
            $ms.Write([BitConverter]::GetBytes([UInt16]1), 0, 2)
            $ms.Write([BitConverter]::GetBytes([UInt16]32), 0, 2)
            $ms.Write([BitConverter]::GetBytes([UInt32]$pngBytes.Length), 0, 4)
            $ms.Write([BitConverter]::GetBytes([UInt32]22), 0, 4)
            $ms.Write($pngBytes, 0, $pngBytes.Length)

            [System.IO.File]::WriteAllBytes($icoOut, $ms.ToArray())
            $ms.Close()

            Write-Ok "Extracted bluebook.ico (256x256) from Bluebook.exe"
        } else {
            Write-Warn "PrivateExtractIcons returned null -- keeping bundled bluebook.ico"
        }
    } catch {
        Write-Warn "Icon extraction failed: $_ -- keeping bundled bluebook.ico"
    }
} else {
    Write-Host "     Bluebook.exe not found -- using bundled bluebook.ico" -ForegroundColor DarkGray
    Log "Bluebook.exe not found for icon extraction"
}

Write-Host ""

# Write success marker if all critical components present (Inno checks this)
$markerPath = Join-Path $InstallDir '_install_ok'
if ($allGood) {
    try { Set-Content -Path $markerPath -Value 'ok' -Encoding utf8 } catch {}
} else {
    # Remove stale marker from previous installs
    try { if (Test-Path $markerPath) { Remove-Item $markerPath -Force } } catch {}
}

} catch {
    # Global catch - if ANYTHING uncaught crashes the script, log it
    Log "FATAL UNHANDLED EXCEPTION: $_"
    Log "Exception type: $($_.Exception.GetType().FullName)"
    Log "Stack: $($_.ScriptStackTrace)"
    Write-Host ""
    Write-Host "  [FATAL] Script crashed: $_" -ForegroundColor Red
    Write-Host "  Check log: $logFile" -ForegroundColor Yellow
    Write-Host ""
}

Log "Script ending normally."

# Exit non-zero if critical components are missing
if (-not (Test-Path $electronExe)) {
    Log "Exiting with code 1: Electron missing"
    exit 1
}

# Window lifetime: if called from CMD wrapper, it handles pausing on error.
# If running standalone (manual testing), pause so user can see output.
if (-not $env:REDBOOK_WRAPPER) {
    Write-Host "  Press any key to close..." -ForegroundColor DarkGray
    try { $null = $host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep -Seconds 8 }
}
