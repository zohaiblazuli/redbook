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

# ── Download Electron ────────────────────────────────────────────────────────

if (Test-Path $electronExe) {
    Write-Host "[SKIP] Electron already installed at $electronExe"
} else {
    Write-Host "[INFO] Downloading Electron v$electronVersion (ia32)..."
    $zipPath = Join-Path $env:TEMP "electron-v$electronVersion-win32-ia32.zip"

    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $electronUrl -OutFile $zipPath -UseBasicParsing
        $ProgressPreference = 'Continue'
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "Failed to download Electron.`n`nURL: $electronUrl`nError: $_`n`nCheck your internet connection and try again.",
            'Redbook Setup', 'OK', 'Error')
        exit 1
    }

    if (!(Test-Path $zipPath) -or (Get-Item $zipPath).Length -lt 1000000) {
        [System.Windows.Forms.MessageBox]::Show(
            "Electron download appears corrupt or incomplete.`nPlease try running the installer again.",
            'Redbook Setup', 'OK', 'Error')
        exit 1
    }

    Write-Host "[INFO] Extracting Electron..."
    if (!(Test-Path $electronDir)) { New-Item -ItemType Directory -Path $electronDir -Force | Out-Null }

    try {
        Expand-Archive -Path $zipPath -DestinationPath $electronDir -Force
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "Failed to extract Electron zip.`nError: $_",
            'Redbook Setup', 'OK', 'Error')
        exit 1
    }

    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

    if (!(Test-Path $electronExe)) {
        [System.Windows.Forms.MessageBox]::Show(
            "Electron extraction succeeded but electron.exe not found.`nExpected: $electronExe",
            'Redbook Setup', 'OK', 'Error')
        exit 1
    }

    Write-Host "[OK] Electron installed."
}

# ── Locate and copy app.asar ────────────────────────────────────────────────

if (Test-Path $asarDest) {
    Write-Host "[SKIP] app.asar already present."
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

    $found = $null
    foreach ($p in $searchPaths) {
        if (Test-Path $p) {
            $found = $p
            break
        }
    }

    if (!(Test-Path $resourcesDir)) { New-Item -ItemType Directory -Path $resourcesDir -Force | Out-Null }

    if ($found) {
        Write-Host "[INFO] Found Bluebook at: $found"
        Write-Host "[INFO] Copying app.asar ($([math]::Round((Get-Item $found).Length / 1MB, 1)) MB)..."
        Copy-Item $found $asarDest -Force
        Write-Host "[OK] app.asar copied."
    } else {
        [System.Windows.Forms.MessageBox]::Show(
            "Bluebook was not found on this computer.`n`nRedbook needs Bluebook's app.asar file to work.`n`nPlease either:`n  1. Install Bluebook from collegeboard.org, then re-run this installer`n  2. Manually copy app.asar to:`n     $resourcesDir",
            'Redbook Setup — Bluebook Not Found', 'OK', 'Warning')
        Write-Host "[WARN] app.asar not found. User must provide it manually."
    }
}

Write-Host "[DONE] Post-install complete."
