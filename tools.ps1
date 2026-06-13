param(
    [int]$Action,
    [string]$LogFile
)

# ── Logging ───────────────────────────────────────────────────────────────────
function Write-Log {
    param([string]$Msg, [string]$Color = 'White')
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] $Msg"
    Write-Host $line -ForegroundColor $Color
    if ($LogFile) {
        try {
            $dir = Split-Path $LogFile -Parent
            if ($dir -and -not (Test-Path $dir)) {
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
            }
            Add-Content -Path $LogFile -Value $line -ErrorAction Stop
        } catch {}
    }
}

# ── Find source application ──────────────────────────────────────────────────
function Find-SourceApp {
    $paths = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\bluebook\Bluebook.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Bluebook\Bluebook.exe'),
        (Join-Path $env:ProgramFiles 'College Board\Bluebook\Bluebook.exe')
    )
    foreach ($p in $paths) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

# ── Find Redbook ──────────────────────────────────────────────────────────────
function Find-Redbook {
    $rbExe = Join-Path $env:LOCALAPPDATA 'Redbook\Redbook.exe'
    if (Test-Path $rbExe) { return $rbExe }
    return $null
}

# ── Extract icon (256x256 via PrivateExtractIcons → PNG-in-ICO) ───────────────
function Extract-AppIcon {
    param([string]$SourceExe, [string]$OutputDir)
    try {
        Add-Type -AssemblyName System.Drawing

        Add-Type @'
using System;
using System.Runtime.InteropServices;
public class RbIconUtil {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern int PrivateExtractIcons(
        string lpszFile, int nIconIndex, int cxIcon, int cyIcon,
        IntPtr[] phicon, int[] piconid, int nIcons, int flags);
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);
}
'@

        if (-not (Test-Path $OutputDir)) {
            New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
        }

        $icoPath = Join-Path $OutputDir 'bluebook.ico'

        # Extract 256x256 icon handle
        $hicons = New-Object IntPtr[] 1
        $ids = New-Object int[] 1
        [RbIconUtil]::PrivateExtractIcons($SourceExe, 0, 256, 256, $hicons, $ids, 1, 0) | Out-Null

        if ($hicons[0] -eq [IntPtr]::Zero) {
            throw 'PrivateExtractIcons returned null handle'
        }

        # Convert to bitmap, save as PNG
        $icon = [System.Drawing.Icon]::FromHandle($hicons[0])
        $bmp = $icon.ToBitmap()
        $pngStream = New-Object System.IO.MemoryStream
        $bmp.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        [RbIconUtil]::DestroyIcon($hicons[0])

        $pngBytes = $pngStream.ToArray()
        $pngStream.Close()

        # Build ICO file: header(6) + directory(16) + PNG payload
        $ms = New-Object System.IO.MemoryStream
        $ms.Write([BitConverter]::GetBytes([UInt16]0), 0, 2)     # reserved
        $ms.Write([BitConverter]::GetBytes([UInt16]1), 0, 2)     # type = ICO
        $ms.Write([BitConverter]::GetBytes([UInt16]1), 0, 2)     # count = 1
        $ms.WriteByte(0)                                          # width 0=256
        $ms.WriteByte(0)                                          # height 0=256
        $ms.WriteByte(0)                                          # no palette
        $ms.WriteByte(0)                                          # reserved
        $ms.Write([BitConverter]::GetBytes([UInt16]1), 0, 2)     # planes
        $ms.Write([BitConverter]::GetBytes([UInt16]32), 0, 2)    # bpp
        $ms.Write([BitConverter]::GetBytes([UInt32]$pngBytes.Length), 0, 4)  # data size
        $ms.Write([BitConverter]::GetBytes([UInt32]22), 0, 4)    # data offset
        $ms.Write($pngBytes, 0, $pngBytes.Length)

        [System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
        $ms.Close()

        Write-Log "[OK] Icon extracted (256x256): $icoPath" 'Green'
        return $icoPath
    }
    catch {
        Write-Log "[FAIL] Icon extraction failed: $($_.Exception.Message)" 'Red'
        return $null
    }
}

