# Prints one line per key press so a test can see exactly what reached the program.
[Console]::TreatControlCAsInput = $true
"KEYECHO READY"
while ($true) {
  $k = [Console]::ReadKey($true)
  "KEY char={0} key={1} mods={2}" -f [int]$k.KeyChar, $k.Key, $k.Modifiers
  if ($k.Key -eq 'Q' -and $k.Modifiers -eq 0) { break }
}
[Console]::TreatControlCAsInput = $false
"KEYECHO DONE"
