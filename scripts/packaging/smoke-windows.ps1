[CmdletBinding()]
param(
  [string]$OutputRoot,
  [int]$LaunchSeconds = 8
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
if ([string]::IsNullOrWhiteSpace($OutputRoot)) { $OutputRoot = Join-Path $repoRoot "build\windows" }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$buildRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "build"))
if (-not $OutputRoot.StartsWith("$($buildRoot.TrimEnd('\'))\", [StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputRoot must be a child of $buildRoot"
}
$manifestPath = Join-Path $OutputRoot "artifact-manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$unpackedExe = [string]$manifest.outputs.executable
$installer = [string]$manifest.outputs.installer
if (-not (Test-Path -LiteralPath $unpackedExe -PathType Leaf)) { throw "Unpacked BoxSpec.exe is missing." }

$smokeRoot = Join-Path $OutputRoot "smoke"
if (Test-Path -LiteralPath $smokeRoot) { Remove-Item -LiteralPath $smokeRoot -Recurse -Force }
New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null

function Stop-TestProcessTree([Diagnostics.Process]$Process) {
  if ($Process.HasExited) { return }
  $windowsRoot = if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { "C:\Windows" } else { $env:SystemRoot }
  $taskkill = Join-Path $windowsRoot "System32\taskkill.exe"
  & $taskkill /PID $Process.Id /T /F *> $null
  if (-not $Process.WaitForExit(10000)) { $Process.Kill(); $Process.WaitForExit() }
}

function Invoke-Captured(
  [string]$FilePath,
  [string[]]$Arguments,
  [hashtable]$Environment,
  [int]$TimeoutSeconds = 60,
  [string]$WorkingDirectory = ""
) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $FilePath
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) { $start.WorkingDirectory = $WorkingDirectory }
  $quotedArguments = foreach ($argument in $Arguments) {
    if ($argument.Contains('"')) { throw "Smoke process arguments must not contain a quote." }
    '"' + $argument + '"'
  }
  $start.Arguments = $quotedArguments -join ' '
  foreach ($entry in $Environment.GetEnumerator()) { $start.Environment[[string]$entry.Key] = [string]$entry.Value }
  $process = [Diagnostics.Process]::Start($start)
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-TestProcessTree $process
    throw "$FilePath timed out."
  }
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
}

function Test-ApplicationLaunch([string]$Exe, [string]$ProfileRoot, [string]$Label) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Exe
  $start.UseShellExecute = $false
  $start.Environment["APPDATA"] = Join-Path $ProfileRoot "AppData\Roaming"
  $start.Environment["LOCALAPPDATA"] = Join-Path $ProfileRoot "AppData\Local"
  $start.Environment["TEMP"] = Join-Path $ProfileRoot "Temp"
  $start.Environment["TMP"] = Join-Path $ProfileRoot "Temp"
  New-Item -ItemType Directory -Path $start.Environment["APPDATA"], $start.Environment["LOCALAPPDATA"], $start.Environment["TEMP"] -Force | Out-Null
  $process = [Diagnostics.Process]::Start($start)
  Start-Sleep -Seconds $LaunchSeconds
  if ($process.HasExited) { throw "$Label exited early with code $($process.ExitCode)." }
  Stop-TestProcessTree $process
}

$sqlitePath = Join-Path $smokeRoot "native-core\state.sqlite"
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($sqlitePath)) -Force | Out-Null
$nativeSmokeScript = Join-Path $smokeRoot "native-core-smoke.cjs"
$nativeSmokeSource = @'
"use strict";
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

