# Fails when the staging tree could be copied into a broken app home.
param(
  [string]$Baseline = "D:/__CODING/personal/__my-vault/.fatih-agentic/herdr/app"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root "app"
$fail = 0

function Ok($msg) { Write-Host "ok   $msg" }
function Bad($msg) { Write-Host "FAIL $msg"; $script:fail++ }

foreach ($f in @("layouts/fatih.json", "keys.json")) {
  try { Get-Content (Join-Path $app $f) -Raw | ConvertFrom-Json | Out-Null; Ok "json $f" }
  catch { Bad "json $f : $($_.Exception.Message)" }
}

$mods = Get-ChildItem (Join-Path $app "mods") -Directory
foreach ($m in $mods) {
  $mj = Join-Path $m.FullName "mod.json"
  $main = Join-Path $m.FullName "main.js"
  if (!(Test-Path $mj)) { Bad "$($m.Name): missing mod.json"; continue }
  if (!(Test-Path $main)) { Bad "$($m.Name): missing main.js"; continue }
  try { Get-Content $mj -Raw | ConvertFrom-Json | Out-Null; Ok "mod $($m.Name)" }
  catch { Bad "$($m.Name): mod.json invalid: $($_.Exception.Message)" }
  $src = Get-Content $main -Raw
  foreach ($match in [regex]::Matches($src, 'mods/([A-Za-z0-9._-]+)/([A-Za-z0-9._/-]+\.svg)')) {
    $target = Join-Path (Join-Path $app "mods") ($match.Groups[1].Value + "/" + $match.Groups[2].Value)
    if (!(Test-Path $target)) {
      # Vendored mods may reuse icons from shipped mods that only exist in the app home.
      $shipped = Join-Path (Join-Path $Baseline "mods") ($match.Groups[1].Value + "/" + $match.Groups[2].Value)
      if (!(Test-Path $shipped)) { Bad "$($m.Name): icon missing -> $($match.Value)" }
    }
  }
}

$layout = Get-Content (Join-Path $app "layouts/fatih.json") -Raw | ConvertFrom-Json
$ids = New-Object System.Collections.Generic.List[string]
function Walk($node) {
  if ($null -eq $node) { return }
  if ($node.id) { $ids.Add([string]$node.id) }
  if ($node.children) { foreach ($c in $node.children) { Walk $c } }
}
Walk $layout
$dupes = $ids | Group-Object | Where-Object { $_.Count -gt 1 }
if ($dupes) { Bad "layout ids duplicated: $($dupes.Name -join ', ')" } else { Ok "layout ids unique ($($ids.Count))" }
if (-not ($ids -contains "toolbar")) { Bad "layout: toolbar missing" }
if (-not ($ids -contains "board") -or -not ($ids -contains "gantt") -or -not ($ids -contains "router")) { Bad "layout: board/gantt/router stacks missing" }

$newKeys = Get-Content (Join-Path $app "keys.json") -Raw | ConvertFrom-Json
$baseKeysPath = Join-Path $Baseline "keys.json"
if (Test-Path $baseKeysPath) {
  $base = Get-Content $baseKeysPath -Raw | ConvertFrom-Json
  foreach ($p in $base.global.PSObject.Properties) {
    if ($newKeys.global.($p.Name) -ne $p.Value) { Bad "keys: baseline binding changed or lost: $($p.Name)" }
  }
  foreach ($p in $base.terminal.PSObject.Properties) {
    if ($newKeys.terminal.($p.Name) -ne $p.Value) { Bad "keys: terminal binding changed or lost: $($p.Name)" }
  }
  Ok "keys: baseline bindings intact"
} else { Write-Host "skip keys baseline ($baseKeysPath not found)" }

$lockPath = Join-Path $root "mods.lock.json"
if (Test-Path $lockPath) {
  $lock = Get-Content $lockPath -Raw | ConvertFrom-Json
  foreach ($name in $lock.mods.PSObject.Properties.Name) {
    foreach ($entry in $lock.mods.$name.files.PSObject.Properties) {
      $path = Join-Path (Join-Path $app "mods") ($name + "/" + $entry.Name)
      if (!(Test-Path $path)) { Bad "lock: $name/$($entry.Name) missing"; continue }
      $hash = (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
      if ($hash -ne $entry.Value.sha256) { Bad "lock: hash mismatch $name/$($entry.Name)" }
    }
  }
  Ok "lock: staged files match pins"
} else { Bad "mods.lock.json missing" }

if ($fail -gt 0) { Write-Host "$fail problem(s)"; exit 1 }
Write-Host "staging verified"
