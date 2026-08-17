#Requires -Version 5.1
<#
.SYNOPSIS
    Fetches the pinned upstream sources listed in vendor/PINS.json.

.DESCRIPTION
    The vendored checkouts are gitignored, so a fresh clone is not buildable end to end
    until this has run. Each source is checked out at an exact commit -- never a branch
    tip -- because both upstreams are moving targets (PLAN.md section 7, section 55 rule 6).

    Re-running is safe: an existing checkout already at the pinned ref is left alone.

.PARAMETER Only
    Fetch just one pinned source by name, e.g. -Only sc2-galaxy-toolkit.

.PARAMETER Force
    Discard local changes in an existing checkout before moving to the pinned ref.
#>
[CmdletBinding()]
param(
    [string] $Only,
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$pinsPath = Join-Path $repoRoot 'vendor\PINS.json'

if (-not (Test-Path $pinsPath)) {
    throw "Cannot find $pinsPath. Run this from a checkout of the repository."
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'git is required but was not found on PATH.'
}

$pins = (Get-Content $pinsPath -Raw | ConvertFrom-Json).pins

foreach ($pin in $pins) {
    if ($Only -and $pin.name -ne $Only) { continue }

    $destination = Join-Path $repoRoot ($pin.destination -replace '/', '\')
    Write-Host "==> $($pin.name) @ $($pin.ref)" -ForegroundColor Cyan
    Write-Host "    $($pin.why)" -ForegroundColor DarkGray

    if ($pin.ref -notmatch '^[0-9a-f]{40}$') {
        # PINS.json records 'master' for StormLib as an honest placeholder rather than a
        # fabricated hash. Fetching it still works, but the build is not reproducible
        # until a real commit is pinned.
        Write-Warning "    '$($pin.ref)' is not a commit hash. This checkout is NOT reproducible; pin a commit before relying on it."
    }

    if (Test-Path (Join-Path $destination '.git')) {
        Push-Location $destination
        try {
            $current = (git rev-parse HEAD).Trim()
            if ($current -eq $pin.ref) {
                Write-Host '    already at the pinned ref' -ForegroundColor DarkGray
                continue
            }
            if ($Force) {
                git reset --hard | Out-Null
                git clean -fd | Out-Null
            }
            git fetch --depth 1 origin $pin.ref
            git checkout --detach FETCH_HEAD
        }
        finally {
            Pop-Location
        }
        continue
    }

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    git init --quiet $destination
    Push-Location $destination
    try {
        git remote add origin $pin.repo
        git fetch --depth 1 origin $pin.ref
        git checkout --detach FETCH_HEAD
    }
    finally {
        Pop-Location
    }
}

Write-Host ''
Write-Host 'Done. Next: pnpm install' -ForegroundColor Green
