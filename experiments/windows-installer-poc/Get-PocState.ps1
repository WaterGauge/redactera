# Read-only observations from the CURRENT login. Never elevate to collect A's receipt.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$RunId,
    [Parameter(Mandatory)][ValidateSet('baseline','installed','repaired','removed','cancelled')][string]$Phase,
    [Parameter(Mandatory)][string]$ArtifactPath,
    [Parameter(Mandatory)][string]$ExpectedHelperSha256,
    [Parameter(Mandatory)][string]$BundlePath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or $env:PROCESSOR_ARCHITEW6432) { throw 'Use native x64 Windows PowerShell.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Collect from the actual non-elevated login.' }
# Expected hash comes from the independently verified, approved source manifest.
# Do not load executable helper code to perform its own identity check.
$helper = Join-Path $PSScriptRoot 'PocNative.ps1'
$helperItem = Get-Item -LiteralPath $helper -Force
if ($ExpectedHelperSha256 -cnotmatch '^[a-f0-9]{64}$' -or $helperItem.PSIsContainer -or
    ($helperItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedHelperSha256) {
    throw 'Helper identity mismatch before execution.'
}
. $helper
function HashFile([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
$artifactFile = Resolve-PocPath $ArtifactPath
$artifactHash = HashFile $artifactFile
$artifact = Get-Content -LiteralPath $artifactFile -Raw | ConvertFrom-Json
if ($artifact.sourceHashes.'PocNative.ps1' -cne $ExpectedHelperSha256) { throw 'Artifact helper identity mismatch.' }
$bundleHash = HashFile (Resolve-PocPath $BundlePath)
if ($artifact.schema -ne 2 -or $artifact.kind -cne 'synthetic-poc-not-release' -or $artifact.bundleSha256 -cne $bundleHash -or $artifact.productUpgradeCode -cne '{B76229C2-D71D-4261-90C2-FC952F91D148}' -or $artifact.bundleUpgradeCode -cne '{EEA7864A-A7E7-46B7-977E-DAACFC94F4E5}') { throw 'Artifact identity mismatch.' }
foreach ($name in @('Get-PocState.ps1','PocNative.ps1')) {
    if ((HashFile (Resolve-PocPath (Join-Path $PSScriptRoot $name))) -cne $artifact.sourceHashes.$name) { throw 'Observation source mismatch.' }
}
$productCode = [guid]::Parse($artifact.productCode).ToString('B').ToUpperInvariant()
$bundleCode = [guid]::Parse($artifact.bundleCode).ToString('B').ToUpperInvariant()
if ($productCode -cne $artifact.productCode -or $bundleCode -cne $artifact.bundleCode -or $productCode -eq $bundleCode) { throw 'Invalid artifact codes.' }
Initialize-PocMsi
$related = @([RedacteraPocMsi]::Related($artifact.productUpgradeCode))
$codes = @((@($productCode) + $related) | Sort-Object -Unique)
$contexts = @(
    foreach ($code in $codes) {
        foreach ($context in [RedacteraPocMsi]::Contexts($code,$identity.User.Value)) {
            [ordered]@{code=$code; context=[int]$context}
        }
    }
)
$sha = [Security.Cryptography.SHA256]::Create()
try { $account = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$RunId/$($identity.User.Value)"))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
$markerKey = 'Software\RedacteraInstallerPoC-B76229C2'
$arpKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
$vcKey = 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
function AddEntry($Entries,$Entry,[int]$View) {
    $id = $Entry.code
    if ($Entries.ContainsKey($id)) {
        $old = $Entries[$id]
        foreach ($name in $Entry.Keys) { if ($old[$name] -cne $Entry[$name]) { throw 'Registry views disagree on experiment registration.' } }
        $old['views'] = @($old.views + $View | Sort-Object -Unique)
    } else {
        $Entry['views'] = @($View)
        $Entries[$id] = $Entry
    }
}
function ReadScope([Microsoft.Win32.RegistryHive]$Hive,[string]$Root,[bool]$Machine) {
    $markers = @{32=$null;64=$null}; $bundles = @{}; $msis = @{}
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
        $bits = if ($view -eq [Microsoft.Win32.RegistryView]::Registry64) { 64 } else { 32 }
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Hive,$view)
        try {
            $key = $base.OpenSubKey($markerKey)
            if ($null -ne $key) {
                try {
                    $markers[$bits] = $key.GetValue('MarkerVersion',$null)
                    if ($null -eq $markers[$bits]) { throw 'Experiment marker registry key has missing value.' }
                } finally { $key.Dispose() }
            }
            $arp = $base.OpenSubKey($arpKey)
            if ($null -ne $arp) {
                try {
                    foreach ($id in $arp.GetSubKeyNames()) {
                        $key = $arp.OpenSubKey($id)
                        if ($null -eq $key) { throw 'Uninstall registration changed during collection.' }
                        try {
                            $name = $key.GetValue('DisplayName','')
                            $bundleFamily = @($key.GetValue('BundleUpgradeCode',@())) -contains $artifact.bundleUpgradeCode
                            $isBundle = $id -eq $bundleCode -or $bundleFamily -or $name -ceq 'Redactera Installer PoC Bundle'
                            $isMsi = $codes -contains $id -or $name -ceq 'Redactera Installer PoC Marker'
                            if (-not ($isBundle -or $isMsi)) { continue }
                            if ($isBundle -and $isMsi) { throw 'Ambiguous experiment registration.' }
                            $code = [guid]::Parse($id).ToString('B').ToUpperInvariant()
                            $hidden = $key.GetValue('SystemComponent',0)
                            if ($hidden -isnot [int] -or $hidden -notin @(0,1)) { throw 'Invalid SystemComponent value.' }
                            if ($isBundle) {
                                AddEntry $bundles ([ordered]@{code=$code;hidden=($hidden -eq 1);nameMatches=($name -ceq 'Redactera Installer PoC Bundle');familyMatches=$bundleFamily;installed=$key.GetValue('Installed',$null)}) $bits
                            } else {
                                AddEntry $msis ([ordered]@{code=$code;hidden=($hidden -eq 1);nameMatches=($name -ceq 'Redactera Installer PoC Marker')}) $bits
                            }
                        } finally { $key.Dispose() }
                    }
                } finally { $arp.Dispose() }
            }
        } finally { $base.Dispose() }
    }
    $file = Join-Path $Root 'RedacteraInstallerPoC-B76229C2\marker.txt'
    $digest = $null
    if (Test-Path -LiteralPath $file) {
        $file = Resolve-PocPath $file
        if ((Get-Item -LiteralPath $file).PSIsContainer) { throw 'Marker is not a regular file.' }
        $digest = HashFile $file
    }
    return [ordered]@{
        marker64=$markers[64]; marker32=$markers[32]; payloadSha256=$digest
        bundleEntries=@($bundles.Values | Sort-Object { $_.code }); msiEntries=@($msis.Values | Sort-Object { $_.code })
        contexts=@($contexts | Where-Object { ($_.context -eq 4) -eq $Machine } | Sort-Object { $_.code },{ $_.context })
    }
}
$machineBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
try {
    $vc = $machineBase.OpenSubKey($vcKey)
    $vcInstalled = $null; $vcVersion = $null
    if ($null -ne $vc) { try { $vcInstalled=$vc.GetValue('Installed',$null); $vcVersion=$vc.GetValue('Version',$null) } finally { $vc.Dispose() } }
    $os = $machineBase.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion')
    if ($null -eq $os) { throw 'Cannot read Windows version.' }
    try { $build=$os.GetValue('CurrentBuildNumber',$null); $ubr=$os.GetValue('UBR',$null); $edition=$os.GetValue('EditionID',$null) } finally { $os.Dispose() }
} finally { $machineBase.Dispose() }
$userRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs'
$machineRoot = [Environment]::GetFolderPath('ProgramFiles')
$user = ReadScope CurrentUser $userRoot $false
$machine = ReadScope LocalMachine $machineRoot $true
if ((HashFile $artifactFile) -cne $artifactHash -or (HashFile $BundlePath) -cne $bundleHash) { throw 'Input identity changed while observing.' }
[ordered]@{
    schema=2;runId=$RunId.ToString();phase=$Phase;accountToken=$account;elevated=$false;architecture='x64'
    build=$build;ubr=$ubr;edition=$edition;bundleSha256=$bundleHash;artifactSha256=$artifactHash
    productCode=$productCode;bundleCode=$bundleCode;user=$user;machine=$machine;vcInstalled=$vcInstalled;vcVersion=$vcVersion
} | ConvertTo-Json -Depth 8
