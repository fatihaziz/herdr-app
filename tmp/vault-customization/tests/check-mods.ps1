# Runs Herdr's own loader gate on every staged mod, in install order.
param([string]$HerdrApp = "herdr-app")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$mods = Join-Path $root "app/mods"
$failed = @()
foreach ($m in (Get-ChildItem $mods -Directory | Sort-Object Name)) {
  Write-Host "check $($m.Name)"
  & $HerdrApp check $m.FullName
  if ($LASTEXITCODE -ne 0) { $failed += $m.Name }
}
if ($failed.Count -gt 0) { Write-Host "failed: $($failed -join ', ')"; exit 1 }
Write-Host "all staged mods passed check"
