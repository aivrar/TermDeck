# Runs every TermDeck test against the real app window.
#   .\tests\run-all.ps1                  # tests the release build
#   .\tests\run-all.ps1 -Debug           # tests the debug build
#   .\tests\run-all.ps1 -Skip 04         # skip a test (04 sends one short prompt to each CLI)
#   .\tests\run-all.ps1 -Skip 04,15      # (15 sends four short prompts each to Codex and Grok)
#   .\tests\run-all.ps1 -Skip 04,15,20   # (20 sends one short prompt to Claude Code)
# Each test uses its own throw-away data folder under %TEMP%, never your real one.
# Tests 03 and 06 use the clipboard; your clipboard text is put back afterwards.
param([switch]$Debug, [string[]]$Skip = @(), [string]$WslDistro = '')

$root = Split-Path -Parent $PSScriptRoot
$env:TERMDECK_EXE = Join-Path $root ("src-tauri\target\{0}\termdeck.exe" -f $(if ($Debug) { 'debug' } else { 'release' }))
if (-not (Test-Path $env:TERMDECK_EXE)) { throw "Not built yet: $env:TERMDECK_EXE" }

$tmp = Join-Path $env:TEMP 'termdeck-tests'
$work = Join-Path $tmp 'work'
New-Item -ItemType Directory -Force $work | Out-Null
Set-Content (Join-Path $work 'README.md') "# Scratch project`n`nUsed only for TermDeck display tests.`n"

if (-not $WslDistro) {
    $env:WSL_UTF8 = '1'
    $WslDistro = (wsl.exe -l --running -q 2>$null | Where-Object { $_ -and $_.Trim() } | Select-Object -First 1)
    if ($WslDistro) { $WslDistro = ($WslDistro -replace "`0", '').Trim() }
}

$tests = @(
    @{ id = '01'; file = '01-smoke.mjs';     args = @() },
    @{ id = '02'; file = '02-clis.mjs';      args = @($work) },
    @{ id = '03'; file = '03-input.mjs';     args = @($work) },
    @{ id = '04'; file = '04-sessions.mjs';  args = @($work) },
    @{ id = '05'; file = '05-isolation.mjs'; args = @($work) },
    @{ id = '06'; file = '06-hotkeys.mjs';   args = @() },
    @{ id = '08'; file = '08-ui.mjs';        args = @($work, $WslDistro) },
    @{ id = '09'; file = '09-typeahead.mjs'; args = @($work) },
    @{ id = '10'; file = '10-resources.mjs'; args = @($work) },
    @{ id = '11'; file = '11-updates.mjs';   args = @($work) },
    @{ id = '12'; file = '12-restart-flags.mjs'; args = @($work) },
    @{ id = '13'; file = '13-auto-resume.mjs';   args = @($work) },
    @{ id = '14'; file = '14-single-settings-notify-picker.mjs'; args = @($work) },
    @{ id = '15'; file = '15-same-folder.mjs';   args = @($work) },
    @{ id = '16'; file = '16-audit-fixes.mjs';   args = @($work) },
    @{ id = '17'; file = '17-polish.mjs';        args = @($work, $WslDistro) },
    @{ id = '18'; file = '18-medium.mjs';        args = @($work, $WslDistro) },
    @{ id = '19'; file = '19-panes.mjs';         args = @($work) },
    @{ id = '20'; file = '20-background-job.mjs'; args = @($work) },
    @{ id = '21'; file = '21-audit2.mjs';        args = @($work) },
    @{ id = '22'; file = '22-process-control.mjs'; args = @($work, $WslDistro) }
)

$failed = @()
foreach ($t in $tests) {
    if ($Skip -contains $t.id) { "SKIP  $($t.file)"; continue }
    $data = Join-Path $tmp "data-$($t.id)"
    Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
    "`n===== $($t.file) ====="
    node (Join-Path $PSScriptRoot $t.file) $data @($t.args | Where-Object { $_ })
    if ($LASTEXITCODE -ne 0) { $failed += $t.file }
}
"`nScreenshots: $(Join-Path $PSScriptRoot 'out')"
if ($failed) { "FAILED: $($failed -join ', ')"; exit 1 } else { "All tests passed."; exit 0 }
