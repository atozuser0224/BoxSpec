[CmdletBinding()]
param(
  [switch]$Quiet,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-InstallRoot {
  if (-not [string]::IsNullOrWhiteSpace($env:BOXSPEC_INSTALL_ROOT)) {
    return [IO.Path]::GetFullPath($env:BOXSPEC_INSTALL_ROOT)
  }
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "LOCALAPPDATA is unavailable. BoxSpec supports per-user Windows installation only."
  }
  return [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Programs\BoxSpec"))
}

function Assert-SafeInstallRoot([string]$Path) {
  $root = [IO.Path]::GetPathRoot($Path)
  if ([string]::IsNullOrWhiteSpace($root) -or $Path.TrimEnd('\') -eq $root.TrimEnd('\')) {
    throw "Refusing to use a filesystem root as the BoxSpec install directory."
  }
  if ($Path -eq [IO.Path]::GetFullPath($env:USERPROFILE)) {
    throw "Refusing to use the user profile root as the BoxSpec install directory."
  }
  if ((Test-Path -LiteralPath $Path) -and ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing a reparse-point install directory."
  }
}

function Get-Sha256Hex([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Remove-TrackedInstall([string]$InstallRoot) {
  $manifestPath = Join-Path $InstallRoot "installation.json"
  if (Test-Path -LiteralPath $manifestPath) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($version in @($manifest.installedVersions)) {
      if ($version -isnot [string] -or $version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
        throw "The installation manifest contains an unsafe version entry."
      }
      $versionPath = [IO.Path]::GetFullPath((Join-Path $InstallRoot "app-$version"))
      if (-not $versionPath.StartsWith("$($InstallRoot.TrimEnd('\'))\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "The installation manifest escapes the BoxSpec install directory."
      }
      if (Test-Path -LiteralPath $versionPath) {
        $item = Get-Item -LiteralPath $versionPath -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
          throw "Refusing to remove a reparse-point version directory."
        }
        Remove-Item -LiteralPath $versionPath -Recurse -Force
      }
    }
  }

  if ([string]::IsNullOrWhiteSpace($env:BOXSPEC_INSTALL_ROOT)) {
    $programs = [Environment]::GetFolderPath("Programs")
    $desktop = [Environment]::GetFolderPath("Desktop")
    foreach ($shortcut in @((Join-Path $programs "BoxSpec.lnk"), (Join-Path $desktop "BoxSpec.lnk"))) {
      Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BoxSpec" -Recurse -Force -ErrorAction SilentlyContinue
  }

  Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue
  $scriptPath = $PSCommandPath
  if ($scriptPath -and [IO.Path]::GetDirectoryName($scriptPath) -eq $InstallRoot) {
    Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
  }
  if ((Test-Path -LiteralPath $InstallRoot) -and -not (Get-ChildItem -LiteralPath $InstallRoot -Force | Select-Object -First 1)) {
    Remove-Item -LiteralPath $InstallRoot -Force
  }

  if (-not $Quiet) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
      "BoxSpec program files were removed. User profile state, contracts, and project repositories were preserved.",
      "BoxSpec uninstall"
    ) | Out-Null
  }
}

$installRoot = Get-InstallRoot
Assert-SafeInstallRoot $installRoot

if ($Uninstall) {
  Remove-TrackedInstall $installRoot
  exit 0
}

$releasePath = Join-Path $PSScriptRoot "release.json"
$archivePath = Join-Path $PSScriptRoot "boxspec-portable.zip"
$archiveHashPath = Join-Path $PSScriptRoot "portable.sha256"
foreach ($required in @($releasePath, $archivePath, $archiveHashPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Installer payload is incomplete: $required"
  }
}

$release = Get-Content -LiteralPath $releasePath -Raw | ConvertFrom-Json
$version = [string]$release.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
  throw "Installer release version is invalid."
}
$expectedHash = (Get-Content -LiteralPath $archiveHashPath -Raw).Trim().ToLowerInvariant()
$actualHash = Get-Sha256Hex $archivePath
if ($expectedHash -notmatch '^[0-9a-f]{64}$' -or $actualHash -ne $expectedHash) {
  throw "The BoxSpec portable payload failed SHA-256 verification."
}

New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
$stageRoot = Join-Path $installRoot (".install-" + [Guid]::NewGuid().ToString("N"))
$targetRoot = Join-Path $installRoot "app-$version"
$backupRoot = Join-Path $installRoot (".replaced-$version-" + [Guid]::NewGuid().ToString("N"))
$published = $false

try {
  Expand-Archive -LiteralPath $archivePath -DestinationPath $stageRoot -Force
  $payloadRoot = Join-Path $stageRoot "BoxSpec-win32-x64"
  if (-not (Test-Path -LiteralPath (Join-Path $payloadRoot "BoxSpec.exe") -PathType Leaf)) {
    throw "The verified payload does not contain BoxSpec.exe."
  }

  if (Test-Path -LiteralPath $targetRoot) {
    $existing = Get-Item -LiteralPath $targetRoot -Force
    if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Refusing to replace a reparse-point version directory."
    }
    Move-Item -LiteralPath $targetRoot -Destination $backupRoot
  }
  Move-Item -LiteralPath $payloadRoot -Destination $targetRoot
  $published = $true

  $manifestPath = Join-Path $installRoot "installation.json"
  $versions = @()
  if (Test-Path -LiteralPath $manifestPath) {
    $prior = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $versions += @($prior.installedVersions | Where-Object { $_ -is [string] })
  }
  $versions += $version
  $installManifest = [ordered]@{
    schemaVersion = 1
    currentVersion = $version
    installedVersions = @($versions | Sort-Object -Unique)
    installedAt = [DateTimeOffset]::UtcNow.ToString("O")
    portableSha256 = $actualHash
    signed = $false
  }
  $installManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $installRoot "uninstall.ps1") -Force

  if ([string]::IsNullOrWhiteSpace($env:BOXSPEC_INSTALL_ROOT)) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($shortcutPath in @(
      (Join-Path ([Environment]::GetFolderPath("Programs")) "BoxSpec.lnk"),
      (Join-Path ([Environment]::GetFolderPath("Desktop")) "BoxSpec.lnk")
    )) {
      $shortcut = $shell.CreateShortcut($shortcutPath)
      $shortcut.TargetPath = Join-Path $targetRoot "BoxSpec.exe"
      $shortcut.WorkingDirectory = $targetRoot
      $shortcut.Description = "BoxSpec local-first layout contract editor"
      $shortcut.Save()
    }

    $uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BoxSpec"
    New-Item -Path $uninstallKey -Force | Out-Null
    $uninstallCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}" -Uninstall' -f (Join-Path $installRoot "uninstall.ps1")
    New-ItemProperty -Path $uninstallKey -Name DisplayName -Value "BoxSpec" -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name DisplayVersion -Value $version -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name Publisher -Value "BoxSpec" -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name InstallLocation -Value $installRoot -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name UninstallString -Value $uninstallCommand -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
  }

  if (Test-Path -LiteralPath $backupRoot) {
    Remove-Item -LiteralPath $backupRoot -Recurse -Force
  }
} catch {
  if ($published -and (Test-Path -LiteralPath $targetRoot)) {
    $publishedItem = Get-Item -LiteralPath $targetRoot -Force
    if (-not ($publishedItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      Remove-Item -LiteralPath $targetRoot -Recurse -Force
    }
  }
  if (Test-Path -LiteralPath $backupRoot) {
    Move-Item -LiteralPath $backupRoot -Destination $targetRoot
  }
  throw
} finally {
  Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not $Quiet) {
  Start-Process -FilePath (Join-Path $targetRoot "BoxSpec.exe")
}
