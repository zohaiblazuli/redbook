param(
    [Parameter(Mandatory=$true)]
    [string]$InstallDir
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$electronVersion = '39.8.10'
$electronUrl = "https://github.com/electron/electron/releases/download/v$electronVersion/electron-v$electronVersion-win32-ia32.zip"
$electronDir = Join-Path $InstallDir 'electron'
$electronExe = Join-Path $electronDir 'electron.exe'
$resourcesDir = Join-Path $InstallDir 'resources'
$asarDest = Join-Path $resourcesDir 'app.asar'

$vcRedistUrl = 'https://aka.ms/vs/17/release/vc_redist.x86.exe'

$host.UI.RawUI.WindowTitle = 'Redbook Setup'

# ── Helper functions ────────────────────────────────────────────────────────────

function Write-Step($icon, $msg) {
    Write-Host ""
    Write-Host "  $icon  $msg" -ForegroundColor Cyan
    Write-Host ("  " + ("-" * ($msg.Length + 3))) -ForegroundColor DarkGray
}

function Write-Ok($msg) {
    Write-Host "     [OK] $msg" -ForegroundColor Green
}

function Write-Skip($msg) {
    Write-Host "     [SKIP] $msg" -ForegroundColor Yellow
}

function Write-Warn($msg) {
    Write-Host "     [WARN] $msg" -ForegroundColor Yellow
}

function Write-Err($msg) {
    Write-Host "     [ERR] $msg" -ForegroundColor Red
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
}

function Test-VCRedist {
    # Check both native and WOW64 registry paths for VC++ 2015-2022 (x86)
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
    return $false
}

# ── Banner ──────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ================================================================" -ForegroundColor DarkCyan
Write-Host "       Redbook Setup — Post-Install Configuration" -ForegroundColor White
Write-Host "  ================================================================" -ForegroundColor DarkCyan
Write-Host ""

# ── Step 1: Visual C++ Redistributable ──────────────────────────────────────────

Write-Step "1/4" "Checking Visual C++ Redistributable (x86)"

if (Test-VCRedist) {
    Write-Skip "Visual C++ Redistributable already installed."
} else {
    Write-Host "     VC++ 2015-2022 (x86) is required by Electron." -ForegroundColor Gray
    Write-Host "     Downloading from Microsoft..." -ForegroundColor Gray

    $vcRedistPath = Join-Path $env:TEMP 'vc_redist.x86.exe'

    try {
        Download-WithProgress $vcRedistUrl $vcRedistPath 'VC++ Redist'
    } catch {
        Write-Host ""
        Write-Err "Download failed: $_"
        [System.Windows.Forms.MessageBox]::Show(
            "Failed to download Visual C++ Redistributable.`n`nURL: $vcRedistUrl`nError: $_`n`nYou can install it manually from:`nhttps://aka.ms/vs/17/release/vc_redist.x86.exe",
            'Redbook Setup', 'OK', 'Error')
        exit 1
    }

    if (!(Test-Path $vcRedistPath) -or (Get-Item $vcRedistPath).Length -lt 1000000) {
        Write-Err "Download appears corrupt."
        [System.Windows.Forms.MessageBox]::Show(
            "VC++ Redistributable download appears corrupt.`nPlease try again or install manually from:`nhttps://aka.ms/vs/17/release/vc_redist.x86.exe",
            'Redbook Setup', 'OK', 'Error')
        exit 1
    }

    Write-Host "     Installing (requires admin privileges)..." -ForegroundColor Gray

    try {
        # Elevate via RunAs — will prompt UAC only if needed
        $proc = Start-Process -FilePath $vcRedistPath -ArgumentList '/install /quiet /norestart' -Verb RunAs -Wait -PassThru
        $exitCode = $proc.ExitCode

        if ($exitCode -eq 0) {
            Write-Ok "Visual C++ Redistributable installed."
        } elseif ($exitCode -eq 1638) {
            Write-Ok "Visual C++ Redistributable already up to date."
        } elseif ($exitCode -eq 3010) {
            Write-Ok "Visual C++ Redistributable installed (reboot recommended)."
        } else {
            Write-Err "VC++ installer returned exit code $exitCode"
            [System.Windows.Forms.MessageBox]::Show(
                "Visual C++ Redistributable installer returned exit code $exitCode.`n`nRedbook may not work correctly.`nYou can try installing it manually from:`nhttps://aka.ms/vs/17/release/vc_redist.x86.exe",
                'Redbook Setup', 'OK', 'Warning')
        }
    } catch {
        Write-Err "Failed to run VC++ installer: $_"
        [System.Windows.Forms.MessageBox]::Show(
            "Failed to install Visual C++ Redistributable.`nError: $_`n`nIf you declined the admin prompt, please install it manually from:`nhttps://aka.ms/vs/17/release/vc_redist.x86.exe",
            'Redbook Setup', 'OK', 'Warning')
    }

    Remove-Item $vcRedistPath -Force -ErrorAction SilentlyContinue
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
    $found = $null
    foreach ($p in $searchPaths) {
        $shortP = $p -replace [regex]::Escape($env:LOCALAPPDATA), '%LOCALAPPDATA%'
        if (Test-Path $p) {
            $found = $p
            Write-Host "     Found: $shortP" -ForegroundColor Green
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
        [System.Windows.Forms.MessageBox]::Show(
            "Bluebook was not found on this computer.`n`nRedbook needs Bluebook's app.asar file to work.`n`nPlease either:`n  1. Install Bluebook from collegeboard.org, then re-run this installer`n  2. Manually copy app.asar to:`n     $resourcesDir",
            'Redbook Setup — Bluebook Not Found', 'OK', 'Warning')
    }
}

# ── Done ────────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ================================================================" -ForegroundColor DarkCyan
Write-Host "       Setup complete. You can close this window." -ForegroundColor Green
Write-Host "  ================================================================" -ForegroundColor DarkCyan
Write-Host ""

Start-Sleep -Seconds 3
