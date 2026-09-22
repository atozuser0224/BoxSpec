param(
  [string]$Exe = (Join-Path $PSScriptRoot '..\bin\boxspec-safe-fs.exe')
)

$ErrorActionPreference = 'Stop'
$Exe = (Resolve-Path -LiteralPath $Exe).Path
$script:Assertions = 0

function Invoke-SafeFs([hashtable]$Request) {
  $raw = ($Request | ConvertTo-Json -Compress -Depth 16) | & $Exe --protocol 1
  if ($LASTEXITCODE -ne 0) { throw "helper process exited $LASTEXITCODE" }
  return $raw | ConvertFrom-Json
}

function Assert-True($Value, [string]$Message) {
  $script:Assertions++
  if (-not $Value) { throw "assertion failed: $Message" }
}

function Hash-File([string]$Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Inspect([string]$Root, [string]$Id) {
  $response = Invoke-SafeFs @{ op = 'inspect_root'; requestId = $Id; root = $Root }
  Assert-True $response.ok "inspect_root succeeds"
  return $response.result.rootIdentity
}

$testBase = Join-Path ([IO.Path]::GetTempPath()) ("boxspec-safe-fs-tests-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testBase | Out-Null
try {
  # Normal guarded replacement and recovery classification.
  $root = Join-Path $testBase 'normal'
  New-Item -ItemType Directory -Path (Join-Path $root 'src') -Force | Out-Null
  $target = Join-Path $root 'src\a.txt'
  [IO.File]::WriteAllText($target, 'before', [Text.UTF8Encoding]::new($false))
  $identity = Inspect $root 'normal-inspect'
  $ensure = Invoke-SafeFs @{
    op = 'ensure_directory'; requestId = 'ensure-create'; root = $root; rootIdentity = $identity
    relativePath = '.boxspec/screens/generated'
  }
  Assert-True $ensure.ok "ensure_directory creates a missing multi-level chain"
  Assert-True ($ensure.result.created.Count -eq 3) "ensure_directory reports each created segment"
  Assert-True (Test-Path -LiteralPath (Join-Path $root '.boxspec\screens\generated') -PathType Container) "ensured directory exists"
  $ensureAgain = Invoke-SafeFs @{
    op = 'ensure_directory'; requestId = 'ensure-idempotent'; root = $root; rootIdentity = $identity
    relativePath = '.boxspec/screens/generated'
  }
  Assert-True ($ensureAgain.ok -and $ensureAgain.result.created.Count -eq 0) "ensure_directory is idempotent"

  New-Item -ItemType Directory -Path (Join-Path $root 'collision') | Out-Null
  [IO.File]::WriteAllText((Join-Path $root 'collision\file'), 'not-a-directory', [Text.UTF8Encoding]::new($false))
  $ensureFile = Invoke-SafeFs @{
    op = 'ensure_directory'; requestId = 'ensure-file'; root = $root; rootIdentity = $identity
    relativePath = 'collision/file/child'
  }
  Assert-True (-not $ensureFile.ok -and $ensureFile.error.code -eq 'UNSUPPORTED_FILE_KIND') "ensure_directory rejects a file collision"

  $ensureOutside = Join-Path $testBase 'ensure-outside'
  New-Item -ItemType Directory -Path $ensureOutside | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $root 'collision\jump') -Target $ensureOutside | Out-Null
  $ensureJunction = Invoke-SafeFs @{
    op = 'ensure_directory'; requestId = 'ensure-junction'; root = $root; rootIdentity = $identity
    relativePath = 'collision/jump/child'
  }
  Assert-True (-not $ensureJunction.ok -and $ensureJunction.error.code -eq 'REPARSE_POINT') "ensure_directory rejects a junction collision"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $ensureOutside 'child'))) "ensure_directory does not create through a junction"

  # Two helpers may race to create the same missing chain. Both must reopen and
  # validate a collision rather than treating it as an unchecked success.
  $concurrentDir = 'concurrent/a/b'
  $ensureInput1 = Join-Path $testBase 'ensure-1.json'
  $ensureInput2 = Join-Path $testBase 'ensure-2.json'
  $ensureOutput1 = Join-Path $testBase 'ensure-1.out'
  $ensureOutput2 = Join-Path $testBase 'ensure-2.out'
  $ensureError1 = Join-Path $testBase 'ensure-1.err'
  $ensureError2 = Join-Path $testBase 'ensure-2.err'
  @{ op = 'ensure_directory'; requestId = 'ensure-c1'; root = $root; rootIdentity = $identity; relativePath = $concurrentDir } | ConvertTo-Json -Compress -Depth 8 | Set-Content -LiteralPath $ensureInput1 -Encoding utf8NoBOM
  @{ op = 'ensure_directory'; requestId = 'ensure-c2'; root = $root; rootIdentity = $identity; relativePath = $concurrentDir } | ConvertTo-Json -Compress -Depth 8 | Set-Content -LiteralPath $ensureInput2 -Encoding utf8NoBOM
  $ensureProcess1 = Start-Process -FilePath $Exe -ArgumentList @('--protocol', '1') -RedirectStandardInput $ensureInput1 -RedirectStandardOutput $ensureOutput1 -RedirectStandardError $ensureError1 -WindowStyle Hidden -PassThru
  $ensureProcess2 = Start-Process -FilePath $Exe -ArgumentList @('--protocol', '1') -RedirectStandardInput $ensureInput2 -RedirectStandardOutput $ensureOutput2 -RedirectStandardError $ensureError2 -WindowStyle Hidden -PassThru
  $ensureProcess1.WaitForExit(); $ensureProcess2.WaitForExit()
  $ensureConcurrent1 = Get-Content -Raw -LiteralPath $ensureOutput1 | ConvertFrom-Json
  $ensureConcurrent2 = Get-Content -Raw -LiteralPath $ensureOutput2 | ConvertFrom-Json
  Assert-True ($ensureProcess1.ExitCode -eq 0 -and $ensureProcess2.ExitCode -eq 0) "concurrent ensure helpers return protocol responses"
  Assert-True ($ensureConcurrent1.ok -and $ensureConcurrent2.ok) "concurrent creators both validate the final chain"
  Assert-True (Test-Path -LiteralPath (Join-Path $root 'concurrent\a\b') -PathType Container) "concurrent ensured chain exists"

  $before = Hash-File $target
  $prepare = Invoke-SafeFs @{
    op = 'prepare_replace'; requestId = 'normal-prepare'; transactionId = 'txn-normal'; root = $root
    rootIdentity = $identity; relativePath = 'src/a.txt'; expectedBeforeHash = $before
    expectedBeforeFileId = $null; afterBytesBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('after'))
  }
  Assert-True $prepare.ok "prepare_replace succeeds"
  $classifiedBefore = Invoke-SafeFs @{
    op = 'classify_recovery'; requestId = 'normal-class-before'; transactionId = 'txn-normal'; root = $root
    rootIdentity = $identity; relativePath = 'src/a.txt'; beforeHash = $before
    afterHash = $prepare.result.afterHash; preparedId = $prepare.result.preparedId
  }
  Assert-True ($classifiedBefore.result.state -eq 'BEFORE') "recovery classifies prepared target as BEFORE"
  $commit = Invoke-SafeFs @{
    op = 'commit_replace'; requestId = 'normal-commit'; transactionId = 'txn-normal'; root = $root
    rootIdentity = $identity; relativePath = 'src/a.txt'; preparedId = $prepare.result.preparedId
  }
  Assert-True $commit.ok "commit_replace succeeds"
  Assert-True (([IO.File]::ReadAllText($target)) -eq 'after') "commit writes exact replacement bytes"
  $classifiedAfter = Invoke-SafeFs @{
    op = 'classify_recovery'; requestId = 'normal-class-after'; transactionId = 'txn-normal'; root = $root
    rootIdentity = $identity; relativePath = 'src/a.txt'; beforeHash = $before
    afterHash = $prepare.result.afterHash; preparedId = $prepare.result.preparedId
  }
  Assert-True ($classifiedAfter.result.state -eq 'AFTER') "recovery classifies committed target as AFTER"
  $restore = Invoke-SafeFs @{
    op = 'recover_replace'; requestId = 'normal-restore'; transactionId = 'txn-normal'; root = $root
    rootIdentity = $identity; relativePath = 'src/a.txt'; preparedId = $prepare.result.preparedId; decision = 'restore_before'
  }
  Assert-True $restore.ok "recovery restores BEFORE from checked backup"
  Assert-True (([IO.File]::ReadAllText($target)) -eq 'before') "restored bytes match before state"

  $finishTarget = Join-Path $root 'src\finish.txt'
  [IO.File]::WriteAllText($finishTarget, 'old', [Text.UTF8Encoding]::new($false))
  $finishPrepare = Invoke-SafeFs @{
    op = 'prepare_replace'; requestId = 'finish-prepare'; transactionId = 'txn-finish'; root = $root
    rootIdentity = $identity; relativePath = 'src/finish.txt'; expectedBeforeHash = (Hash-File $finishTarget)
    expectedBeforeFileId = $null; afterBytesBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('new'))
  }
  $finish = Invoke-SafeFs @{
    op = 'recover_replace'; requestId = 'finish-recover'; transactionId = 'txn-finish'; root = $root
    rootIdentity = $identity; relativePath = 'src/finish.txt'; preparedId = $finishPrepare.result.preparedId; decision = 'finish_after'
  }
  Assert-True $finish.ok "recovery finishes AFTER from checked temp"
  Assert-True (([IO.File]::ReadAllText($finishTarget)) -eq 'new') "forward recovery bytes match after state"
  $finalize = Invoke-SafeFs @{
    op = 'finalize_replace'; requestId = 'finish-finalize'; transactionId = 'txn-finish'; root = $root
    rootIdentity = $identity; relativePath = 'src/finish.txt'; preparedId = $finishPrepare.result.preparedId
  }
  Assert-True ($finalize.ok -and $finalize.result.finalized) "finalize is idempotent after recovery cleanup"

  $noopTarget = Join-Path $root 'src\noop.txt'
  [IO.File]::WriteAllText($noopTarget, 'same', [Text.UTF8Encoding]::new($false))
  $noopBefore = Hash-File $noopTarget
  $noopPrepare = Invoke-SafeFs @{
    op = 'prepare_replace'; requestId = 'noop-prepare'; transactionId = 'txn-noop'; root = $root
    rootIdentity = $identity; relativePath = 'src/noop.txt'; expectedBeforeHash = $noopBefore
    expectedBeforeFileId = $null; afterBytesBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('unused'))
  }
  $noopRecover = Invoke-SafeFs @{
    op = 'recover_replace'; requestId = 'noop-recover'; transactionId = 'txn-noop'; root = $root
    rootIdentity = $identity; relativePath = 'src/noop.txt'; preparedId = $noopPrepare.result.preparedId; decision = 'restore_before'
  }
  Assert-True ($noopRecover.ok -and -not $noopRecover.result.changed) "restore_before at BEFORE is an idempotent no-op"
  $noopClassify = Invoke-SafeFs @{
    op = 'classify_recovery'; requestId = 'noop-classify'; transactionId = 'txn-noop'; root = $root
    rootIdentity = $identity; relativePath = 'src/noop.txt'; beforeHash = $noopBefore
    afterHash = $noopPrepare.result.afterHash; preparedId = $noopPrepare.result.preparedId
  }
  Assert-True (-not $noopClassify.result.canRestoreBefore -and -not $noopClassify.result.canFinishAfter) "no-op recovery cleans both exact artifacts"

  # Source drift after preparation must stop before mutation.
  $driftRoot = Join-Path $testBase 'drift'
  New-Item -ItemType Directory -Path $driftRoot | Out-Null
  $driftTarget = Join-Path $driftRoot 'a.txt'
  [IO.File]::WriteAllText($driftTarget, 'before', [Text.UTF8Encoding]::new($false))
  $driftIdentity = Inspect $driftRoot 'drift-inspect'
  $driftPrepare = Invoke-SafeFs @{
    op = 'prepare_replace'; requestId = 'drift-prepare'; transactionId = 'txn-drift'; root = $driftRoot
    rootIdentity = $driftIdentity; relativePath = 'a.txt'; expectedBeforeHash = (Hash-File $driftTarget)
    expectedBeforeFileId = $null; afterBytesBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('after'))
  }
  [IO.File]::WriteAllText($driftTarget, 'user-edit', [Text.UTF8Encoding]::new($false))
  $driftCommit = Invoke-SafeFs @{
    op = 'commit_replace'; requestId = 'drift-commit'; transactionId = 'txn-drift'; root = $driftRoot
    rootIdentity = $driftIdentity; relativePath = 'a.txt'; preparedId = $driftPrepare.result.preparedId
  }
  Assert-True (-not $driftCommit.ok -and $driftCommit.error.code -eq 'SOURCE_DRIFT') "source drift is rejected"
  Assert-True (([IO.File]::ReadAllText($driftTarget)) -eq 'user-edit') "source drift remains untouched"

  # Multiply-linked targets are rejected.
  $linkRoot = Join-Path $testBase 'hardlink'
  New-Item -ItemType Directory -Path $linkRoot | Out-Null
  $protected = Join-Path $linkRoot 'protected.txt'
  $linked = Join-Path $linkRoot 'linked.txt'
  [IO.File]::WriteAllText($protected, 'protected', [Text.UTF8Encoding]::new($false))
  New-Item -ItemType HardLink -Path $linked -Target $protected | Out-Null
  $linkIdentity = Inspect $linkRoot 'link-inspect'
  $linkPrepare = Invoke-SafeFs @{
    op = 'prepare_replace'; requestId = 'link-prepare'; transactionId = 'txn-link'; root = $linkRoot
    rootIdentity = $linkIdentity; relativePath = 'linked.txt'; expectedBeforeHash = (Hash-File $linked)
    expectedBeforeFileId = $null; afterBytesBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('attack'))
  }
  Assert-True (-not $linkPrepare.ok -and $linkPrepare.error.code -eq 'HARD_LINK') "hard-linked target is rejected"
  Assert-True (([IO.File]::ReadAllText($protected)) -eq 'protected') "hardlink peer remains unchanged"

  # A junction ancestor is opened without following it and rejected by tag.
  $junctionRoot = Join-Path $testBase 'junction-root'
  $outside = Join-Path $testBase 'outside'
  New-Item -ItemType Directory -Path $junctionRoot, $outside | Out-Null
  [IO.File]::WriteAllText((Join-Path $outside 'sentinel.txt'), 'outside', [Text.UTF8Encoding]::new($false))
  New-Item -ItemType Junction -Path (Join-Path $junctionRoot 'jump') -Target $outside | Out-Null
  $junctionIdentity = Inspect $junctionRoot 'junction-inspect'
  $junction = Invoke-SafeFs @{
    op = 'resolve_relative'; requestId = 'junction-resolve'; root = $junctionRoot; rootIdentity = $junctionIdentity
    relativePath = 'jump/sentinel.txt'; allowMissing = $false
  }
  Assert-True (-not $junction.ok -and $junction.error.code -eq 'REPARSE_POINT') "junction ancestor is rejected"
  Assert-True (([IO.File]::ReadAllText((Join-Path $outside 'sentinel.txt'))) -eq 'outside') "junction destination remains unchanged"

  # Root name substitution between prepare and commit is detected by volume/file ID.
  $rootSwap = Join-Path $testBase 'root-swap'
  New-Item -ItemType Directory -Path $rootSwap | Out-Null
  [IO.File]::WriteAllText((Join-Path $rootSwap 'a.txt'), 'before', [Text.UTF8Encoding]::new($false))
  $swapIdentity = Inspect $rootSwap 'swap-inspect'
  $swapPrepare = Invoke-SafeFs @{
    op = 'prepare_replace'; requestId = 'swap-prepare'; transactionId = 'txn-swap'; root = $rootSwap
    rootIdentity = $swapIdentity; relativePath = 'a.txt'; expectedBeforeHash = (Hash-File (Join-Path $rootSwap 'a.txt'))
    expectedBeforeFileId = $null; afterBytesBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('after'))
  }
  $originalRoot = "$rootSwap-original"
  Move-Item -LiteralPath $rootSwap -Destination $originalRoot
  New-Item -ItemType Directory -Path $rootSwap | Out-Null
  [IO.File]::WriteAllText((Join-Path $rootSwap 'a.txt'), 'decoy', [Text.UTF8Encoding]::new($false))
  $swapCommit = Invoke-SafeFs @{
    op = 'commit_replace'; requestId = 'swap-commit'; transactionId = 'txn-swap'; root = $rootSwap
    rootIdentity = $swapIdentity; relativePath = 'a.txt'; preparedId = $swapPrepare.result.preparedId
  }
  Assert-True (-not $swapCommit.ok -and $swapCommit.error.code -eq 'ROOT_IDENTITY_CHANGED') "root substitution is rejected"
  Assert-True (([IO.File]::ReadAllText((Join-Path $rootSwap 'a.txt'))) -eq 'decoy') "substituted root remains unchanged"
  Assert-True (([IO.File]::ReadAllText((Join-Path $originalRoot 'a.txt'))) -eq 'before') "original root remains unchanged"
  $swapEnsure = Invoke-SafeFs @{
    op = 'ensure_directory'; requestId = 'swap-ensure'; root = $rootSwap; rootIdentity = $swapIdentity
    relativePath = 'managed/new'
  }
  Assert-True (-not $swapEnsure.ok -and $swapEnsure.error.code -eq 'ROOT_IDENTITY_CHANGED') "ensure_directory rejects root substitution"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $rootSwap 'managed'))) "ensure_directory does not write substituted root"

  # Exercise the same no-delete-share ancestor pinning while ensure_directory
  # traverses a long chain. The attacker either wins before the relative walk
  # and is rejected, or its rename is blocked until the safe create completes.
  $ensureRaceRoot = Join-Path $testBase 'ensure-race-root'
  $ensureRaceOutside = Join-Path $testBase 'ensure-race-outside'
  $ensureRaceFirst = Join-Path $ensureRaceRoot 'locked'
  New-Item -ItemType Directory -Path $ensureRaceFirst, $ensureRaceOutside -Force | Out-Null
  $deepParts = [Collections.Generic.List[string]]::new()
  $deepParts.Add('locked')
  $deepCursor = $ensureRaceFirst
  foreach ($index in 1..100) {
    $part = "d$index"
    $deepParts.Add($part)
    $deepCursor = Join-Path $deepCursor $part
    [IO.Directory]::CreateDirectory($deepCursor) | Out-Null
  }
  $deepParts.Add('new')
  $ensureRaceRelative = $deepParts -join '/'
  $ensureRaceIdentity = Inspect $ensureRaceRoot 'ensure-race-inspect'
  $ensureRaceInput = Join-Path $testBase 'ensure-race.json'
  $ensureRaceOutput = Join-Path $testBase 'ensure-race.out'
  $ensureRaceError = Join-Path $testBase 'ensure-race.err'
  @{ op = 'ensure_directory'; requestId = 'ensure-race'; root = $ensureRaceRoot; rootIdentity = $ensureRaceIdentity; relativePath = $ensureRaceRelative } | ConvertTo-Json -Compress -Depth 8 | Set-Content -LiteralPath $ensureRaceInput -Encoding utf8NoBOM
  $ensureRaceProcess = Start-Process -FilePath $Exe -ArgumentList @('--protocol', '1') -RedirectStandardInput $ensureRaceInput -RedirectStandardOutput $ensureRaceOutput -RedirectStandardError $ensureRaceError -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 300
  $ensureRaceMoved = $false
  try {
    Move-Item -LiteralPath $ensureRaceFirst -Destination (Join-Path $ensureRaceRoot 'locked-moved') -ErrorAction Stop
    $ensureRaceMoved = $true
    New-Item -ItemType Junction -Path $ensureRaceFirst -Target $ensureRaceOutside | Out-Null
  }
  catch { }
  $ensureRaceProcess.WaitForExit()
  $ensureRaceResponse = Get-Content -Raw -LiteralPath $ensureRaceOutput | ConvertFrom-Json
  Assert-True ($ensureRaceProcess.ExitCode -eq 0) "raced ensure returns a bounded protocol response"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $ensureRaceOutside 'new'))) "raced ensure never creates through substituted ancestor"
  $deepTail = ($deepParts | Select-Object -Skip 1) -join '\'
  $ensureRaceExpected = if ($ensureRaceMoved) { Join-Path (Join-Path $ensureRaceRoot 'locked-moved') $deepTail } else { Join-Path $ensureRaceFirst $deepTail }
  Assert-True ((-not $ensureRaceResponse.ok) -or (Test-Path -LiteralPath $ensureRaceExpected -PathType Container)) "successful raced ensure creates only in the retained original chain"

  # Race an ancestor rename/junction substitution against a long commit. If the
  # attacker wins before the relative walk, identity/reparse checks reject it; if
  # the walk wins, no-delete sharing on retained handles blocks reparenting.
  $raceRoot = Join-Path $testBase 'race-root'
  $raceSource = Join-Path $raceRoot 'src'
  $raceOutside = Join-Path $testBase 'race-outside'
  New-Item -ItemType Directory -Path $raceSource, $raceOutside -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $raceOutside 'sentinel.txt'), 'outside', [Text.UTF8Encoding]::new($false))
  $raceTarget = Join-Path $raceSource 'a.bin'
  $large = [IO.File]::Create($raceTarget)
  $large.SetLength(192MB)
  $large.Dispose()
  $raceIdentity = Inspect $raceRoot 'race-inspect'
  $racePrepare = Invoke-SafeFs @{
    op = 'prepare_replace'; requestId = 'race-prepare'; transactionId = 'txn-race'; root = $raceRoot
    rootIdentity = $raceIdentity; relativePath = 'src/a.bin'; expectedBeforeHash = (Hash-File $raceTarget)
    expectedBeforeFileId = $null; afterBytesBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('after'))
  }
  $raceInput = Join-Path $testBase 'race-request.json'
  $raceOutput = Join-Path $testBase 'race-response.json'
  $raceError = Join-Path $testBase 'race-error.txt'
  @{
    op = 'commit_replace'; requestId = 'race-commit'; transactionId = 'txn-race'; root = $raceRoot
    rootIdentity = $raceIdentity; relativePath = 'src/a.bin'; preparedId = $racePrepare.result.preparedId
  } | ConvertTo-Json -Compress -Depth 16 | Set-Content -LiteralPath $raceInput -Encoding utf8NoBOM
  $process = Start-Process -FilePath $Exe -ArgumentList @('--protocol', '1') -RedirectStandardInput $raceInput -RedirectStandardOutput $raceOutput -RedirectStandardError $raceError -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 500
  $attackerMoved = $false
  try {
    Move-Item -LiteralPath $raceSource -Destination (Join-Path $raceRoot 'src-moved') -ErrorAction Stop
    $attackerMoved = $true
    New-Item -ItemType Junction -Path $raceSource -Target $raceOutside | Out-Null
  }
  catch { }
  $process.WaitForExit()
  $raceResponse = Get-Content -Raw -LiteralPath $raceOutput | ConvertFrom-Json
  Assert-True ($process.ExitCode -eq 0) "raced helper returns a bounded protocol response"
  Assert-True (([IO.File]::ReadAllText((Join-Path $raceOutside 'sentinel.txt'))) -eq 'outside') "concurrent ancestor swap does not modify outside sentinel"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $raceOutside 'a.bin'))) "concurrent ancestor swap does not create outside target"
  Assert-True ((-not $attackerMoved) -or (-not $raceResponse.ok)) "pre-walk attacker win is rejected"
  Assert-True ($attackerMoved -or $raceResponse.ok) "retained handles either block the swap or the operation fails closed"

  # Pure lexical attacks are rejected before filesystem traversal.
  foreach ($bad in @('../x', 'a\b', 'C:x', 'file:stream', 'CON.txt', 'COM¹.log', 'x.')) {
    $badResult = Invoke-SafeFs @{
      op = 'resolve_relative'; requestId = 'bad-path'; root = $root; rootIdentity = $identity
      relativePath = $bad; allowMissing = $true
    }
    Assert-True (-not $badResult.ok -and $badResult.error.code -eq 'INVALID_PATH') "rejects bad path $bad"
  }

  [pscustomobject]@{
    passed = $true
    assertions = $script:Assertions
    executable = $Exe
    executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Exe).Hash.ToLowerInvariant()
    raceAttackerMoved = $attackerMoved
    raceHelperOk = $raceResponse.ok
    ensureRaceAttackerMoved = $ensureRaceMoved
    ensureRaceHelperOk = $ensureRaceResponse.ok
    tempRoot = $testBase
  } | ConvertTo-Json -Depth 5
}
finally {
  # This path was allocated in the system temp directory by this test run only.
  if (Test-Path -LiteralPath $testBase) { Remove-Item -LiteralPath $testBase -Recurse -Force }
}
