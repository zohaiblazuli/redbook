param(
    [Parameter(Mandatory=$true)]
    [string]$InstallDir
)

# Force TLS 1.2 — older Windows/VMs default to TLS 1.0 which GitHub and Microsoft CDN reject
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$electronVersion = '39.8.10'
$electronUrl = "https://github.com/electron/electron/releases/download/v$electronVersion/electron-v$electronVersion-win32-ia32.zip"
$electronDir = Join-Path $InstallDir 'electron'
$electronExe = Join-Path $electronDir 'electron.exe'
$resourcesDir = Join-Path $InstallDir 'resources'
$asarDest = Join-Path $resourcesDir 'app.asar'

$vcRedistUrl = 'https://aka.ms/vs/17/release/vc_redist.x86.exe'

# Log file for debugging install issues
$logFile = Join-Path $InstallDir '_install.log'
function Log($msg) {
    $ts = Get-Date -Format 'HH:mm:ss'
    $line = "[$ts] $msg"
    Write-Host $line
    try { Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue } catch {}
}

$host.UI.RawUI.WindowTitle = 'Redbook Setup'

# ── Helper functions ────────────────────────────────────────────────────────────

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
    if ($bytes -ge 1073741824) { return "{0:F1} GB" -f ($bytes / 1073741824) }
    if ($bytes -ge 1048576)    { return "{0:F1} MB" -f ($bytes / 1048576) }
    if ($bytes -ge 1024)       { return "{0:F1} KB" -f ($bytes / 1024) }
    return "$bytes B"
}

function Format-Time($seconds) {
    if ($seconds -lt 0 -or $seconds -gt 3600) { return "--:--" }
    $m = [math]::Floor($seconds / 60)
    $s = [math]::Floor($seconds % 60)
    return "{0}:{1:D2}" -f $m, $s
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
    $stream = $response.GetResponseStream()
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
    Log "Downloaded $label: $(Format-Bytes $downloaded) in $([math]::Round($elapsed, 1))s"
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
    # Fallback: check if the DLL itself exists
    $dllPaths = @(
        "$env:SystemRoot\System32\vcruntime140.dll",
        "$env:SystemRoot\SysWOW64\vcruntime140.dll"
    )
    foreach ($d in $dllPaths) {
        if (Test-Path $d) { return $true }
    }
    return $false
}

# ── Banner ──────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ================================================================" -ForegroundColor DarkCyan
Write-Host "       Redbook Setup — Post-Install Configuration" -ForegroundColor White
Write-Host "  ================================================================" -ForegroundColor DarkCyan
Write-Host ""
Log "Install started. InstallDir=$InstallDir"
Log "OS: $([Environment]::OSVersion.VersionString) Arch: $([Environment]::Is64BitOperatingSystem)"
Log "PowerShell: $($PSVersionTable.PSVersion)"

# ── Step 1: Visual C++ Redistributable ──────────────────────────────────────────

Write-Step "1/4" "Checking Visual C++ Redistributable (x86)"

if (Test-VCRedist) {
    Write-Skip "Visual C++ Redistributable already installed."
} else {
    Write-Host "     VC++ 2015-2022 (x86) is required by Electron." -ForegroundColor Gray
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
                    Write-Ok "Visual C++ Redistributable installed (reboot recommended)."
                    $vcInstalled = $true
                } else {
                    Write-Warn "VC++ installer returned exit code $exitCode"
                }
            } catch {
                Write-Warn "VC++ install failed: $_"
                Log "VC++ install exception: $_"
            }
        } else {
            Write-Warn "VC++ download appears incomplete."
        }
    } catch {
        Write-Warn "Could not download VC++ Redistributable: $_"
        Log "VC++ download exception: $_"
    }

    Remove-Item $vcRedistPath -Force -ErrorAction SilentlyContinue

    if (-not $vcInstalled) {
        Write-Host ""
        Write-Host "     Redbook may not launch without Visual C++ Redistributable." -ForegroundColor Yellow
        Write-Host "     You can install it manually from:" -ForegroundColor Yellow
        Write-Host "     https://aka.ms/vs/17/release/vc_redist.x86.exe" -ForegroundColor White
        Write-Host ""
        Log "VC++ was NOT installed — continuing anyway"
    }
}

# ── Step 2: Download Electron ───────────────────────────────────────────────────

Write-Step "2/4" "Downloading Electron v$electronVersion (ia32)"

