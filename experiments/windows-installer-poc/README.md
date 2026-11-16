# Windows installer candidate experiment (not a release)

This isolated PoC tests WiX 7.0.1 Burn + one dual-purpose x64 MSI with a synthetic marker only. It is not a technology selection, a release package or an Electron Forge integration. Do not install on a real workstation, use actual user data or distribute it. Use authorized disposable Windows 11 and Windows 10 22H2 x64 snapshots, synthetic standard user A and separate administrator B. Never remove or damage a shared runtime on a host.

## Approved offline build inputs and identity

- Package.wxs: synthetic family/component GUIDs, default per-user, Windows Installer directory/registry redirection, embedded cabinet; no actual application settings, shortcuts, DPAPI, migrations, services, custom actions or recursive cleanup. Default paths only; no custom path/ACL or scope-conversion implementation.
- Bundle.wxs: stock native WixStdBA, embedded official x64 VC redistributable then MSI. The machine dependency is permanent/vital; x64 registry Installed and minimum version detection; 0, 3010, 1641 distinguished; other exits fail (including 1638). No remote payloads.
- Build-Poc.ps1 and PocNative.ps1: use a non-elevated native Windows x64 process. Only a locally provisioned, specifically approved toolchain and fully qualified fixed-drive paths with no linked ancestors. No download, no auto-acceptance of agreements, no execution of installers. Stop if license, fee, dependency integrity or native validation fails. Do not relax permissions or disable validation.

The independently prepared and approved local JSON must contain sourceCommit/sourceTree (40 lowercase hex), sourceHashes (SHA256 for **all nine experiment files**), wixVersion (exact approved 7.0.1 CLI output), minimumVcVersion (four-field numeric v14 minimum justified by actual dependencies), and wix, bal, util, vcRedist objects (absolute local path and lowercase sha256). Prepare the full SDK/CLI/extension dependency closure, licenses, provenance and actual x64 VC payload evidence independently; the script's named input hashes are not the entire toolchain lock. Never guess a hash or adopt the test fixture's VC threshold. The approved manifest is separate from build outputs; do not regenerate it from an unverified local tree.

Before executing either PowerShell entry point, use an independently trusted copy of verify_observations.py (its own SHA256 verified out of band) to check the nine source files against the approved manifest. Keep the approved manifest and verified source in a controlled directory, without untrusted writers. Run the preflight on the actual Windows paths; it only hashes files, not executes tools. It does not establish the complete toolchain closure, license, signatures, or resistance to concurrent malicious replacement.

```powershell
python C:\trusted\verify_observations.py --preflight-source C:\isolated\poc-source --approved-inputs C:\isolated\approved-inputs.json --verify-tools
```

Source-only preflight (omit --verify-tools) is sufficient for rechecking the same source before observation; tool files need not exist in the observation VM. In both entry points explicitly supply ExpectedHelperSha256 from the independently approved manifest, not a new hash of the helper. Internal entry-point checks compare it before dot-sourcing PocNative.ps1 and again against the input/artifact identity. An external preflight and trusted source copy remain mandatory; the entry point does not authenticate its own code.

```powershell
$approved = Get-Content -LiteralPath C:\isolated\approved-inputs.json -Raw | ConvertFrom-Json
.\Build-Poc.ps1 -InputsJson C:\isolated\approved-inputs.json -OutputDirectory C:\isolated\poc-build-1 -ExpectedHelperSha256 $approved.sourceHashes.'PocNative.ps1' -ApprovedOfflineInputs
```

