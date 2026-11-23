# Node model tests plus staging invariants. No app launch.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  node --test tests/
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & (Join-Path $PSScriptRoot "verify-staged.ps1")
  exit $LASTEXITCODE
} finally { Pop-Location }
