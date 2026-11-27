param(
  [int]$PetPid,
  [string]$Executable,
  [string]$Config,
  [int]$RecoveryCount
)

$ErrorActionPreference = 'Stop'
$data = Join-Path (Split-Path -Parent $Config) 'data'
$sessionFile = Join-Path $data 'logs/runtime-session.json'
$recoveryLog = Join-Path $data 'logs/windows-recovery.log'

function Write-RecoveryLog([string]$Message) {
  try { Add-Content -LiteralPath $recoveryLog -Value "$([DateTime]::UtcNow.ToString('o')) pid=$PetPid $Message" } catch {}
}

function Test-CrashDump([DateTime]$Since) {
  $dumps = Get-ChildItem -LiteralPath (Join-Path $data 'crashes') -Filter '*.dmp' -File -Recurse -ErrorAction SilentlyContinue
  foreach ($dump in ($dumps | Where-Object LastWriteTimeUtc -ge $Since | Select-Object -First 16)) {
    $reader = $null
    try {
      $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($dump.FullName))
      if ($reader.ReadUInt32() -ne 0x504D444D) { continue }
      $reader.BaseStream.Position = 8
      $streams = $reader.ReadUInt32()
      $directory = $reader.ReadUInt32()
      for ($i = 0; $i -lt [Math]::Min($streams, 128); $i++) {
        $reader.BaseStream.Position = $directory + 12 * $i
        if ($reader.ReadUInt32() -ne 15) { continue }
        if ($reader.ReadUInt32() -lt 12) { break }
        $reader.BaseStream.Position = $reader.ReadUInt32()
        $null = $reader.ReadUInt32()
        $flags = $reader.ReadUInt32()
        if (($flags -band 1) -and $reader.ReadUInt32() -eq $PetPid) { return $true }
        break
      }
    } catch {} finally { if ($reader) { $reader.Dispose() } }
  }
  return $false
}

try {
  $pet = [System.Diagnostics.Process]::GetProcessById($PetPid)
  # Open the handle before waiting so the exit code remains available.
  $null = $pet.Handle
  $started = $pet.StartTime
  Write-RecoveryLog 'watching'
  $pet.WaitForExit()
  $code = $pet.ExitCode
  Write-RecoveryLog "exit code=$code"
  # Some crash paths can report a different code to the parent process.
  # Match a fresh Crashpad dump to the exact PID before recovering those.
  $nativeCrash = $code -ge -1073741824 -and $code -lt 0
  $exitTime = [DateTime]::UtcNow
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    $session = Get-Content -LiteralPath $sessionFile -Raw | ConvertFrom-Json
    if ($session.pid -ne $PetPid -or $session.status -ne 'running') { exit 0 }
    if ($nativeCrash -or (Test-CrashDump ($exitTime.AddSeconds(-30)))) { break }
    if ($attempt -eq 4) { Write-RecoveryLog 'no matching crash dump'; exit 0 }
    Start-Sleep -Seconds 1
  }
  if (((Get-Date) - $started).TotalMinutes -ge 5) { $RecoveryCount = 0 }
  if ($RecoveryCount -ge 2) { Write-RecoveryLog 'retry limit reached'; exit 0 }
  Start-Sleep -Seconds 2
  $session = Get-Content -LiteralPath $sessionFile -Raw | ConvertFrom-Json
  if ($session.pid -ne $PetPid -or $session.status -ne 'running') { exit 0 }
  $env:DRAGONDESK_CRASH_RECOVERY_COUNT = [string]($RecoveryCount + 1)
  $restarted = Start-Process -FilePath $Executable -ArgumentList ('"--config=' + $Config + '"') -WorkingDirectory (Split-Path -Parent $Executable) -WindowStyle Normal -PassThru
  Write-RecoveryLog "restarted pid=$($restarted.Id)"
} catch {
  Write-RecoveryLog "error type=$($_.Exception.GetType().Name) line=$($_.InvocationInfo.ScriptLineNumber)"
  exit 1
}
