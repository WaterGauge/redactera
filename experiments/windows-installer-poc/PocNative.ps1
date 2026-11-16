# Read-only native helpers shared by the synthetic build and observation scripts.
function Resolve-PocPath([string]$Path, [switch]$NewDirectory) {
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.Substring(2).Contains(':') -or $Path.Contains('/')) {
        throw 'Use a fully qualified local drive path, not a relative, UNC, device or stream path.'
    }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -ne $Path.TrimEnd('\') -and $full -ne $Path) { throw 'Use a canonical local path.' }
    $root = [IO.Path]::GetPathRoot($full)
    if ([IO.DriveInfo]::new($root).DriveType -ne [IO.DriveType]::Fixed) { throw 'Use a local fixed disk.' }
    $parts = @($full.Substring($root.Length).Split('\') | Where-Object { $_ -ne '' })
    $current = $root
    for ($i = 0; $i -lt $parts.Count; $i++) {
        if ($parts[$i] -in @('.', '..') -or $parts[$i] -match '[. ]$') { throw 'Noncanonical path segment.' }
        $current = Join-Path $current $parts[$i]
        if ($NewDirectory -and $i -eq ($parts.Count - 1)) {
            if (Test-Path -LiteralPath $current) { throw 'Use a fresh output directory.' }
        } else {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked path or ancestor is not allowed.' }
            if ($i -lt ($parts.Count - 1) -and -not $item.PSIsContainer) { throw 'Invalid path ancestor.' }
        }
    }
    if ($NewDirectory -and $parts.Count -eq 0) { throw 'Output must not be a drive root.' }
    return $full
}

function Initialize-PocMsi {
    if ('RedacteraPocMsi' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class RedacteraPocMsi {
    [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern uint MsiOpenDatabaseW(string path, IntPtr mode, out uint db);
    [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern uint MsiDatabaseOpenViewW(uint db, string query, out uint view);
    [DllImport("msi.dll", ExactSpelling=true)] static extern uint MsiViewExecute(uint view, uint record);
    [DllImport("msi.dll", ExactSpelling=true)] static extern uint MsiViewFetch(uint view, out uint record);
    [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern uint MsiRecordGetStringW(uint record, uint field, StringBuilder result, ref uint size);
    [DllImport("msi.dll", ExactSpelling=true)] static extern uint MsiCloseHandle(uint handle);
    [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern uint MsiEnumProductsExW(string code, string sid, uint context, uint index, StringBuilder actualCode, out uint actualContext, StringBuilder actualSid, ref uint sidLength);
    [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern uint MsiEnumRelatedProductsW(string upgradeCode, uint reserved, uint index, StringBuilder code);
    static void Check(uint status) { if (status != 0) throw new InvalidOperationException("MSI read-only API failed: " + status); }
    public static string Property(string path, string name) {
        if (name != "ProductCode" && name != "UpgradeCode" && name != "ProductName" && name != "ALLUSERS" && name != "MSIINSTALLPERUSER") throw new ArgumentException("Unknown property");
        uint db=0, view=0, record=0;
        try {
            Check(MsiOpenDatabaseW(path, IntPtr.Zero, out db));
            Check(MsiDatabaseOpenViewW(db, "SELECT `Value` FROM `Property` WHERE `Property`='" + name + "'", out view));
            Check(MsiViewExecute(view, 0)); Check(MsiViewFetch(view, out record));
            var value = new StringBuilder(512); uint size = (uint)value.Capacity;
            Check(MsiRecordGetStringW(record, 1, value, ref size)); return value.ToString();
        } finally { if (record!=0) MsiCloseHandle(record); if (view!=0) MsiCloseHandle(view); if (db!=0) MsiCloseHandle(db); }
    }
    public static string[] Related(string upgradeCode) {
        var result = new List<string>();
        for (uint i=0;i<1024;i++) {
            var code = new StringBuilder(39); uint status=MsiEnumRelatedProductsW(upgradeCode,0,i,code);
            if (status==259) return result.ToArray(); Check(status); result.Add(Guid.Parse(code.ToString()).ToString("B").ToUpperInvariant());
        }
        throw new InvalidOperationException("Too many related MSI registrations");
    }
    public static uint[] Contexts(string code, string currentSid) {
        var result=new List<uint>();
        for (uint i=0;i<32;i++) {
            var actual=new StringBuilder(39); var sid=new StringBuilder(256); uint size=(uint)sid.Capacity, context;
            uint status=MsiEnumProductsExW(code,null,7,i,actual,out context,sid,ref size);
            if (status==259) return result.ToArray(); Check(status);
            if (!String.Equals(actual.ToString(),code,StringComparison.OrdinalIgnoreCase) ||
                (context!=1 && context!=2 && context!=4) || (context!=4 && sid.ToString()!=currentSid))
                throw new InvalidOperationException("Unexpected MSI context or account");
            result.Add(context);
        }
        throw new InvalidOperationException("Too many MSI contexts");
    }
}
'@
}
