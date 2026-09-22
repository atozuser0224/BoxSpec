[CmdletBinding()]
param(
  [string]$OutputRoot,
  [switch]$SkipBuild,
  [switch]$SkipInstaller,
  [switch]$UnpackedOnly,
  [switch]$RefreshVerificationArtifacts
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $repoRoot "build\windows"
}
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$buildRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "build"))
if (-not $OutputRoot.StartsWith("$($buildRoot.TrimEnd('\'))\", [StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputRoot must be a child of $buildRoot"
}
if ($env:OS -ne "Windows_NT") {
  throw "The B15 package is a Windows artifact and must be built on Windows."
}

function Invoke-Checked([string]$Label, [string]$Command, [string[]]$Arguments) {
  Write-Host "[$Label] $Command $($Arguments -join ' ')"
  & $Command @Arguments
  $exitCode = if (Test-Path variable:LASTEXITCODE) { $LASTEXITCODE } else { 0 }
  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode."
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

function Write-Utf8NoBomJson([object]$Value, [string]$Path, [int]$Depth = 8) {
  $json = $Value | ConvertTo-Json -Depth $Depth
  [IO.File]::WriteAllText($Path, $json, [Text.UTF8Encoding]::new($false))
}

function Get-PackagedAsset([string]$ResourcesRoot, [string]$Path) {
  $resourcesPath = [IO.Path]::GetFullPath($ResourcesRoot).TrimEnd('\')
  $assetPath = [IO.Path]::GetFullPath($Path)
  if (-not $assetPath.StartsWith("$resourcesPath\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Verification asset escapes the resources directory: $assetPath"
  }
  $relativePath = $assetPath.Substring($resourcesPath.Length + 1).Replace('\', '/')
  return [ordered]@{
    relativePath = $relativePath
    sha256 = Get-Sha256Hex $assetPath
    sizeBytes = (Get-Item -LiteralPath $assetPath).Length
  }
}

function New-AssetClosureManifest(
  [string]$ResourcesRoot,
  [string]$ClosureRoot,
  [string]$ClosureRelativePath,
  [string]$Destination
) {
  $rootPath = [IO.Path]::GetFullPath($ClosureRoot)
  foreach ($directory in @($rootPath) + @([IO.Directory]::EnumerateDirectories($rootPath, '*', [IO.SearchOption]::AllDirectories))) {
    if (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Verification closure contains a reparse-point directory: $directory"
    }
  }
  $relativePaths = [string[]]@([IO.Directory]::EnumerateFiles($rootPath, '*', [IO.SearchOption]::AllDirectories) | ForEach-Object {
    $file = [IO.Path]::GetFullPath($_)
    if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Verification closure contains a reparse-point file: $file"
    }
    "$ClosureRelativePath/$($file.Substring($rootPath.TrimEnd('\').Length + 1).Replace('\', '/'))"
  })
  [Array]::Sort($relativePaths, [StringComparer]::Ordinal)
  $caseFolded = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $entries = foreach ($relativePath in $relativePaths) {
    foreach ($segment in $relativePath.Split('/')) {
      $stem = $segment.Split('.')[0].ToUpperInvariant()
      if ([string]::IsNullOrWhiteSpace($segment) -or $segment -eq '.' -or $segment -eq '..' -or
          $segment.Contains(':') -or $segment.Contains('\') -or $segment.EndsWith('.') -or $segment.EndsWith(' ') -or
          $stem -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') {
        throw "Verification closure contains an unsafe Windows path: $relativePath"
      }
    }
    if (-not $caseFolded.Add($relativePath)) { throw "Verification closure contains a Windows case-fold alias: $relativePath" }
    Get-PackagedAsset $ResourcesRoot (Join-Path $ResourcesRoot $relativePath.Replace('/', '\'))
  }
  if ($entries.Count -eq 0) { throw "Verification closure is empty: $ClosureRelativePath" }
  $manifest = [ordered]@{ schemaVersion = "1.0.0"; root = $ClosureRelativePath; entries = @($entries) }
  Write-Utf8NoBomJson $manifest $Destination 6
  return $manifest
}

function Get-SourceSnapshot {
  $files = @((Join-Path $repoRoot "pnpm-lock.yaml"))
  $files += Get-ChildItem -LiteralPath (Join-Path $repoRoot "apps"), (Join-Path $repoRoot "packages"), (Join-Path $repoRoot "samples") -Filter "package.json" -File -Recurse |
    ForEach-Object FullName
  $hashes = [ordered]@{}
  foreach ($file in ($files | Sort-Object -Unique)) { $hashes[$file] = Get-Sha256Hex $file }
  $links = [ordered]@{}
  foreach ($relative in @(
    "apps\desktop\node_modules\@electron\packager",
    "apps\desktop\node_modules\electron",
    "apps\desktop\node_modules\@boxspec\local-ipc"
  )) {
    $path = Join-Path $repoRoot $relative
    if (-not (Test-Path -LiteralPath $path)) { throw "Frozen source dependency link is missing: $relative" }
    $item = Get-Item -LiteralPath $path -Force
    $links[$relative] = [ordered]@{ target = [string]$item.Target; resolved = (Resolve-Path -LiteralPath $path).Path }
  }
  return [pscustomobject]@{ hashes = $hashes; links = $links }
}

function Assert-SourceSnapshot([object]$Before) {
  $after = Get-SourceSnapshot
  if (($Before.hashes | ConvertTo-Json -Depth 5 -Compress) -ne ($after.hashes | ConvertTo-Json -Depth 5 -Compress)) {
    throw "Packaging changed a source lockfile or package manifest."
  }
  if (($Before.links | ConvertTo-Json -Depth 5 -Compress) -ne ($after.links | ConvertTo-Json -Depth 5 -Compress)) {
    throw "Packaging changed a source-root dependency link."
  }
}

function Copy-PackageSnapshot([string]$Destination) {
  $destinationPath = [IO.Path]::GetFullPath($Destination)
  if (-not $destinationPath.StartsWith("$($buildRoot.TrimEnd('\'))\", [StringComparison]::OrdinalIgnoreCase) -or
      $destinationPath.StartsWith("$($repoRoot.TrimEnd('\'))\apps\", [StringComparison]::OrdinalIgnoreCase) -or
      $destinationPath.StartsWith("$($repoRoot.TrimEnd('\'))\packages\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "The isolated package workspace must be a child of build and outside source workspaces."
  }
  if (Test-Path -LiteralPath $destinationPath) { Remove-BuildTree $destinationPath }
  New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
  foreach ($rootFile in @("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml")) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $rootFile) -Destination (Join-Path $destinationPath $rootFile)
  }
  $installHelper = Join-Path $repoRoot "scripts\install-electron.mjs"
  if (Test-Path -LiteralPath $installHelper -PathType Leaf) {
    New-Item -ItemType Directory -Path (Join-Path $destinationPath "scripts") -Force | Out-Null
    Copy-Item -LiteralPath $installHelper -Destination (Join-Path $destinationPath "scripts\install-electron.mjs")
  }
  $manifests = Get-ChildItem -LiteralPath (Join-Path $repoRoot "apps"), (Join-Path $repoRoot "packages"), (Join-Path $repoRoot "samples") -Filter "package.json" -File -Recurse
  foreach ($manifest in $manifests) {
    $packageSource = $manifest.Directory.FullName
    $relative = $packageSource.Substring($repoRoot.Length).TrimStart('\')
    $packageTarget = Join-Path $destinationPath $relative
    New-Item -ItemType Directory -Path $packageTarget -Force | Out-Null
    Copy-Item -LiteralPath $manifest.FullName -Destination (Join-Path $packageTarget "package.json")
    foreach ($asset in @("dist", "contracts", "src\schema")) {
      $assetSource = Join-Path $packageSource $asset
      if (Test-Path -LiteralPath $assetSource) {
        $assetTarget = Join-Path $packageTarget $asset
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($assetTarget)) -Force | Out-Null
        Copy-Item -LiteralPath $assetSource -Destination $assetTarget -Recurse
      }
    }
  }
}

function Remove-BuildTree([string]$Path) {
  $resolved = [IO.Path]::GetFullPath($Path)
  if (-not $resolved.StartsWith("$($buildRoot.TrimEnd('\'))\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a directory outside $buildRoot"
  }
  if ([IO.Directory]::Exists($resolved)) {
    $extended = if ($resolved.StartsWith('\\?\')) { $resolved } else { "\\?\$resolved" }
    foreach ($file in [IO.Directory]::EnumerateFiles($extended, '*', [IO.SearchOption]::AllDirectories)) {
      [IO.File]::SetAttributes($file, [IO.FileAttributes]::Normal)
    }
    $directories = [IO.Directory]::EnumerateDirectories($extended, '*', [IO.SearchOption]::AllDirectories) | Sort-Object Length -Descending
    foreach ($directory in $directories) {
      try {
        $attributes = [IO.File]::GetAttributes($directory)
        [IO.File]::SetAttributes($directory, ($attributes -band (-bnot [IO.FileAttributes]::ReadOnly)))
        [IO.Directory]::Delete($directory, $false)
      } catch {
        # A parent may still contain a package-manager link target; the final recursive delete is authoritative.
      }
    }
    [IO.Directory]::Delete($extended, $true)
  }
}

function New-DeterministicZip([string]$Source, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression
  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Force
  }
  $sourcePath = [IO.Path]::GetFullPath($Source).TrimEnd('\')
  $enumerationRoot = if ($sourcePath.StartsWith('\\?\')) { $sourcePath } else { "\\?\$sourcePath" }
  $stream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
      $files = [IO.Directory]::EnumerateFiles($enumerationRoot, '*', [IO.SearchOption]::AllDirectories) | Sort-Object
      foreach ($file in $files) {
        $relative = $file.Substring($enumerationRoot.Length).TrimStart('\').Replace('\', '/')
        $entryName = "BoxSpec-win32-x64/$relative"
        $entry = $archive.CreateEntry($entryName, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        $input = [IO.File]::OpenRead($file)
        $output = $entry.Open()
        try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
      }
    } finally {
      $archive.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function New-IExpressInstaller([string]$PayloadRoot, [string]$Destination) {
  $iexpress = Join-Path $env:WINDIR "System32\iexpress.exe"
  if (-not (Test-Path -LiteralPath $iexpress -PathType Leaf)) {
    throw "Windows IExpress is unavailable; portable artifact remains usable."
  }
  $sedPath = Join-Path $PayloadRoot "BoxSpec.sed"
  $source = "$($PayloadRoot.TrimEnd('\'))\"
  $sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
Compress=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$Destination
FriendlyName=BoxSpec per-user installer
AppLaunched=powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Quiet
UserQuietInstCmd=powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Quiet
FILE0=install.ps1
FILE1=release.json
FILE2=boxspec-portable.zip
FILE3=portable.sha256
[SourceFiles]
SourceFiles0=$source
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
%FILE3%=
"@
  [IO.File]::WriteAllText($sedPath, $sed, [Text.UTF8Encoding]::new($false))
  Invoke-Checked "iexpress" $iexpress @("/N", "/Q", $sedPath)
  $deadline = [DateTimeOffset]::UtcNow.AddMinutes(20)
  $ready = $false
  $stableLength = [long]-1
  $stableSince = [DateTimeOffset]::MinValue
  while (-not $ready -and [DateTimeOffset]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
      try {
        $probe = [IO.File]::Open($Destination, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        $currentLength = $probe.Length
        $probe.Dispose()
        if ($currentLength -gt 0 -and $currentLength -eq $stableLength) {
          if (([DateTimeOffset]::UtcNow - $stableSince).TotalSeconds -ge 5) { $ready = $true }
        } else {
          $stableLength = $currentLength
          $stableSince = [DateTimeOffset]::UtcNow
        }
        if (-not $ready) { Start-Sleep -Milliseconds 500 }
      } catch [IO.IOException] {
        $stableLength = [long]-1
        $stableSince = [DateTimeOffset]::MinValue
        Start-Sleep -Milliseconds 500
      }
    } else {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $ready) {
    throw "IExpress did not create $Destination within twenty minutes."
  }
}

Set-Location $repoRoot
$desktopManifestPath = Join-Path $repoRoot "apps\desktop\package.json"
$desktopManifest = Get-Content -LiteralPath $desktopManifestPath -Raw | ConvertFrom-Json
$version = [string]$desktopManifest.version
$electronVersion = [string]$desktopManifest.devDependencies.electron
$packagerVersion = [string]$desktopManifest.devDependencies.'@electron/packager'
if ($electronVersion.StartsWith('^') -or $electronVersion.StartsWith('~')) {
  throw "Electron must be pinned exactly before release packaging."
}
if ($packagerVersion.StartsWith('^') -or $packagerVersion.StartsWith('~')) {
  throw "@electron/packager must be pinned exactly before release packaging."
}
$sourceSnapshot = Get-SourceSnapshot
$packagerCli = Join-Path $repoRoot "apps\desktop\node_modules\@electron\packager\bin\electron-packager.mjs"
if (-not (Test-Path -LiteralPath $packagerCli -PathType Leaf)) {
  throw "The pinned @electron/packager CLI is missing from the frozen install."
}

if ($RefreshVerificationArtifacts) {
  $packageDir = Join-Path $OutputRoot "unpacked\BoxSpec-win32-x64"
  $packageExe = Join-Path $packageDir "BoxSpec.exe"
  $resourcesRoot = Join-Path $packageDir "resources"
  $verificationManifestPath = Join-Path $resourcesRoot "verification-tools.json"
  $developmentVerificationRoot = Join-Path $buildRoot "verification-dev"
  foreach ($requiredPath in @($packageExe, $verificationManifestPath, (Join-Path $developmentVerificationRoot "verification-tools.json"))) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) { throw "Refresh input is missing: $requiredPath" }
  }
  foreach ($runnerName in @("typecheck-runner.mjs", "vite-build-runner.mjs")) {
    $runnerSource = Join-Path $repoRoot "packages\verifier\assets\runners\$runnerName"
    Copy-Item -LiteralPath $runnerSource -Destination (Join-Path $resourcesRoot "verification\runners\$runnerName") -Force
    Copy-Item -LiteralPath $runnerSource -Destination (Join-Path $developmentVerificationRoot "verification\runners\$runnerName") -Force
  }
  foreach ($manifestRoot in @($resourcesRoot, $developmentVerificationRoot)) {
    $manifestPath = Join-Path $manifestRoot "verification-tools.json"
    $verificationManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $verificationManifest.typecheck.entryPoint = Get-PackagedAsset $manifestRoot (Join-Path $manifestRoot "verification\runners\typecheck-runner.mjs")
    $verificationManifest.build.entryPoint = Get-PackagedAsset $manifestRoot (Join-Path $manifestRoot "verification\runners\vite-build-runner.mjs")
    Write-Utf8NoBomJson $verificationManifest $manifestPath 8
  }
  Assert-SourceSnapshot $sourceSnapshot

  $portableName = "BoxSpec-$version-win-x64-portable.zip"
  $portablePath = Join-Path $OutputRoot $portableName
  New-DeterministicZip $packageDir $portablePath
  $portableHash = Get-Sha256Hex $portablePath
  $release = [ordered]@{ schemaVersion = 1; product = "BoxSpec"; version = $version; platform = "win32"; arch = "x64"; portableSha256 = $portableHash; signed = $false }
  $installerPath = Join-Path $OutputRoot "BoxSpec-$version-win-x64-setup-unsigned.exe"
  if (Test-Path -LiteralPath $installerPath) { Remove-Item -LiteralPath $installerPath -Force }
  $payloadRoot = Join-Path $OutputRoot "stage\installer"
  if (Test-Path -LiteralPath $payloadRoot) { Remove-BuildTree $payloadRoot }
  New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repoRoot "apps\desktop\packaging\install.ps1") -Destination (Join-Path $payloadRoot "install.ps1")
  Copy-Item -LiteralPath $portablePath -Destination (Join-Path $payloadRoot "boxspec-portable.zip")
  [IO.File]::WriteAllText((Join-Path $payloadRoot "portable.sha256"), "$portableHash`r`n", [Text.ASCIIEncoding]::new())
  Write-Utf8NoBomJson $release (Join-Path $payloadRoot "release.json") 4
  New-IExpressInstaller $payloadRoot $installerPath

  $artifactManifestPath = Join-Path $OutputRoot "artifact-manifest.json"
  $artifactManifest = Get-Content -LiteralPath $artifactManifestPath -Raw | ConvertFrom-Json
  $artifactManifest.createdAt = [DateTimeOffset]::UtcNow.ToString("O")
  $artifactManifest.verificationTools.manifestSha256 = Get-Sha256Hex $verificationManifestPath
  $artifactManifest.sha256.portable = $portableHash
  $artifactManifest.sha256.installer = Get-Sha256Hex $installerPath
  $artifactManifest.sha256.verificationManifest = Get-Sha256Hex $verificationManifestPath
  Write-Utf8NoBomJson $artifactManifest $artifactManifestPath 8
  $hashLines = @(
    "$($artifactManifest.sha256.executable)  BoxSpec.exe",
    "$($artifactManifest.sha256.asar)  app.asar",
    "$($artifactManifest.sha256.nativeSafeFs)  boxspec-safe-fs.exe",
    "$($artifactManifest.sha256.verificationManifest)  verification-tools.json",
    "$($artifactManifest.sha256.portable)  $portableName",
    "$($artifactManifest.sha256.installer)  $([IO.Path]::GetFileName($installerPath))"
  )
  [IO.File]::WriteAllLines((Join-Path $OutputRoot "SHA256SUMS"), $hashLines, [Text.ASCIIEncoding]::new())
  Write-Host "BoxSpec verification resources and artifacts refreshed in $OutputRoot"
  return
}

if (-not $SkipBuild) {
  Invoke-Checked "workspace build" "pnpm" @("--filter", "@boxspec/desktop...", "build")
  Invoke-Checked "MCP launcher build" "pnpm" @("--filter", "@boxspec/mcp...", "build")
}

if (Test-Path -LiteralPath $OutputRoot) {
  Remove-BuildTree $OutputRoot
}
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
$stageRoot = Join-Path $OutputRoot "stage"
$stageApp = Join-Path $stageRoot "app"
$packagerOut = Join-Path $OutputRoot "unpacked"
New-Item -ItemType Directory -Path $stageRoot, $packagerOut -Force | Out-Null

$isolatedWorkspace = Join-Path $buildRoot "package-workspace"
Copy-PackageSnapshot $isolatedWorkspace
if ([IO.Path]::GetFullPath($isolatedWorkspace) -eq $repoRoot) { throw "Refusing to install in the source workspace." }
Push-Location $isolatedWorkspace
try {
  Invoke-Checked "isolated production install" "pnpm" @("install", "--prod", "--frozen-lockfile", "--offline")
  Invoke-Checked "isolated desktop deploy" "pnpm" @("--config.node-linker=hoisted", "--config.inject-workspace-packages=true", "--filter", "@boxspec/desktop", "--prod", "deploy", $stageApp)
} finally {
  Pop-Location
}
Assert-SourceSnapshot $sourceSnapshot
foreach ($relativeDependency in @(
  "node_modules\@boxspec\core",
  "node_modules\@boxspec\runtime",
  "node_modules\@boxspec\themes",
  "node_modules\@boxspec\verifier",
  "node_modules\better-sqlite3"
)) {
  $dependencyPath = Join-Path $stageApp $relativeDependency
  if (-not (Test-Path -LiteralPath $dependencyPath -PathType Container) -or
      -not [string]::IsNullOrWhiteSpace([string](Get-Item -LiteralPath $dependencyPath -Force).LinkType)) {
    throw "The standalone desktop deploy did not materialize $relativeDependency as a real directory."
  }
}
$stageMetadata = [ordered]@{
  product = "BoxSpec"
  version = $version
  electron = $electronVersion
  packager = $packagerVersion
  platform = "win32"
  arch = "x64"
  signed = $false
  browserBundled = $true
  updateClientImplemented = $false
}
$stageMetadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stageApp "packaging-metadata.json") -Encoding UTF8

$packagerArguments = @(
  $stageApp, "BoxSpec",
  "--platform=win32", "--arch=x64", "--electron-version=$electronVersion",
  "--out=$packagerOut", "--overwrite", "--asar", "--no-prune",
  "--executable-name=BoxSpec", "--app-version=$version",
  "--win32metadata.CompanyName=BoxSpec",
  "--win32metadata.ProductName=BoxSpec",
  "--win32metadata.FileDescription=BoxSpec local-first layout contract editor",
  "--win32metadata.OriginalFilename=BoxSpec.exe",
  "--win32metadata.requested-execution-level=asInvoker"
)
Invoke-Checked "electron package" "node" (@($packagerCli) + $packagerArguments)

$packageDir = Join-Path $packagerOut "BoxSpec-win32-x64"
$packageExe = Join-Path $packageDir "BoxSpec.exe"
if (-not (Test-Path -LiteralPath $packageExe -PathType Leaf)) {
  throw "Packager output is missing BoxSpec.exe."
}
$nativeBinding = Get-ChildItem -LiteralPath (Join-Path $packageDir "resources\app.asar.unpacked") -Filter "win32-x64.node" -File -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'better-sqlite3' } |
  Select-Object -First 1
if (-not $nativeBinding) {
  throw "Packaged better-sqlite3 native binding is missing from app.asar.unpacked."
}

$bridgeEntry = Join-Path $repoRoot "apps\mcp\dist\index.js"
$bridgeIncluded = Test-Path -LiteralPath $bridgeEntry -PathType Leaf
if ($bridgeIncluded) {
  $bridgeTarget = Join-Path $packageDir "resources\mcp"
  Push-Location $isolatedWorkspace
  try {
    Invoke-Checked "isolated MCP deploy" "pnpm" @("--config.node-linker=hoisted", "--config.inject-workspace-packages=true", "--filter", "@boxspec/mcp", "--prod", "deploy", $bridgeTarget)
  } finally {
    Pop-Location
  }
  Assert-SourceSnapshot $sourceSnapshot
}

$nativeManifestModule = Join-Path $repoRoot "packages\shared\dist\native-tools.js"
if (-not (Test-Path -LiteralPath $nativeManifestModule -PathType Leaf)) {
  throw "The built @boxspec/shared/native-tools manifest is missing."
}
$nativeManifestJson = & node --input-type=module -e "import { NATIVE_SAFE_FS_MANIFEST } from './packages/shared/dist/native-tools.js'; process.stdout.write(JSON.stringify(NATIVE_SAFE_FS_MANIFEST));"
if ($LASTEXITCODE -ne 0) { throw "Could not read @boxspec/shared/native-tools." }
$nativeManifest = $nativeManifestJson | ConvertFrom-Json
if ($nativeManifest.protocol -ne 1 -or $nativeManifest.invocationArgs.Count -ne 2 -or
    $nativeManifest.invocationArgs[0] -ne "--protocol" -or $nativeManifest.invocationArgs[1] -ne "1") {
  throw "The native safe-filesystem manifest protocol is unsupported."
}
$nativeHelperSource = Join-Path $repoRoot ([string]$nativeManifest.developmentRelativePath).Replace('/', '\')
$nativeHelperExpectedHash = [string]$nativeManifest.sha256
if (-not (Test-Path -LiteralPath $nativeHelperSource -PathType Leaf)) {
  throw "The independently tested native safe-filesystem helper is missing."
}
$nativeHelperSize = (Get-Item -LiteralPath $nativeHelperSource).Length
if ($nativeHelperSize -ne [long]$nativeManifest.sizeBytes) {
  throw "The native safe-filesystem helper size does not match @boxspec/shared/native-tools."
}
$nativeHelperHash = Get-Sha256Hex $nativeHelperSource
if ($nativeHelperHash -ne $nativeHelperExpectedHash) {
  throw "The native safe-filesystem helper does not match the independently tested hash."
}
$nativeStagingTarget = Join-Path $buildRoot "native\win32-x64\boxspec-safe-fs.exe"
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($nativeStagingTarget)) -Force | Out-Null
Copy-Item -LiteralPath $nativeHelperSource -Destination $nativeStagingTarget -Force
if ((Get-Sha256Hex $nativeStagingTarget) -ne $nativeHelperExpectedHash) {
  throw "The staged native safe-filesystem helper failed its post-copy hash check."
}
$nativeHelperTarget = Join-Path $packageDir ([string]$nativeManifest.packagedRelativePath).Replace('/', '\')
$nativeHelperTarget = [IO.Path]::GetFullPath($nativeHelperTarget)
if (-not $nativeHelperTarget.StartsWith("$($packageDir.TrimEnd('\'))\", [StringComparison]::OrdinalIgnoreCase)) {
  throw "The native safe-filesystem manifest escapes the package directory."
}
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($nativeHelperTarget)) -Force | Out-Null
Copy-Item -LiteralPath $nativeStagingTarget -Destination $nativeHelperTarget
if ((Get-Sha256Hex $nativeHelperTarget) -ne $nativeHelperExpectedHash -or
    (Get-Item -LiteralPath $nativeHelperTarget).Length -ne $nativeHelperSize) {
  throw "The packaged native safe-filesystem helper failed its post-copy identity check."
}

$resourcesRoot = Join-Path $packageDir "resources"
$verificationRoot = Join-Path $resourcesRoot "verification"
$verificationToolchainRoot = Join-Path $verificationRoot "toolchain"
$verificationToolchainDeploy = Join-Path $stageRoot "verification-toolchain"
Push-Location $isolatedWorkspace
try {
  Invoke-Checked "isolated verification toolchain deploy" "pnpm" @("--config.node-linker=hoisted", "--config.inject-workspace-packages=true", "--filter", "@boxspec/sample-react-dashboard", "deploy", $verificationToolchainDeploy)
} finally {
  Pop-Location
}
Assert-SourceSnapshot $sourceSnapshot
$toolchainNodeModules = Join-Path $verificationToolchainRoot "node_modules"
New-Item -ItemType Directory -Path $toolchainNodeModules -Force | Out-Null
$deployedNodeModules = Join-Path $verificationToolchainDeploy "node_modules"
foreach ($dependency in Get-ChildItem -LiteralPath $deployedNodeModules -Force | Where-Object { -not $_.Name.StartsWith('.') }) {
  if (-not [string]::IsNullOrWhiteSpace([string]$dependency.LinkType)) {
    throw "Verification toolchain dependency remained a link: $($dependency.FullName)"
  }
  Copy-Item -LiteralPath $dependency.FullName -Destination (Join-Path $toolchainNodeModules $dependency.Name) -Recurse -Force
}
foreach ($requiredTool in @(
  "typescript\lib\tsc.js",
  "@typescript\typescript-win32-x64\lib\tsc.exe",
  "vite\dist\node\index.js",
  "react\index.js",
  "react-dom\index.js",
  "@types\react",
  "@types\react-dom"
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $toolchainNodeModules $requiredTool))) {
    throw "Verification toolchain is missing $requiredTool"
  }
}

$runnerRoot = Join-Path $verificationRoot "runners"
$fixtureRoot = Join-Path $verificationRoot "fixtures"
$manifestRoot = Join-Path $verificationRoot "manifests"
New-Item -ItemType Directory -Path $runnerRoot, $fixtureRoot, $manifestRoot -Force | Out-Null
foreach ($runnerName in @("typecheck-runner.mjs", "vite-build-runner.mjs")) {
  Copy-Item -LiteralPath (Join-Path $repoRoot "packages\verifier\assets\runners\$runnerName") -Destination (Join-Path $runnerRoot $runnerName) -Force
}
$fixtureIds = @("empty", "loading", "error", "long-text", "populated")
foreach ($fixtureId in $fixtureIds) {
  Copy-Item -LiteralPath (Join-Path $repoRoot "packages\verifier\assets\fixtures\$fixtureId.json") -Destination (Join-Path $fixtureRoot "$fixtureId.json") -Force
}

$browserCacheRoot = Join-Path $env:LOCALAPPDATA "ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64"
$browserSourceExe = Join-Path $browserCacheRoot "chrome-headless-shell.exe"
$browserExpectedHash = "addfa79abb060e1e514e155ed745d4bf96140bca402735958bb4e223aea0b98c"
if (-not (Test-Path -LiteralPath $browserSourceExe -PathType Leaf) -or (Get-Sha256Hex $browserSourceExe) -ne $browserExpectedHash) {
  throw "The pinned Playwright 1.63.0 Chromium 1243 runtime is unavailable or untrusted."
}
$browserRoot = Join-Path $verificationRoot "browser"
New-Item -ItemType Directory -Path $browserRoot -Force | Out-Null
foreach ($browserAsset in Get-ChildItem -LiteralPath $browserCacheRoot -Force | Where-Object Name -ne "debug.log") {
  Copy-Item -LiteralPath $browserAsset.FullName -Destination (Join-Path $browserRoot $browserAsset.Name) -Recurse -Force
}
$browserTargetExe = Join-Path $browserRoot "chrome-headless-shell.exe"
if ((Get-Sha256Hex $browserTargetExe) -ne $browserExpectedHash) { throw "Packaged Chromium failed its post-copy hash check." }

$toolchainClosurePath = Join-Path $manifestRoot "toolchain.json"
$browserClosurePath = Join-Path $manifestRoot "browser.json"
$toolchainClosure = New-AssetClosureManifest $resourcesRoot $verificationToolchainRoot "verification/toolchain" $toolchainClosurePath
$browserClosure = New-AssetClosureManifest $resourcesRoot $browserRoot "verification/browser" $browserClosurePath

$typecheckRunner = Join-Path $runnerRoot "typecheck-runner.mjs"
$buildRunner = Join-Path $runnerRoot "vite-build-runner.mjs"
$fixtureAssets = foreach ($fixtureId in $fixtureIds) {
  $identity = Get-PackagedAsset $resourcesRoot (Join-Path $fixtureRoot "$fixtureId.json")
  [ordered]@{ id = $fixtureId; relativePath = $identity.relativePath; sha256 = $identity.sha256; sizeBytes = $identity.sizeBytes }
}
$verificationToolsManifest = [ordered]@{
  schemaVersion = "1.0.0"
  verificationProfileId = "managed-react-vite-p1"
  executionProfileId = "managed-react-vite-p1"
  generatorVersion = "boxspec-managed-react-1.0.0"
  applicationExecutable = [ordered]@{ sha256 = Get-Sha256Hex $packageExe; sizeBytes = (Get-Item -LiteralPath $packageExe).Length }
  typecheck = [ordered]@{
    entryPoint = Get-PackagedAsset $resourcesRoot $typecheckRunner
    args = @("{outputDir}")
    cwd = "."
    timeoutMs = 60000
    environment = [ordered]@{ ELECTRON_RUN_AS_NODE = "1" }
  }
  build = [ordered]@{
    entryPoint = Get-PackagedAsset $resourcesRoot $buildRunner
    args = @("{outputDir}")
    cwd = "."
    timeoutMs = 120000
    environment = [ordered]@{ ELECTRON_RUN_AS_NODE = "1" }
  }
  toolchainManifest = Get-PackagedAsset $resourcesRoot $toolchainClosurePath
  browser = [ordered]@{
    relativePath = (Get-PackagedAsset $resourcesRoot $browserTargetExe).relativePath
    sha256 = Get-Sha256Hex $browserTargetExe
    sizeBytes = (Get-Item -LiteralPath $browserTargetExe).Length
    engine = "chromium"
    playwrightVersion = "1.63.0"
    chromiumRevision = "1243"
    browserVersion = "153.0.8010.12"
  }
  browserManifest = Get-PackagedAsset $resourcesRoot $browserClosurePath
  fixtures = @($fixtureAssets)
  route = "/index.html"
  outputDirectoryName = "dist"
  fixtureQueryParameter = "fixture"
}
$verificationManifestPath = Join-Path $resourcesRoot "verification-tools.json"
Write-Utf8NoBomJson $verificationToolsManifest $verificationManifestPath 8

$developmentVerificationRoot = Join-Path $buildRoot "verification-dev"
if (Test-Path -LiteralPath $developmentVerificationRoot) { Remove-BuildTree $developmentVerificationRoot }
New-Item -ItemType Directory -Path $developmentVerificationRoot -Force | Out-Null
Copy-Item -LiteralPath $verificationRoot -Destination (Join-Path $developmentVerificationRoot "verification") -Recurse -Force
$developmentElectron = Join-Path $repoRoot "apps\desktop\node_modules\electron\dist\electron.exe"
if (-not (Test-Path -LiteralPath $developmentElectron -PathType Leaf)) { throw "Development Electron executable is missing." }
$developmentManifest = $verificationToolsManifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$developmentManifest.applicationExecutable.sha256 = Get-Sha256Hex $developmentElectron
$developmentManifest.applicationExecutable.sizeBytes = (Get-Item -LiteralPath $developmentElectron).Length
Write-Utf8NoBomJson $developmentManifest (Join-Path $developmentVerificationRoot "verification-tools.json") 8

if ($UnpackedOnly) {
  Write-Host "BoxSpec unpacked Windows candidate created at $packageDir"
  return
}

$portableName = "BoxSpec-$version-win-x64-portable.zip"
$portablePath = Join-Path $OutputRoot $portableName
New-DeterministicZip $packageDir $portablePath
$portableHash = Get-Sha256Hex $portablePath

$release = [ordered]@{
  schemaVersion = 1
  product = "BoxSpec"
  version = $version
  platform = "win32"
  arch = "x64"
  portableSha256 = $portableHash
  signed = $false
}
$installerPath = Join-Path $OutputRoot "BoxSpec-$version-win-x64-setup-unsigned.exe"
if (-not $SkipInstaller) {
  $payloadRoot = Join-Path $stageRoot "installer"
  New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repoRoot "apps\desktop\packaging\install.ps1") -Destination (Join-Path $payloadRoot "install.ps1")
  Copy-Item -LiteralPath $portablePath -Destination (Join-Path $payloadRoot "boxspec-portable.zip")
  [IO.File]::WriteAllText((Join-Path $payloadRoot "portable.sha256"), "$portableHash`r`n", [Text.ASCIIEncoding]::new())
  $release | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $payloadRoot "release.json") -Encoding UTF8
  New-IExpressInstaller $payloadRoot $installerPath
}

$outputs = [ordered]@{
  unpackedDirectory = $packageDir
  executable = $packageExe
  portable = $portablePath
  installer = if (Test-Path -LiteralPath $installerPath) { $installerPath } else { $null }
}
$hashes = [ordered]@{
  executable = Get-Sha256Hex $packageExe
  portable = $portableHash
  installer = if (Test-Path -LiteralPath $installerPath) { Get-Sha256Hex $installerPath } else { $null }
  asar = Get-Sha256Hex (Join-Path $packageDir "resources\app.asar")
  nativeSafeFs = Get-Sha256Hex $nativeHelperTarget
  verificationManifest = Get-Sha256Hex $verificationManifestPath
}
$signature = Get-AuthenticodeSignature -FilePath $packageExe
$manifest = [ordered]@{
  schemaVersion = 1
  createdAt = [DateTimeOffset]::UtcNow.ToString("O")
  product = "BoxSpec"
  version = $version
  electron = $electronVersion
  packager = $packagerVersion
  node = (node --version)
  pnpm = (pnpm --version)
  sourceLockSha256 = [string]$sourceSnapshot.hashes[(Join-Path $repoRoot "pnpm-lock.yaml")]
  sourceSnapshotUnchanged = $true
  platform = "win32"
  arch = "x64"
  asar = $true
  bridgeIncluded = $bridgeIncluded
  nativeSqliteBinding = $nativeBinding.FullName
  nativeSafeFs = [ordered]@{
    path = $nativeHelperTarget
    sha256 = $nativeHelperHash
    sizeBytes = $nativeHelperSize
    protocol = [int]$nativeManifest.protocol
    invocationArgs = @($nativeManifest.invocationArgs)
    sourceVerified = $true
  }
  browserBundled = $true
  verificationTools = [ordered]@{
    manifestPath = $verificationManifestPath
    manifestSha256 = $hashes.verificationManifest
    toolchainFiles = @($toolchainClosure.entries).Count
    browserFiles = @($browserClosure.entries).Count
    playwrightVersion = "1.63.0"
    chromiumRevision = "1243"
  }
  signed = $false
  signatureStatus = [string]$signature.Status
  updateClientImplemented = $false
  outputs = $outputs
  sha256 = $hashes
}
$manifestPath = Join-Path $OutputRoot "artifact-manifest.json"
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
$hashLines = @(
  "$($hashes.executable)  $([IO.Path]::GetFileName($packageExe))",
  "$($hashes.asar)  app.asar",
  "$($hashes.nativeSafeFs)  boxspec-safe-fs.exe",
  "$($hashes.verificationManifest)  verification-tools.json",
  "$($hashes.portable)  $portableName"
)
if ($hashes.installer) { $hashLines += "$($hashes.installer)  $([IO.Path]::GetFileName($installerPath))" }
[IO.File]::WriteAllLines((Join-Path $OutputRoot "SHA256SUMS"), $hashLines, [Text.ASCIIEncoding]::new())

Write-Host "BoxSpec Windows artifacts created in $OutputRoot"
Write-Host "Signing status: $($manifest.signatureStatus)"
if (-not $bridgeIncluded) { Write-Warning "Bridge CLI was not included because apps/mcp/dist/index.js does not exist." }
Write-Warning "No BoxSpec signing step or signing identity is configured; artifacts are not release-ready. Authenticode inspection: $($manifest.signatureStatus)."
