#Requires -Version 5.1
<#
.SYNOPSIS
    Configures and builds the native sc2mpq helper.

.DESCRIPTION
    Produces native/sc2mpq/bin/sc2mpq(.exe), which the TypeScript adapter looks for
    without needing a config entry.

    Requires CMake and a C++20 compiler. On Windows that means the "Desktop development
    with C++" workload; the script checks for it and says so rather than failing deep
    inside CMake.

    StormLib must already be present -- run scripts/bootstrap.ps1 first.

.PARAMETER Configuration
    Release (default) or Debug.

.PARAMETER Clean
    Delete the build directory before configuring.
#>
[CmdletBinding()]
param(
    [ValidateSet('Release', 'Debug')]
    [string] $Configuration = 'Release',
    [switch] $Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$projectDir = Join-Path $repoRoot 'native\sc2mpq'
$buildDir = Join-Path $projectDir 'build'

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
    throw 'cmake was not found on PATH. Install CMake 3.20 or newer.'
}

if (-not (Test-Path (Join-Path $projectDir 'third_party\StormLib\CMakeLists.txt'))) {
    throw 'StormLib is missing. Run scripts/bootstrap.ps1 first.'
}

if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $vsPath = & $vswhere -latest -products * -format value -property installationPath | Select-Object -First 1
        if (-not $vsPath -or -not (Test-Path (Join-Path $vsPath 'VC\Tools\MSVC'))) {
            throw @"
No MSVC C++ toolset was found.

Install the 'Desktop development with C++' workload in the Visual Studio Installer,
or install the standalone Build Tools:
  winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools"
"@
        }
    }
}

if ($Clean -and (Test-Path $buildDir)) {
    Remove-Item $buildDir -Recurse -Force
}

Write-Host "==> Configuring ($Configuration)" -ForegroundColor Cyan
cmake -S $projectDir -B $buildDir -DCMAKE_BUILD_TYPE=$Configuration
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed with exit code $LASTEXITCODE" }

Write-Host "==> Building" -ForegroundColor Cyan
cmake --build $buildDir --config $Configuration --parallel
if ($LASTEXITCODE -ne 0) { throw "cmake build failed with exit code $LASTEXITCODE" }

$binary = Join-Path $projectDir 'bin\sc2mpq.exe'
if (-not (Test-Path $binary)) { $binary = Join-Path $projectDir 'bin/sc2mpq' }
if (-not (Test-Path $binary)) { throw "Build reported success but no binary was produced under $projectDir\bin." }

Write-Host ''
Write-Host "==> Smoke test" -ForegroundColor Cyan
& $binary version
if ($LASTEXITCODE -ne 0) { throw "The built helper failed its version probe (exit $LASTEXITCODE)." }

Write-Host ''
Write-Host "Built: $binary" -ForegroundColor Green
