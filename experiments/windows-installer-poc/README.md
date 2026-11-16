# Windows installer candidate experiment (not a release)

This isolated PoC tests WiX v7 Burn + a single dual-purpose x64 MSI with a synthetic marker only. It is not a technical selection, not a release package, and not integrated into Electron Forge, application code, package scripts or CI. Do not install on a real workstation, use any actual application data or ship the bundle. Use authorized disposable Windows 11 and Windows 10 22H2 x64 snapshots with synthetic standard user A and separate admin B. Keep existing shared runtimes on host machines unchanged.

## Source and build

- `Package.wxs`: distinct synthetic identities, default per-user, Windows Installer folder/registry redirection, embedded cabinet. No actual Redactera settings, registry, shortcuts, DPAPI, migrations, services, custom actions, or recursive cleanup. The test intentionally uses only default directories; it does not solve custom path/ACL validation or scope conversion.
- `Bundle.wxs`: native stock WixStdBA for the scope test, embedded official x64 VC redistributable then MSI. A machine prerequisite is permanent and vital. Detect uses the x64 registry Installed value and version threshold. Nonzero codes other than explicit reboot statuses fail, including 1638; never assume a competing install means success. The native x64 Windows client gate is for this experiment, not a new production support policy. No remote payloads.
- `Build-Poc.ps1`: explicit approved offline inputs only. The operator must first establish WiX/extension fees, licenses, toolchain integrity and Microsoft redistribution rights; no auto-acceptance or downloads. Provide locally provisioned WiX v7 + matching Bal/Util extension DLLs, Microsoft x64 redist and hashes in a local JSON with keys `wix`, `bal`, `util`, `vcRedist` (each object has absolute `path` and `sha256`), `wixVersion` (exact CLI output), `minimumVcVersion` (four numeric fields, established by the native test). Hash checks here cover the named inputs; the complete SDK/toolchain and its dependencies must separately be pinned. Verify the redist really is x64 and has an adequate version before approving the manifest. No placeholder lock, no real binary in Git. Build as non-elevated native Windows x64:
  
  ```powershell
  .\Build-Poc.ps1 -InputsJson C:\isolated\approved-inputs.json -OutputDirectory C:\isolated\poc-build-1 -ApprovedOfflineInputs
  ```
  
  Use a fresh absolute output directory. The build stages both source files and marker beside the approved prerequisite, binds from that directory, and verifies staged input hashes before and after building. Build one artifact set and preserve its hashes across all snapshots. Require actual MSI validation (including ICE105), inspect Property/Directory/Registry tables for the intended scope and payload, inspect Burn chain and attachment; do not suppress failed validation. The script does not run either installer. No production installer identity is allocated here.

## Native test protocol (manual authorized execution)

Use a fresh snapshot for each scope and runtime state. Record Windows SKU, build, patch, VM/snapshot label, source commit/tree, actual artifact manifest, disconnected network evidence, original non-elevated login, UAC observations, Burn/MSI logs, exit/reboot status. Retain raw logs locally and sanitize before sharing. Do not invoke `Win32_Product` (can trigger MSI consistency checks). Do not delete system DLLs or uninstall a shared runtime on a host. Use a licensed, isolated clean snapshot instead.

For each scope, take eight read-only JSON observations, in order A/B baseline, A/B installed, A/B repaired, A/B removed. Use the same fresh randomly chosen RunId for both logins and all phases, same bundle bytes. From each non-elevated login run (substitute the actual GUID and phase):

```powershell
.\Get-PocState.ps1 -RunId 'a81cb8a7-30c2-4e04-a049-aeb8831ce10e' -Phase baseline -BundlePath C:\isolated\poc-build-1\RedacteraInstallerPoC-Setup.exe
```

Redirect output to an isolated local JSON file if desired. No raw SID, paths or names emitted in successful JSON; the account token is salted by RunId for comparison within a run only. Each observation checks the expected default marker location, exact marker registry value, visible bundle and hidden/registered MSI in the current user's and machine's uninstall registry views, plus x64 VC registration. It is not a full MSI enumeration, ACL audit, or actual runtime load test. The script can fail instead of interpreting access errors as absence. Do not collect A's snapshot as B. Record stock BA scope and actual UAC behavior separately.

| Case | Action and mandatory evidence |
| --- | --- |
| 01-A | Compatible runtime, A chooses current user, B never supplies credentials: no elevation, A-only marker and registration; B has no user install; correct maintenance entry. |
| 01-B | Missing or old x64 runtime, A chooses current user, B authorizes prerequisite only: exact bundled runtime installed, no network, marker still belongs to A; B user profile unchanged. |
| 01-C | Machine installation requested by A, B authorizes: marker under machine Program Files, machine registration visible to both, no per-user marker. Verify normal A cannot modify installed payload; do not change ACL to make test pass. |
| 01-D | Already newer compatible runtime: skipped, no downgrade or redundant execution, verify real chain logs. Test x86-only baseline separately; it must not satisfy x64 requirement. |
| 01-E | A refuses UAC (prerequisite and machine scope separately); cancel during detection/plan/apply as applicable: no falsely successful marker/registration. Use cancelled observations and logs; the checker below is only for successful lifecycles. |
| 01-F | Repair from original scope after deleting ONLY the synthetic marker in the isolated test snapshot (for machine case use explicitly authorized operator); check restored bytes, no changed scope, actual MSI maintenance. |
| 01-G | Uninstall from original scope using normal bundle maintenance entry: remove owned marker/registration, never remove shared VC runtime; B remains unaffected. |
| 01-H | Force prerequisite failure/restart and MSI failure in separately authorized isolated experiments; no successful final receipt, rollback and actual restart disposition. Do not relabel a substitute or simulated failure as real chain evidence. |

For successful lifecycles only, check narrow observation consistency (same native host metadata/run/setup, two distinct login tokens, scope, exact payload, registration counts, preserved VC version):

```sh
python verify_observations.py --artifact artifact.json --scope user A-base.json B-base.json A-install.json B-install.json A-repair.json B-repair.json A-remove.json B-remove.json
```

Exit 0 means only that those observations are consistent; it explicitly returns nativeAcceptance=false. It does not prove UAC, offline operation, ACL, restart, true VC load, or logs. A failed/partial/native-unavailable test is evidence insufficient, not accepted. Use separate run IDs for machine and user lifecycles and every snapshot. Do not manufacture receipts.

## Portable developer tests and follow-on

```sh
cd experiments/windows-installer-poc
python -m unittest -v test_poc.py
```

These test actual authored XML structure and the receipt checker using synthetic data. They do not compile WiX or execute PowerShell. Only after real PoC-01 evidence and independent review, implement custom WPF BA against the selected engine and then migration/recovery with actual old application identities and DPAPI. No automatic cross-scope conversion, no delta updates, no formal product integration. Stop on unapproved tool cost/license, failed native engine gates, or inability to establish rollback and user identity. All product acceptance remains outside this experiment.

Upstream implementation references: [WiX configurable scope](https://docs.firegiant.com/wix/whatsnew/configurable_scope_bundles/), [Microsoft dual-purpose authoring](https://learn.microsoft.com/en-us/windows/win32/msi/single-package-authoring), [VC redistributable detection and distribution](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files), [WiX command line](https://docs.firegiant.com/wix/tools/wixexe/), [WiX maintenance fee](https://docs.firegiant.com/wix/whatsnew/). These are authoring references, not proof of native operation or license approval.
