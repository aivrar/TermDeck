# Builds TermDeck and assembles the portable folder: portable\TermDeck
# Copy that folder anywhere (another drive, a USB stick) and run TermDeck.exe.
# Settings, snippets and saved sessions live in its "data" subfolder.
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $SkipBuild) {
    npx tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
}

$release = Join-Path $root 'src-tauri\target\release'
$out = Join-Path $root 'portable\TermDeck'
New-Item -ItemType Directory -Force $out | Out-Null

Copy-Item (Join-Path $release 'termdeck.exe') (Join-Path $out 'TermDeck.exe') -Force
# Microsoft's current console layer. Without these two files the app falls back to
# the one built into Windows, which on Windows 10 mangles some typed symbols.
Copy-Item (Join-Path $release 'conpty.dll'), (Join-Path $release 'OpenConsole.exe') $out -Force
Copy-Item (Join-Path $root 'src-tauri\vendor\conpty\README.txt') (Join-Path $out 'conpty-README.txt') -Force
Copy-Item (Join-Path $root 'src-tauri\vendor\conpty\LICENSE.txt') (Join-Path $out 'conpty-LICENSE.txt') -Force
Copy-Item (Join-Path $root 'LICENSE') (Join-Path $out 'LICENSE.txt') -Force
Copy-Item (Join-Path $root 'THIRD-PARTY-NOTICES.md') (Join-Path $out 'THIRD-PARTY-NOTICES.md') -Force
Copy-Item (Join-Path $root 'src\fonts\LICENSE-CascadiaCode.txt') (Join-Path $out 'font-LICENSE.txt') -Force

Get-ChildItem $out -File | Select-Object Name, @{ n = 'MB'; e = { [Math]::Round($_.Length / 1MB, 2) } } | Format-Table -AutoSize
"Portable folder: $out"
