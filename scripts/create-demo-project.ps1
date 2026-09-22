[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "samples\react-dashboard"))
$targetRoot = [IO.Path]::GetFullPath($OutputPath)

if (Test-Path -LiteralPath $targetRoot) {
  throw "Refusing to overwrite existing path: $targetRoot"
}
if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
  throw "Sample source is missing: $sourceRoot"
}

New-Item -ItemType Directory -Path $targetRoot | Out-Null
foreach ($name in @("index.html", "package.json", "tsconfig.json", "vite.config.ts")) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $targetRoot $name)
}
Copy-Item -LiteralPath (Join-Path $sourceRoot "src") -Destination $targetRoot -Recurse

& git -C $targetRoot init
if ($LASTEXITCODE -ne 0) { throw "git init failed with exit code $LASTEXITCODE" }
& git -C $targetRoot config user.email "boxspec-demo@example.invalid"
if ($LASTEXITCODE -ne 0) { throw "git local user.email failed with exit code $LASTEXITCODE" }
& git -C $targetRoot config user.name "BoxSpec Demo"
if ($LASTEXITCODE -ne 0) { throw "git local user.name failed with exit code $LASTEXITCODE" }
& git -C $targetRoot add --all
if ($LASTEXITCODE -ne 0) { throw "git add failed with exit code $LASTEXITCODE" }
& git -C $targetRoot commit -m "Initialize BoxSpec React dashboard demo"
if ($LASTEXITCODE -ne 0) { throw "git commit failed with exit code $LASTEXITCODE" }

Write-Host "Created isolated BoxSpec demo repository at $targetRoot"
Write-Host "Next: cd '$targetRoot'; pnpm install --frozen-lockfile (after creating a lockfile) or pnpm install"