async function main() {
  const databasePath = process.env.BOXSPEC_SMOKE_DB;
  const packageJson = process.env.BOXSPEC_ASAR_PACKAGE;
  if (!databasePath || !packageJson) throw new Error("Smoke environment is incomplete");
  const requireFromApp = createRequire(packageJson);
  const runtimeEntry = requireFromApp.resolve("@boxspec/runtime");
  const coreEntry = createRequire(runtimeEntry).resolve("@boxspec/core");
  const { BoxSpecCore } = await import(pathToFileURL(coreEntry).href);
  const first = BoxSpecCore.open({ databasePath });
  first.createProject({ projectId: "packaging-smoke-first", name: "Packaging smoke first", createdAt: new Date().toISOString() });
  first.close();
  const second = BoxSpecCore.open({ databasePath });
  second.createProject({ projectId: "packaging-smoke-reopen", name: "Packaging smoke reopen", createdAt: new Date().toISOString() });
  second.close();
  const header = fs.readFileSync(databasePath).subarray(0, 16).toString("ascii");
  if (header !== "SQLite format 3\u0000") throw new Error("Core did not persist a SQLite database");
  process.stdout.write("better-sqlite3 core reopen ok\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
'@
[IO.File]::WriteAllText($nativeSmokeScript, $nativeSmokeSource, [Text.UTF8Encoding]::new($false))
$asarPackageJson = Join-Path ([string]$manifest.outputs.unpackedDirectory) "resources\app.asar\package.json"
$sqlite = Invoke-Captured $unpackedExe @($nativeSmokeScript) @{
  ELECTRON_RUN_AS_NODE = "1"
  BOXSPEC_SMOKE_DB = $sqlitePath
  BOXSPEC_ASAR_PACKAGE = $asarPackageJson
}
if ($sqlite.ExitCode -ne 0 -or $sqlite.Stdout -notmatch 'better-sqlite3 core reopen ok') {
  throw "Packaged Electron better-sqlite3/Core reopen probe failed ($($sqlite.ExitCode)): $($sqlite.Stderr)"
}
$sqliteHeader = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($sqlitePath), 0, 16)
if ($sqliteHeader -ne "SQLite format 3`0") {
  throw "The native Core smoke did not create a SQLite database."
}

$resourcesRoot = Join-Path ([string]$manifest.outputs.unpackedDirectory) "resources"
$verificationManifestPath = Join-Path $resourcesRoot "verification-tools.json"
if (-not (Test-Path -LiteralPath $verificationManifestPath -PathType Leaf)) { throw "Packaged verification manifest is missing." }
$verificationManifest = Get-Content -LiteralPath $verificationManifestPath -Raw | ConvertFrom-Json
$profileSmokeScript = Join-Path $smokeRoot "verification-profile-smoke.mjs"
$profileSmokeSource = @'
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const requireFromApp = createRequire(process.env.BOXSPEC_ASAR_PACKAGE);
const runtimeEntry = requireFromApp.resolve("@boxspec/runtime");
const { loadPackagedVerificationProfile } = await import(pathToFileURL(runtimeEntry).href);
const loaded = await loadPackagedVerificationProfile(process.env.BOXSPEC_RESOURCES, process.env.BOXSPEC_EXE);
if (loaded.verificationProfileId !== "managed-react-vite-p1" || Object.keys(loaded.fixtures).length !== 5) {
  throw new Error("Packaged verification profile did not load the managed closure");
}
process.stdout.write("packaged verification closure ok\n");
'@
[IO.File]::WriteAllText($profileSmokeScript, $profileSmokeSource, [Text.UTF8Encoding]::new($false))
$profileLoad = Invoke-Captured $unpackedExe @($profileSmokeScript) @{
  ELECTRON_RUN_AS_NODE = "1"
  BOXSPEC_ASAR_PACKAGE = $asarPackageJson
  BOXSPEC_RESOURCES = $resourcesRoot
  BOXSPEC_EXE = $unpackedExe
} 300
if ($profileLoad.ExitCode -ne 0 -or $profileLoad.Stdout -notmatch 'packaged verification closure ok') {
  throw "Packaged verification closure load failed ($($profileLoad.ExitCode)): $($profileLoad.Stderr)"
}

$candidateRoot = Join-Path $repoRoot "samples\react-dashboard"
$verificationOutput = Join-Path $smokeRoot "verification-output"
$typecheckOutput = Join-Path $verificationOutput "typecheck"
$buildOutput = Join-Path $verificationOutput "dist"
New-Item -ItemType Directory -Path $typecheckOutput, $buildOutput -Force | Out-Null
$typecheckEntry = Join-Path $resourcesRoot ([string]$verificationManifest.typecheck.entryPoint.relativePath).Replace('/', '\')
$typecheckArgs = @($typecheckEntry) + @($verificationManifest.typecheck.args | ForEach-Object { ([string]$_).Replace('{outputDir}', $typecheckOutput) })
$typecheck = Invoke-Captured $unpackedExe $typecheckArgs @{ ELECTRON_RUN_AS_NODE = "1" } 300 $candidateRoot
if ($typecheck.ExitCode -ne 0) { throw "Packaged trusted typecheck failed ($($typecheck.ExitCode)): stdout=$($typecheck.Stdout) stderr=$($typecheck.Stderr)" }
$buildEntry = Join-Path $resourcesRoot ([string]$verificationManifest.build.entryPoint.relativePath).Replace('/', '\')
$buildArgs = @($buildEntry) + @($verificationManifest.build.args | ForEach-Object { ([string]$_).Replace('{outputDir}', $buildOutput) })
$verificationBuild = Invoke-Captured $unpackedExe $buildArgs @{ ELECTRON_RUN_AS_NODE = "1" } 300 $candidateRoot
if ($verificationBuild.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $buildOutput "index.html") -PathType Leaf)) {
  throw "Packaged trusted Vite build failed ($($verificationBuild.ExitCode)): stdout=$($verificationBuild.Stdout) stderr=$($verificationBuild.Stderr)"
}
$browserExe = Join-Path $resourcesRoot ([string]$verificationManifest.browser.relativePath).Replace('/', '\')
$browserVersion = Invoke-Captured $browserExe @("--version") @{} 60
if ($browserVersion.ExitCode -ne 0 -or $browserVersion.Stdout -notmatch '153\.0\.8010\.12') {
  throw "Packaged Chromium launch failed ($($browserVersion.ExitCode)): $($browserVersion.Stderr)"
}

Test-ApplicationLaunch $unpackedExe (Join-Path $smokeRoot "unpacked-profile") "Unpacked app"

$installedLaunch = $false
$uninstallPreservedProfile = $false
if (-not [string]::IsNullOrWhiteSpace($installer)) {
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Installer path in manifest is missing." }
  $installRoot = Join-Path $smokeRoot "installed"
  $setup = Invoke-Captured $installer @("/Q") @{ BOXSPEC_INSTALL_ROOT = $installRoot } 180
  if ($setup.ExitCode -ne 0) { throw "Installer smoke failed ($($setup.ExitCode)): $($setup.Stderr)" }
  $installedExe = Join-Path $installRoot "app-$($manifest.version)\BoxSpec.exe"
  if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) { throw "Installer did not create the expected versioned app." }
  $profileRoot = Join-Path $smokeRoot "installed-profile"
  Test-ApplicationLaunch $installedExe $profileRoot "Installed app"
  $installedLaunch = $true
  $sentinel = Join-Path $profileRoot "preserve-me.txt"
  [IO.File]::WriteAllText($sentinel, "profile state")
  $uninstall = Join-Path $installRoot "uninstall.ps1"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $uninstall -Uninstall -Quiet
  if ($LASTEXITCODE -ne 0) { throw "Uninstall smoke failed with exit code $LASTEXITCODE." }
  if (Test-Path -LiteralPath $installedExe) { throw "Uninstall left tracked program files behind." }
  $uninstallPreservedProfile = Test-Path -LiteralPath $sentinel
  if (-not $uninstallPreservedProfile) { throw "Uninstall removed the isolated user profile sentinel." }
}

$bridgeSmoke = "not-run"
if ($manifest.bridgeIncluded -eq $true) {
  $rawMcpScript = Join-Path $smokeRoot "packaged-mcp-smoke.cjs"
  $rawMcpSource = @'
"use strict";
const { spawn } = require("node:child_process");
const exe = process.env.BOXSPEC_SMOKE_EXE;
const profileRoot = process.env.BOXSPEC_MCP_PROFILE_ROOT;
if (!exe || !profileRoot) throw new Error("Packaged MCP smoke environment is incomplete");
const child = spawn(exe, ["--mcp-stdio"], {
  env: { ...process.env, BOXSPEC_MCP_PROFILE_ROOT: profileRoot },
  stdio: ["pipe", "pipe", "pipe"]
});
let buffer = "";
let stderr = "";
let completed = false;
const timer = setTimeout(() => finish(new Error(`packaged MCP timed out: ${stderr}`)), 15000);
function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }
function finish(error) {
  if (completed) return;
  completed = true;
  clearTimeout(timer);
  child.stdin.end();
  child.kill();
  if (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("packaged MCP initialize/tools-list ok\n");
  }
}
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === 1 && message.result) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    } else if (message.id === 2) {
      const names = message.result?.tools?.map((tool) => tool.name) ?? [];
      if (names.length !== 15) return finish(new Error(`expected 15 MCP tools, received ${names.length}`));
      const forbidden = ["approve", "unlock", "apply_to_main", "run_shell", "read_secret"].filter((name) => names.includes(name));
      if (forbidden.length) return finish(new Error(`forbidden MCP tools exposed: ${forbidden.join(",")}`));
      finish();
    }
  }
});
child.on("error", finish);
child.on("exit", (code) => {
  if (!completed) finish(new Error(`packaged MCP exited early (${code}): ${stderr}`));
});
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "boxspec-packaging-smoke", version: "1.0.0" }
  }
});
'@
  [IO.File]::WriteAllText($rawMcpScript, $rawMcpSource, [Text.UTF8Encoding]::new($false))
  $mcpProfileRoot = Join-Path $smokeRoot "mcp-profile"
  New-Item -ItemType Directory -Path $mcpProfileRoot -Force | Out-Null
  $mcp = Invoke-Captured "node" @($rawMcpScript) @{
    BOXSPEC_SMOKE_EXE = $unpackedExe
    BOXSPEC_MCP_PROFILE_ROOT = $mcpProfileRoot
  } 30
  if ($mcp.ExitCode -ne 0 -or $mcp.Stdout -notmatch 'packaged MCP initialize/tools-list ok') {
    throw "Packaged MCP protocol smoke failed ($($mcp.ExitCode)): $($mcp.Stderr)"
  }
  $bridgeSmoke = "passed: packaged Electron entry completed initialize and tools/list with 15 safe tools"
}

$result = [ordered]@{
  schemaVersion = 1
  runAt = [DateTimeOffset]::UtcNow.ToString("O")
  unpackedLaunch = "passed"
  installedLaunch = if ($installedLaunch) { "passed" } else { "not-run" }
  betterSqlite3NativeLoad = "passed"
  coreDatabaseReopen = "passed"
  verificationClosureLoad = "passed"
  verificationTypecheck = "passed"
  verificationBuild = "passed"
  bundledBrowserLaunch = "passed"
  bridge = $bridgeSmoke
  uninstallProgramFiles = if ($installedLaunch) { "passed" } else { "not-run" }
  uninstallProfilePreservation = if ($uninstallPreservedProfile) { "passed" } else { "not-run" }
  cleanVm = "not-run"
  codeSigning = [string]$manifest.signatureStatus
  offlineNetworkIsolation = "not-run"
}
$resultPath = Join-Path $OutputRoot "smoke-result.json"
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $resultPath -Encoding UTF8
Write-Host ($result | ConvertTo-Json -Depth 4)
