# Build only. No download, installation, elevation, license acceptance or deployment.
# Requires an explicitly approved, locally provisioned WiX v7 toolchain.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InputsJson,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][switch]$ApprovedOfflineInputs
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $ApprovedOfflineInputs) { throw 'Candidate tooling, fees and redistribution rights must be approved first.' }
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or $env:PROCESSOR_ARCHITEW6432) {
    throw 'Use a native x64 Windows PowerShell process.'
}
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Build from a non-elevated session; do not grant additional privileges.'
}
$inputs = Get-Content -LiteralPath $InputsJson -Raw | ConvertFrom-Json
function VerifiedFile($entry) {
    if ($entry.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or -not [IO.Path]::IsPathRooted($entry.path)) {
        throw 'Every input must have an absolute path and pinned SHA256.'
    }
    $item = Get-Item -LiteralPath $entry.path
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Expected a regular, non-linked input file.'
    }
    if ((Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash -ne $entry.sha256) {
        throw 'Approved input hash mismatch.'
    }
    return $item.FullName
}
$wix = VerifiedFile $inputs.wix
$bal = VerifiedFile $inputs.bal
$util = VerifiedFile $inputs.util
$vc = VerifiedFile $inputs.vcRedist
if ($inputs.minimumVcVersion -notmatch '^14\.[0-9]+\.[0-9]+\.[0-9]+$') {
    throw 'Specify the four-field minimum VC runtime version justified for this experiment.'
}
$signature = Get-AuthenticodeSignature -LiteralPath $vc
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|, )CN=Microsoft Corporation(,|$)') {
    throw 'The pinned VC redistributable must have a valid Microsoft signature.'
}
$actualWix = (& $wix --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $actualWix -notmatch '^7\.' -or $actualWix -ne $inputs.wixVersion) {
    throw 'WiX v7 version differs from the approved toolchain.'
}
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'Use an absolute output directory.' }
$dest = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $dest) { throw 'Use a new output directory. Existing files will not be overwritten.' }
New-Item -ItemType Directory -Path $dest | Out-Null
# Stage exact authored inputs beside the prerequisite in a fresh directory.
# The source, current working directory, and bind path must agree.
$sourceHashes = [ordered]@{}
foreach ($name in @('Package.wxs','Bundle.wxs','marker.txt')) {
    $source = Join-Path $PSScriptRoot $name
    $sourceHashes[$name] = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    Copy-Item -LiteralPath $source -Destination (Join-Path $dest $name)
    if ((Get-FileHash -LiteralPath (Join-Path $dest $name) -Algorithm SHA256).Hash -ne $sourceHashes[$name]) {
        throw 'Staged source changed.'
    }
}
Copy-Item -LiteralPath $vc -Destination (Join-Path $dest 'vc_redist.x64.exe')
if ((Get-FileHash -LiteralPath (Join-Path $dest 'vc_redist.x64.exe') -Algorithm SHA256).Hash -ne $inputs.vcRedist.sha256) {
    throw 'Staged VC input changed.'
}
$msi = Join-Path $dest 'RedacteraInstallerPoC.msi'
$exe = Join-Path $dest 'RedacteraInstallerPoC-Setup.exe'
function InvokeWix([string[]]$Arguments) {
    & $wix @Arguments
    if ($LASTEXITCODE -ne 0) { throw "WiX command failed with exit code $LASTEXITCODE." }
}
# Do not suppress MSI ICE validation; investigate all validation failures.
Push-Location -LiteralPath $dest
try {
    InvokeWix @('build', '-arch', 'x64', '-b', $dest,
        '-o', $msi, (Join-Path $dest 'Package.wxs'))
    InvokeWix @('build', '-arch', 'x64', '-ext', $bal, '-ext', $util, '-b', $dest,
        '-d', "MinimumVcVersion=$($inputs.minimumVcVersion)", '-o', $exe, (Join-Path $dest 'Bundle.wxs'))
} finally { Pop-Location }
foreach ($name in $sourceHashes.Keys) {
    if ((Get-FileHash -LiteralPath (Join-Path $dest $name) -Algorithm SHA256).Hash -ne $sourceHashes[$name]) {
        throw 'Source changed during build.'
    }
}
if ((Get-FileHash -LiteralPath (Join-Path $dest 'vc_redist.x64.exe') -Algorithm SHA256).Hash -ne $inputs.vcRedist.sha256) {
    throw 'Prerequisite changed during build.'
}
function HashFile([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
[ordered]@{
    schema = 1
    kind = 'synthetic-poc-not-release'
    wixVersion = $actualWix
    minimumVcVersion = $inputs.minimumVcVersion
    vcRedistSha256 = HashFile (Join-Path $dest 'vc_redist.x64.exe')
    payloadSha256 = HashFile (Join-Path $dest 'marker.txt')
    msiSha256 = HashFile $msi
    bundleSha256 = HashFile $exe
    packageSourceSha256 = HashFile (Join-Path $dest 'Package.wxs')
    bundleSourceSha256 = HashFile (Join-Path $dest 'Bundle.wxs')
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dest 'artifact.json') -Encoding UTF8
Write-Output 'Synthetic build only. Do not distribute or run on a normal workstation.'
