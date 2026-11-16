# Build only. No download, installation, elevation, license acceptance or deployment.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InputsJson,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][switch]$ApprovedOfflineInputs
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $ApprovedOfflineInputs) { throw 'Candidate tooling, fees and redistribution rights must be approved first.' }
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or $env:PROCESSOR_ARCHITEW6432) { throw 'Use native x64 Windows PowerShell.' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Build from a non-elevated session.' }
. (Join-Path $PSScriptRoot 'PocNative.ps1')
$inputs = Get-Content -LiteralPath (Resolve-PocPath $InputsJson) -Raw | ConvertFrom-Json
function HashFile([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function VerifiedFile($entry) {
    if ($entry.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Pinned SHA256 required.' }
    $file = Resolve-PocPath $entry.path
    if ((Get-Item -LiteralPath $file).PSIsContainer -or (HashFile $file) -cne $entry.sha256) { throw 'Approved input hash mismatch.' }
    return $file
}
$wix = VerifiedFile $inputs.wix
$bal = VerifiedFile $inputs.bal
$util = VerifiedFile $inputs.util
$vc = VerifiedFile $inputs.vcRedist
if ($inputs.minimumVcVersion -notmatch '^14\.[0-9]+\.[0-9]+\.[0-9]+$' -or $inputs.sourceCommit -cnotmatch '^[a-f0-9]{40}$' -or $inputs.sourceTree -cnotmatch '^[a-f0-9]{40}$') { throw 'Specify approved source identity and four-field VC minimum.' }
$minimum = [version]$inputs.minimumVcVersion
if (@($minimum.Major,$minimum.Minor,$minimum.Build,$minimum.Revision) | Where-Object { $_ -lt 0 -or $_ -gt 65535 }) { throw 'Invalid VC minimum.' }
$signature = Get-AuthenticodeSignature -LiteralPath $vc
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|, )CN=Microsoft Corporation(,|$)') { throw 'Pinned VC redistributable requires a valid Microsoft signature.' }
$actualWix = (& $wix --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $actualWix -notmatch '^7\.0\.1(?:\+[0-9A-Za-z.-]+)?$' -or $actualWix -cne $inputs.wixVersion) { throw 'Expected approved WiX 7.0.1 toolchain.' }
$sourceNames = @('Package.wxs','Bundle.wxs','marker.txt','Build-Poc.ps1','Get-PocState.ps1','PocNative.ps1','verify_observations.py','test_poc.py','README.md')
$sourceHashes = [ordered]@{}
foreach ($name in $sourceNames) {
    $file = Resolve-PocPath (Join-Path $PSScriptRoot $name)
    $sourceHashes[$name] = HashFile $file
    if ($sourceHashes[$name] -cne $inputs.sourceHashes.$name) { throw 'Source does not match approved fixed-commit bytes.' }
}
$dest = Resolve-PocPath $OutputDirectory -NewDirectory
New-Item -ItemType Directory -Path $dest | Out-Null
foreach ($name in $sourceNames) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $dest $name) }
Copy-Item -LiteralPath $vc -Destination (Join-Path $dest 'vc_redist.x64.exe')
function AssertStaged {
    foreach ($name in $sourceNames) { if ((HashFile (Join-Path $dest $name)) -cne $sourceHashes[$name]) { throw 'Staged source changed.' } }
    if ((HashFile (Join-Path $dest 'vc_redist.x64.exe')) -cne $inputs.vcRedist.sha256) { throw 'Staged VC input changed.' }
    foreach ($entry in @($inputs.wix,$inputs.bal,$inputs.util,$inputs.vcRedist)) { $null = VerifiedFile $entry }
}
AssertStaged
$msi = Join-Path $dest 'RedacteraInstallerPoC.msi'
$exe = Join-Path $dest 'RedacteraInstallerPoC-Setup.exe'
function InvokeWix([string]$LogName, [string[]]$Arguments) {
    $log = Join-Path $dest $LogName
    ('COMMAND: wix ' + ($Arguments -join ' ')) | Set-Content -LiteralPath $log -Encoding UTF8
    $saved = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = $null
        & $wix @Arguments 2>&1 | Out-File -LiteralPath $log -Append -Encoding UTF8 -ErrorAction Stop
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $saved }
    "EXIT: $exitCode" | Add-Content -LiteralPath $log -Encoding UTF8
    if ($null -eq $exitCode -or $exitCode -ne 0) { throw "WiX command did not succeed; see local log." }
}
Push-Location -LiteralPath $dest
try {
    InvokeWix 'msi-build.log' @('build','-arch','x64','-b',$dest,'-o',$msi,(Join-Path $dest 'Package.wxs'))
    $msiHash = HashFile $msi
    # CLI build is not ICE validation. Require both default validation and explicit ICE105.
    InvokeWix 'ice-full.log' @('msi','validate',$msi)
    InvokeWix 'ice105.log' @('msi','validate','-ice','ICE105',$msi)
    if ((HashFile $msi) -cne $msiHash) { throw 'MSI changed during validation.' }
    Initialize-PocMsi
    $product = [guid]::Parse([RedacteraPocMsi]::Property($msi,'ProductCode')).ToString('B').ToUpperInvariant()
    $productUpgrade = [guid]::Parse([RedacteraPocMsi]::Property($msi,'UpgradeCode')).ToString('B').ToUpperInvariant()
    if ($productUpgrade -cne '{B76229C2-D71D-4261-90C2-FC952F91D148}' -or [RedacteraPocMsi]::Property($msi,'ProductName') -cne 'Redactera Installer PoC Marker' -or [RedacteraPocMsi]::Property($msi,'ALLUSERS') -ne '2' -or [RedacteraPocMsi]::Property($msi,'MSIINSTALLPERUSER') -ne '1') { throw 'MSI identity or default scope does not match the experiment.' }
    InvokeWix 'bundle-build.log' @('build','-arch','x64','-ext',$bal,'-ext',$util,'-b',$dest,'-d',"MinimumVcVersion=$($inputs.minimumVcVersion)",'-o',$exe,(Join-Path $dest 'Bundle.wxs'))
    $bundleHash = HashFile $exe
    $ba = Join-Path $dest 'ba'; $attached = Join-Path $dest 'attached'
    InvokeWix 'bundle-extract.log' @('burn','extract',$exe,'-o',$attached,'-oba',$ba)
    $manifestPath = Join-Path $ba 'manifest.xml'
    $settings = [Xml.XmlReaderSettings]::new(); $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit; $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create($manifestPath,$settings)
    try { $manifest = [Xml.XmlDocument]::new(); $manifest.XmlResolver = $null; $manifest.Load($reader) } finally { $reader.Dispose() }
    $reg = @($manifest.SelectNodes("/*[local-name()='BurnManifest']/*[local-name()='Registration']"))
    $chain = @($manifest.SelectNodes("/*[local-name()='BurnManifest']/*[local-name()='Chain']/*[local-name()='MsiPackage' and @Id='MarkerMsi']"))
    if ($reg.Count -ne 1 -or $chain.Count -ne 1) { throw 'Missing Burn registration or MSI identity.' }
    $bundleCode = [guid]::Parse($reg[0].GetAttribute('Code')).ToString('B').ToUpperInvariant()
    $bundleUpgrade = [guid]::Parse($reg[0].GetAttribute('PrimaryUpgradeCode')).ToString('B').ToUpperInvariant()
    if ($bundleUpgrade -cne '{EEA7864A-A7E7-46B7-977E-DAACFC94F4E5}' -or [guid]::Parse($chain[0].GetAttribute('ProductCode')).ToString('B').ToUpperInvariant() -cne $product) { throw 'Burn manifest identity mismatch.' }
    foreach ($pair in @(@('RedacteraInstallerPoC.msi',$msiHash),@('vc_redist.x64.exe',$inputs.vcRedist.sha256))) {
        $copies = @(Get-ChildItem -LiteralPath $attached -Recurse -File -Filter $pair[0])
        if ($copies.Count -ne 1 -or (HashFile $copies[0].FullName) -cne $pair[1]) { throw 'Embedded package bytes do not match the validated input.' }
    }
    if ((HashFile $msi) -cne $msiHash -or (HashFile $exe) -cne $bundleHash) { throw 'Installer changed during inspection.' }
    AssertStaged
} finally { Pop-Location }
[ordered]@{
    schema=2; kind='synthetic-poc-not-release'; wixVersion=$actualWix; minimumVcVersion=$inputs.minimumVcVersion
    sourceCommit=$inputs.sourceCommit; sourceTree=$inputs.sourceTree; sourceHashes=$sourceHashes
    toolHashes=[ordered]@{wix=$inputs.wix.sha256;bal=$inputs.bal.sha256;util=$inputs.util.sha256;vcRedist=$inputs.vcRedist.sha256}
    msiSha256=$msiHash; bundleSha256=$bundleHash; payloadSha256=$sourceHashes['marker.txt']; manifestSha256=(HashFile $manifestPath)
    productCode=$product; bundleCode=$bundleCode; productUpgradeCode=$productUpgrade; bundleUpgradeCode=$bundleUpgrade
    ice=[ordered]@{fullExit=0;ice105Exit=0;fullLogSha256=(HashFile (Join-Path $dest 'ice-full.log'));ice105LogSha256=(HashFile (Join-Path $dest 'ice105.log'))}
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $dest 'artifact.json') -Encoding UTF8
Write-Output 'Synthetic build only; native experiment still requires independent review and authorization.'
