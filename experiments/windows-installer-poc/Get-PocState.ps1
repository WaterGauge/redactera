# Read-only observations from the CURRENT login. Never elevate to collect A's receipt.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$RunId,
    [Parameter(Mandatory)][ValidateSet('baseline','installed','repaired','removed','cancelled')][string]$Phase,
    [Parameter(Mandatory)][string]$BundlePath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or $env:PROCESSOR_ARCHITEW6432) {
    throw 'Use native x64 Windows PowerShell.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Collect evidence in a non-elevated session for the actual login account.'
}
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $account = [BitConverter]::ToString($sha.ComputeHash(
        [Text.Encoding]::UTF8.GetBytes("$RunId/$($identity.User.Value)"))).Replace('-','').ToLowerInvariant()
} finally { $sha.Dispose() }
$markerKey = 'Software\RedacteraInstallerPoC-B76229C2'
$arpKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
$vcKey = 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
function ReadScope([Microsoft.Win32.RegistryHive]$Hive, [string]$Root) {
    $marker = $null
    $bundleIds = @{}
    $visibleMsiIds = @{}
    $msiIds = @{}
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Hive, $view)
        try {
            if ($view -eq [Microsoft.Win32.RegistryView]::Registry64) {
                $key = $base.OpenSubKey($markerKey)
                if ($null -ne $key) {
                    try { $marker = $key.GetValue('MarkerVersion', $null) } finally { $key.Dispose() }
                }
            }
            $arp = $base.OpenSubKey($arpKey)
            if ($null -ne $arp) {
                try {
                    foreach ($id in $arp.GetSubKeyNames()) {
                        $key = $arp.OpenSubKey($id)
                        if ($null -eq $key) { throw 'Uninstall registration changed during collection.' }
                        try {
                            $name = $key.GetValue('DisplayName', '')
                            $hidden = $key.GetValue('SystemComponent', 0) -eq 1
                            if ($name -ceq 'Redactera Installer PoC Bundle' -and -not $hidden) { $bundleIds[$id] = $true }
                            if ($name -ceq 'Redactera Installer PoC Marker') {
                                $msiIds[$id] = $true
                                if (-not $hidden) { $visibleMsiIds[$id] = $true }
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
        $item = Get-Item -LiteralPath $file
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'PoC marker is not a regular file.'
        }
        $digest = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return [ordered]@{
        markerVersion = $marker
        payloadSha256 = $digest
        visibleBundle = $bundleIds.Count
        registeredMsi = $msiIds.Count
        visibleMsi = $visibleMsiIds.Count
    }
}
$machineBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
try {
    $vc = $machineBase.OpenSubKey($vcKey)
    $vcInstalled = $null
    $vcVersion = $null
    if ($null -ne $vc) {
        try {
            $vcInstalled = $vc.GetValue('Installed', $null)
            $vcVersion = $vc.GetValue('Version', $null)
        } finally { $vc.Dispose() }
    }
    $os = $machineBase.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion')
    if ($null -eq $os) { throw 'Cannot read Windows version.' }
    try {
        $build = $os.GetValue('CurrentBuildNumber', $null)
        $ubr = $os.GetValue('UBR', $null)
        $edition = $os.GetValue('EditionID', $null)
    } finally { $os.Dispose() }
} finally { $machineBase.Dispose() }
$userRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs'
$machineRoot = [Environment]::GetFolderPath('ProgramFiles')
[ordered]@{
    schema = 1
    runId = $RunId.ToString()
    phase = $Phase
    accountToken = $account
    elevated = $false
    architecture = 'x64'
    build = $build
    ubr = $ubr
    edition = $edition
    bundleSha256 = (Get-FileHash -LiteralPath $BundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
    user = ReadScope CurrentUser $userRoot
    machine = ReadScope LocalMachine $machineRoot
    vcInstalled = $vcInstalled
    vcVersion = $vcVersion
} | ConvertTo-Json -Depth 5