Use a fresh, absolute output directory with an existing trusted parent. Before and after the build all staged sources and VC bytes are checked against approved input hashes. After building MSI, run WiX CLI default MSI validation (WiX's own stock exclusions apply; no project suppressions) and explicitly `wix msi validate -ice ICE105`. Record both commands, exit codes, logs and unchanged MSI hash; inspect the real log and verify the ICE actually ran, including a deliberate failure in a separately approved synthetic test. Nonzero/missing exit or changed bytes prevents creation of artifact.json. Read-only MSI database queries bind ProductCode, UpgradeCode, ProductName, ALLUSERS and MSIINSTALLPERUSER. Burn extraction binds the actual registration Code and PrimaryUpgradeCode, chained MSI ProductCode and extracted embedded MSI/VC bytes. Preserve the complete build directory and independently inspect actual MSI tables/architecture, full toolchain closure, logs, embedded payload and Burn manifest before authorizing installation. No real product GUIDs are allocated.

## Native test protocol (manual authorized execution)

Use a fresh snapshot for each scope and runtime state; record OS/SKU/build/UBR, VM/snapshot label, source identity, actual artifact SHA256, disconnected network evidence, non-elevated original user, UAC observations, real Burn/MSI logs, exit/reboot status and actual cache/ACL. The same EXE must be used across both target systems. Do not invoke Win32_Product. Do not delete shared DLLs or uninstall shared VC on a host. Inspect logs locally and sanitize before sharing.

For each successful lifecycle collect eight read-only JSON observations in order A/B baseline, A/B installed, A/B repaired, A/B removed. Same fresh random RunId, same artifact.json and bundle bytes. Each actual account runs the observer non-elevated:

```powershell
$approved = Get-Content -LiteralPath C:\isolated\approved-inputs.json -Raw | ConvertFrom-Json
.\Get-PocState.ps1 -RunId 'a81cb8a7-30c2-4e04-a049-aeb8831ce10e' -Phase baseline -ArtifactPath C:\isolated\poc-build-1\artifact.json -BundlePath C:\isolated\poc-build-1\RedacteraInstallerPoC-Setup.exe -ExpectedHelperSha256 $approved.sourceHashes.'PocNative.ps1'
```

The observer checks exact compiled ProductCode and Burn registration Code, matching related MSI and Burn family registrations (including hidden/name-changed entries), both registry views, actual MsiEnumProductsEx contexts, marker bytes and x64 runtime registration. It does not enumerate other users from A or expose raw SIDs, personal paths or names. The RunId-salted account token is not an attestation. Independently verify account privilege/host/snapshot, cache paths, ACL and real VC load; exact receipts do not prove all these facts. Capture cancelled observations and real logs separately; the eight-receipt checker is for successful lifecycles only.

| Case | Action and mandatory evidence |
| --- | --- |
| 01-A | Compatible runtime, A chooses current user: no UAC, A-only marker/registration/context, correct maintenance entry, B unaffected. |
| 01-B | Missing/old x64 runtime, A chooses current user, B authorizes prerequisite: exact bundled runtime, no network, A remains installation owner; B user profile unchanged. |
| 01-C | A requests machine install, B authorizes: machine Program Files, machine registration visible to both, no personal marker; A cannot modify installed payload. |
| 01-D | Existing equal/newer VC skipped, no downgrade; x86-only, missing/invalid registry values, minimum boundary, real x64 /MD load probe. |
| 01-E | Refuse UAC separately for prerequisite and machine scope; cancel during detect/plan/apply. No false success; actual final state/logs. |
| 01-F | Repair original scope after removing only the synthetic marker in an authorized isolated snapshot; no scope conversion, restored bytes, real maintenance/cache; corrupt/missing cache negative control. |
| 01-G | Uninstall from original maintenance entry; exact identity and all hidden remnants absent, shared VC retained, other account unchanged. |
| 01-H | Actual prerequisite/MSI failure, rollback, restart 3010/1641 in separately authorized snapshot; B cannot take over A's resume. Do not simulate exit code and claim native evidence. |
| 01-I | Hidden bundle, wrong product/bundle ID, extra family registration, marker only in wrong registry view, invalid relative/drive-relative/UNC path, reparse ancestor, existing output, wrong input bytes, same-ID duplicate machine views. Independently verify these negative controls and true ACL. |
| 01-J | In a separate authorized disposable snapshot, copy the verified source, change only the helper to a harmless Write-Output marker, retain the original approved hash, and check that the trusted external preflight rejects it. For the internal gate negative control only, invoke each trusted entry point with the original expected hash and synthetic absolute input arguments; it must stop before loading the helper, emitting no marker, and performing no installation or build. Restore verified source before any real experiment. Do not run a modified helper directly. |

For the successful lifecycles only, run the checker with the preserved build directory and independently approved input manifest:

```sh
python verify_observations.py --artifact poc-build-1/artifact.json --approved-inputs approved-inputs.json --scope user A-base.json B-base.json A-install.json B-install.json A-repair.json B-repair.json A-remove.json B-remove.json
```

It rejects missing/extra/duplicate JSON fields, invalid types, wrong v14 versions, mismatched source/approved hashes, altered MSI/EXE/VC/manifest/ICE logs or extracted payload bytes, mismatched receipt artifact hash, wrong IDs/context, hidden/extra/residual registrations and invalid scope. Exit 0 means observations-consistent only, always `nativeAcceptance=false`. It does not independently re-extract the EXE, verify signatures, prove log authenticity, confirm native execution or replace real UAC/cache/ACL/restart/rollback evidence. Actual build/ICE/observer/Windows tests remain required. No manufacturing receipts or changing policy to pass.

## Portable developer tests and follow-on

```sh
cd experiments/windows-installer-poc
python -m unittest -v test_poc.py
```

These tests parse authored XML, exercise strict receipt and artifact-byte contracts with synthetic inputs, and check explicit native-source gates. They do not execute PowerShell, C# P/Invoke, MSI validation, or compile/install WiX. Actual use requires independent review, license/tooling approval and authorized Windows snapshots. If the native engine cannot establish safe original-user identity, scope and recovery, stop and report the evidence; do not build a high-privilege replacement. Only after PoC-01 succeeds, proceed to WPF BA and Squirrel migration/DPAPI, preserving actual product identities. No automatic cross-scope conversion, delta updates or production integration here.

References: [WiX configurable scope](https://docs.firegiant.com/wix/whatsnew/configurable_scope_bundles/), [MSI dual-purpose authoring](https://learn.microsoft.com/en-us/windows/win32/msi/single-package-authoring), [WiX validation](https://docs.firegiant.com/wix/tools/validation/), [WiX CLI](https://docs.firegiant.com/wix/tools/wixexe/), [MsiEnumProductsEx](https://learn.microsoft.com/en-us/windows/win32/api/msi/nf-msi-msienumproductsexw), [VC redistribution](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files), [OSMF](https://docs.firegiant.com/wix/osmf/). These are references, not native acceptance or license authorization.