if (Test-Path $electronExe) {
    Write-Skip "Electron already installed."
} else {
    $zipPath = Join-Path $env:TEMP "electron-v$electronVersion-win32-ia32.zip"

    try {
        Download-WithProgress $electronUrl $zipPath 'Electron'
    } catch {
        Write-Host ""
        Write-Err "Download failed: $_"
        Log "Electron download exception: $_"
        [System.Windows.Forms.MessageBox]::Show(
            "Failed to download Electron.`n`nURL: $electronUrl`nError: $_`n`nCheck your internet connection and try again.",
            'Redbook Setup', 'OK', 'Error')
        exit 1
    }

    if (!(Test-Path $zipPath) -or (Get-Item $zipPath).Length -lt 1000000) {
        Write-Err "Download appears corrupt or incomplete."
        [System.Windows.Forms.MessageBox]::Show(
            "Electron download appears corrupt or incomplete.`nPlease try running the installer again.",
            'Redbook Setup', 'OK', 'Error')
        exit 1
    }

    # ── Step 3: Extract ─────────────────────────────────────────────────────────

    Write-Step "3/4" "Extracting Electron"

    if (!(Test-Path $electronDir)) { New-Item -ItemType Directory -Path $electronDir -Force | Out-Null }

    try {
        Write-Host "     Unpacking to $electronDir ..." -ForegroundColor Gray
        Expand-Archive -Path $zipPath -DestinationPath $electronDir -Force
    } catch {
        Write-Err "Extraction failed: $_"
        Log "Extraction exception: $_"
        [System.Windows.Forms.MessageBox]::Show(
            "Failed to extract Electron zip.`nError: $_",
            'Redbook Setup', 'OK', 'Error')
        exit 1
    }

    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

    if (!(Test-Path $electronExe)) {
        Write-Err "electron.exe not found after extraction."
        [System.Windows.Forms.MessageBox]::Show(
            "Electron extraction succeeded but electron.exe not found.`nExpected: $electronExe",
            'Redbook Setup', 'OK', 'Error')
        exit 1
    }

    Write-Ok "Electron v$electronVersion installed."
}

# ── Step 4: Locate and copy app.asar ────────────────────────────────────────────

Write-Step "4/4" "Locating Bluebook (app.asar)"

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
    if (${env:ProgramFiles(x86)}) {
        $searchPaths += Join-Path ${env:ProgramFiles(x86)} 'College Board\Bluebook\resources\app.asar'
    }

    Write-Host "     Searching $($searchPaths.Count) known locations..." -ForegroundColor Gray
    Log "Searching for app.asar in $($searchPaths.Count) locations"
    $found = $null
    foreach ($p in $searchPaths) {
        $shortP = $p -replace [regex]::Escape($env:LOCALAPPDATA), '%LOCALAPPDATA%'
        if (Test-Path $p) {
            $found = $p
            Write-Host "     Found: $shortP" -ForegroundColor Green
            Log "Found app.asar at: $p"
            break
        } else {
            Write-Host "       miss: $shortP" -ForegroundColor DarkGray
        }
    }

    if (!(Test-Path $resourcesDir)) { New-Item -ItemType Directory -Path $resourcesDir -Force | Out-Null }

    if ($found) {
        $sizeMB = [math]::Round((Get-Item $found).Length / 1MB, 1)
        Write-Host "     Copying app.asar ($sizeMB MB)..." -ForegroundColor Gray
        Copy-Item $found $asarDest -Force
        Write-Ok "app.asar copied ($sizeMB MB)."
    } else {
        Write-Warn "Bluebook not found on this machine."
        Log "app.asar NOT found in any search path"
        [System.Windows.Forms.MessageBox]::Show(
            "Bluebook was not found on this computer.`n`nRedbook needs Bluebook's app.asar file to work.`n`nPlease either:`n  1. Install Bluebook from collegeboard.org, then re-run this installer`n  2. Manually copy app.asar to:`n     $resourcesDir",
            'Redbook Setup — Bluebook Not Found', 'OK', 'Warning')
    }
}

# ── Summary ─────────────────────────────────────────────────────────────────────

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
    Write-Host "     VC++ x86:  MISSING (install from aka.ms/vs/17/release/vc_redist.x86.exe)" -ForegroundColor Red
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
Log "Install finished. electron=$((Test-Path $electronExe)) asar=$((Test-Path $asarDest)) vcredist=$(Test-VCRedist)"

Start-Sleep -Seconds 5
