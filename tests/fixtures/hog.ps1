# Test fixture: makes a tab busy on purpose.
#   -Orphans N : start N detached processes that each keep one processor core busy, and
#                write their process ids to -PidFile. When this script then ends, they
#                are left running with no parent - the case a process-tree walk misses.
#   -Spin      : keep this process itself busy on one core.
#   -AllocMB N : hold N megabytes of memory.
# Everything stops by itself after -Seconds, so nothing is left behind if a test dies.
param([int]$Orphans = 0, [string]$PidFile = '', [switch]$Spin, [int]$AllocMB = 0, [int]$Seconds = 60)

$loop = "`$end=(Get-Date).AddSeconds($Seconds); while((Get-Date) -lt `$end){}"
for ($i = 0; $i -lt $Orphans; $i++) {
  $p = Start-Process powershell -ArgumentList '-NoProfile', '-Command', $loop -WindowStyle Hidden -PassThru
  if ($PidFile) { Add-Content -Path $PidFile -Value $p.Id }
}
if ($AllocMB -gt 0) {
  $block = [byte[]]::new($AllocMB * 1MB)
  for ($i = 0; $i -lt $block.Length; $i += 4096) { $block[$i] = 1 }   # touch every page so it is really in use
  if ($PidFile) { Add-Content -Path $PidFile -Value "alloc $PID" }
  Start-Sleep -Seconds $Seconds
}
if ($Spin) {
  $end = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $end) { }
}