# ── Retarget shortcuts ────────────────────────────────────────────────────────
function Update-Shortcuts {
    param(
        [string]$RbExe,
        [string]$RbDir,
        [string]$IconPath,
        [string]$SourceExe
    )
    try {
        $sh = New-Object -ComObject WScript.Shell
        $userDesktop = [Environment]::GetFolderPath('Desktop')
        $publicDesktop = "$env:PUBLIC\Desktop"
        $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

        # Search ALL locations for Bluebook shortcuts
        $searchPaths = @(
            (Join-Path $userDesktop 'Bluebook.lnk'),
            (Join-Path $publicDesktop 'Bluebook.lnk'),
            (Join-Path $startMenu 'Bluebook.lnk')
        )

        $retargeted = 0
        foreach ($lnkPath in $searchPaths) {
            if (Test-Path $lnkPath) {
                Write-Log "[FOUND] $lnkPath" 'DarkGray'

                # Read current target
                $lnk = $sh.CreateShortcut($lnkPath)
                $oldTarget = $lnk.TargetPath
                Write-Log "     Old target: $oldTarget" 'DarkGray'

                # Retarget to Redbook
                $lnk.TargetPath = $RbExe
                $lnk.WorkingDirectory = $RbDir
                $lnk.Save()

                # Readback verification
                $verify = $sh.CreateShortcut($lnkPath)
                Write-Log "[OK] Retargeted: $lnkPath" 'Green'
                Write-Log "[VERIFY] Target now: $($verify.TargetPath)" 'Cyan'

                if ($verify.TargetPath -ne $RbExe) {
                    Write-Log "[WARN] Target mismatch! Expected $RbExe but got $($verify.TargetPath)" 'Red'
                }

                $retargeted++
            }
        }

        if ($retargeted -eq 0) {
            Write-Log "[WARN] No Bluebook shortcuts found to retarget. Creating one." 'Yellow'

            # Fallback: create a new shortcut on user desktop
            $newLnkPath = Join-Path $userDesktop 'Bluebook.lnk'
            $lnk = $sh.CreateShortcut($newLnkPath)
            $lnk.TargetPath = $RbExe
            $lnk.WorkingDirectory = $RbDir
            if ($IconPath -and (Test-Path $IconPath)) {
                $lnk.IconLocation = $IconPath
            } elseif ($SourceExe) {
                $lnk.IconLocation = "$SourceExe,0"
            }
            $lnk.Description = 'The Bluebook App'
            $lnk.Save()

            $verify = $sh.CreateShortcut($newLnkPath)
            Write-Log "[OK] Created new shortcut: $newLnkPath" 'Green'
            Write-Log "[VERIFY] Target: $($verify.TargetPath)" 'Cyan'
        } else {
            Write-Log "[OK] Retargeted $retargeted shortcut(s)" 'Green'
        }

        # Clean up Redbook shortcut if it exists (don't need two)
        $rbLnk = Join-Path $userDesktop 'Redbook.lnk'
        if (Test-Path $rbLnk) {
            Remove-Item $rbLnk -Force
            Write-Log "[OK] Removed Redbook.lnk (no longer needed)" 'Green'
        }

        return $true
    }
    catch {
        Write-Log "[FAIL] Shortcut update failed: $($_.Exception.Message)" 'Red'
        return $false
    }
}

# ── Main ──────────────────────────────────────────────────────────────────────
Write-Log '=== Redbook Tools started ==='
Write-Log "Action: $Action"

# Find source application
$srcExe = Find-SourceApp
if (-not $srcExe) {
    Write-Log '[FAIL] Source application not found. Is it installed?' 'Red'
    Write-Log '       Checked:' 'DarkGray'
    Write-Log "         $($env:LOCALAPPDATA)\Programs\bluebook\Bluebook.exe" 'DarkGray'
    Write-Log "         $($env:LOCALAPPDATA)\Programs\Bluebook\Bluebook.exe" 'DarkGray'
    Write-Log "         $($env:ProgramFiles)\College Board\Bluebook\Bluebook.exe" 'DarkGray'
    exit 1
}
Write-Log "[OK] Source app: $srcExe" 'Green'

# Find Redbook — MUST exist before we touch any shortcuts
$rbExe = Find-Redbook
if (-not $rbExe) {
    Write-Log '[FAIL] Redbook not installed at expected path.' 'Red'
    Write-Log "       Expected: $($env:LOCALAPPDATA)\Redbook\Redbook.exe" 'DarkGray'
    Write-Log '       No shortcuts were modified.' 'Yellow'
    exit 1
}
$rbDir = Split-Path $rbExe -Parent
Write-Log "[OK] Redbook: $rbExe" 'Green'

$mediaDir = Join-Path $rbDir 'media'
$icoPath = $null

# Action 1 = full, 2 = icon only, 3 = shortcuts only
if ($Action -eq 1 -or $Action -eq 2) {
    $icoPath = Extract-AppIcon -SourceExe $srcExe -OutputDir $mediaDir
}

if ($Action -eq 1 -or $Action -eq 3) {
    Update-Shortcuts -RbExe $rbExe -RbDir $rbDir -IconPath $icoPath -SourceExe $srcExe
}

Write-Log ''
Write-Log '=== Done ===' 'Cyan'
