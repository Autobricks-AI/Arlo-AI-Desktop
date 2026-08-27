# Write a .env with real secrets in it, so the only thing left is `docker compose up`.
#
# The same job as scripts/setup.sh, for a Windows machine that has Docker and no shell to
# run it with. PowerShell ships with Windows, which is the point: the README promises
# Docker and nothing else, so getting to the first boot must not need a toolchain.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#
# Safe to re-run: an existing .env is never overwritten, and any placeholder still left in
# it is filled in. Real values already there are left exactly as they are.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$template = '.env.example'
$target = '.env'

if (-not (Test-Path $template)) { throw "No $template here - are you in the repo root?" }

# Hex, so the result is alphanumeric. setup/docker-init.sh seds these into 00-roles.sql and
# a '/' or a quote in one would break it.
#
# RNGCryptoServiceProvider rather than RandomNumberGenerator::Fill, which is .NET Core only.
# Windows PowerShell 5.1 is what ships with Windows, runs on .NET Framework, and does not
# have it. This works on both, which is the whole job of this file.
function New-Secret([int]$bytes = 21) {
  $b = New-Object byte[] $bytes
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  try { $rng.GetBytes($b) } finally { $rng.Dispose() }
  ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}

if (Test-Path $target) {
  Write-Output "$target already exists - filling in any placeholders, keeping everything else."
} else {
  Copy-Item $template $target
  Write-Output "Created $target from $template."
}

# Read as one string so a placeholder is replaced everywhere it appears: ARLO_APP_PASSWORD
# is both its own line and part of DATABASE_URL, and the two have to match.
$text = Get-Content $target -Raw

# Normalise to LF before anything else looks at it.
#
# This file is written on Windows and then read on Linux: Compose passes these values into
# the container, and setup/docker-init.sh seds them into 00-roles.sql. A trailing \r becomes
# part of the password there, so the role is created with one and the app connects without:
# `password authentication failed for user "arlo_owner"`, against a .env that looks correct.
$text = $text -replace "`r`n", "`n"

$filled = @()

foreach ($pair in @(
    @{ Placeholder = 'CHANGE-ME-SUPER'; Value = (New-Secret 21) },
    @{ Placeholder = 'CHANGE-ME-OWNER'; Value = (New-Secret 21) },
    @{ Placeholder = 'CHANGE-ME-APP'; Value = (New-Secret 21) }
  )) {
  if ($text -match [regex]::Escape($pair.Placeholder)) {
    $text = $text -replace [regex]::Escape($pair.Placeholder), $pair.Value
    $filled += $pair.Placeholder
  }
}

# SECRET_KEY ships blank rather than as a placeholder, which is indistinguishable from
# somebody having cleared it on purpose. Only ever filled when the line is empty.
#
# `\r?$` because the checkout may have CRLF line endings, and in .NET `$` matches before the
# `\n` but *after* the `\r`, so a plain `^SECRET_KEY=$` silently matches nothing on Windows,
# which is exactly the machine this file exists for. It shipped that way for one test run.
if ($text -match '(?m)^SECRET_KEY=[ \t]*\r?$') {
  $text = $text -replace '(?m)^SECRET_KEY=[ \t]*\r?$', "SECRET_KEY=$(New-Secret 32)"
  $filled += 'SECRET_KEY'
}

# No BOM: node --env-file reads this, and a BOM makes the first variable name unparseable.
[System.IO.File]::WriteAllText((Resolve-Path $target), $text, (New-Object System.Text.UTF8Encoding $false))

if ($filled.Count -eq 0) {
  Write-Output "Nothing to fill in - $target already has its secrets."
} else {
  # Named, not counted. "Generated 3 secret(s)" was the whole of the old report, and when
  # the fourth silently did not match it said nothing about which one - the failure turned
  # up much later as a Compose error about SECRET_KEY, with no thread back to here.
  Write-Output 'Filled in:'
  foreach ($name in $filled) { Write-Output "  $name" }
}

# Say it plainly rather than leaving it to Compose, which reports only the first variable it
# trips over and does so as an interpolation error several steps from the thing to fix.
$missing = @()
foreach ($var in @('POSTGRES_SUPERUSER_PASSWORD', 'ARLO_OWNER_PASSWORD', 'ARLO_APP_PASSWORD', 'SECRET_KEY')) {
  $line = ($text -split "`n" | Where-Object { $_ -match "^$var=" } | Select-Object -First 1)
  $value = if ($null -eq $line) { '' } else { ($line -replace "^$var=", '').Trim() }
  if ($value -eq '' -or $value -like 'CHANGE-ME*') { $missing += $var }
}

if ($missing.Count -gt 0) {
  Write-Output ''
  Write-Output "Not ready yet. These still need a value in ${target}:"
  foreach ($name in $missing) { Write-Output "  $name" }
  Write-Output ''
  Write-Output 'Any random text works - see "Doing it by hand" in the README.'
  exit 1
}

Write-Output ''
Write-Output 'All four secrets are set.'

Write-Output ''
Write-Output 'Next:'
Write-Output ''
Write-Output '  docker compose up -d'
Write-Output ''
Write-Output 'It builds on the first run, so give it a minute. Watch that with:'
Write-Output ''
Write-Output '  docker compose logs -f app'
Write-Output ''
Write-Output 'Then open http://127.0.0.1:9005 and sign in with  arlo / arlo'
Write-Output '- and change it in Settings, because that password is in the README.'
