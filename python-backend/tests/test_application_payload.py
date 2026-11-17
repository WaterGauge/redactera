"""Portable application-payload contract controls, not native installer acceptance."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('application_payload', ROOT / 'scripts/application-payload.py')
assert SPEC and SPEC.loader
payload = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(payload)


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def build(tmp_path):
    project = tmp_path.resolve()
    output = project / 'out' / 'Redactera-win32-x64'
    asar = write(output / 'resources/app.asar', b'asar')
    backend = write(output / 'resources/dist/python_backend.exe', b'backend')
    licenses = write(output / 'resources/dist/python-licenses.zip', b'licenses')
    for name in ('Redactera.exe', 'resources/dist/backend-manifest.json', 'resources/LICENSE',
                 'resources/icon.ico', 'unlisted.dll', 'locales/zh-CN.pak', 'resources/third-party-licenses/test/LICENSE'):
        write(output / name, name.encode())
    (output / 'empty').mkdir()
    app = {'schema': 2, 'buildId': '12345678-1234-4123-8123-123456789abc', 'flavor': 'normal',
           'applicationSourceSha256': 'a' * 64, 'contract': {'protocol': 1, 'appVersion': '2.0.0', 'sourceSha256': 'b' * 64},
           'backendSha256': backend}
    proof = {'appBuild': app, 'asarSha256': asar, 'backendSha256': backend, 'pythonLicensesSha256': licenses,
             'sourceCommit': None}
    write(output / 'resources/app-build.json', json.dumps(app).encode())
    write(output / 'build-evidence.json', json.dumps({k: v for k, v in proof.items() if k != 'sourceCommit'}).encode())
    saved = project / '.project-state/application-payload' / (app['buildId'] + '.json')
    return project, output, proof, saved


def run(build, mode):
    return payload.receipt(*build[:3], mode)


def test_receipt_is_external_deterministic_and_covers_every_file(build):
    project, output, _, saved = build
    result = run(build, 'seal')
    document = json.loads(saved.read_bytes())
    assert result == run(build, 'verify')
    assert result['payloadSha256'] == hashlib.sha256(payload.canonical(document['payload'])).hexdigest()
    assert document['payload']['files']['unlisted.dll']['sha256'] == hashlib.sha256(b'unlisted.dll').hexdigest()
    assert document['payload']['directories'] == sorted(document['payload']['directories'])
    assert 'empty' in document['payload']['directories']
    assert result['files'] == len(list(p for p in output.rglob('*') if p.is_file()))
    assert str(project) not in saved.read_text()
    assert not (output / saved.name).exists()
    os.utime(output / 'unlisted.dll', None)
    assert run(build, 'verify') == result
    with pytest.raises(FileExistsError):
        run(build, 'seal')


@pytest.mark.parametrize('name', ['resources/app.asar', 'resources/dist/python_backend.exe',
                                  'resources/dist/python-licenses.zip', 'unlisted.dll', 'locales/zh-CN.pak',
                                  'resources/third-party-licenses/test/LICENSE', 'Redactera.exe', 'resources/dist/backend-manifest.json'])
def test_changed_bytes_rejected(build, name):
    run(build, 'seal')
    target = build[1] / name
    data = target.read_bytes()
    target.write_bytes(bytes([data[0] ^ 1]) + data[1:])
    with pytest.raises(RuntimeError, match='differs'):
        run(build, 'verify')


@pytest.mark.parametrize('change', ['added-file', 'removed-file', 'empty-directory', 'rename-file'])
def test_changed_tree_rejected(build, change):
    run(build, 'seal')
    output = build[1]
    if change == 'added-file':
        write(output / 'new.dll', b'new')
    elif change == 'removed-file':
        (output / 'unlisted.dll').unlink()
    elif change == 'empty-directory':
        (output / 'empty').rmdir()
    else:
        (output / 'unlisted.dll').rename(output / 'renamed.dll')
    with pytest.raises(RuntimeError, match='receipt differs'):
        run(build, 'verify')


def test_missing_or_changed_receipt_never_regenerated(build):
    with pytest.raises(FileNotFoundError):
        run(build, 'verify')
    run(build, 'seal')
    saved = build[3]
    saved.write_bytes(saved.read_bytes() + b' ')
    with pytest.raises(RuntimeError, match='receipt differs'):
        run(build, 'verify')
    saved.unlink()
    with pytest.raises(FileNotFoundError):
        run(build, 'verify')
    assert not saved.exists()


@pytest.mark.parametrize('field,value', [('flavor', 'e2e'), ('buildId', '../outside'), ('schema', 1)])
def test_invalid_build_rejected_before_receipt_write(build, field, value):
    build[2]['appBuild'][field] = value
    with pytest.raises(RuntimeError, match='build identity'):
        run(build, 'seal')
    assert not build[3].exists()


def test_release_commit_bound_to_receipt(build):
    build[2]['sourceCommit'] = 'c' * 40
    run(build, 'seal')
    build[2]['sourceCommit'] = 'd' * 40
    with pytest.raises(RuntimeError, match='receipt differs'):
        run(build, 'verify')


def test_actual_package_evidence_must_match_verified_input(build):
    write(build[1] / 'resources/app-build.json', b'{}')
    with pytest.raises(RuntimeError, match='identity changed'):
        run(build, 'seal')
    write(build[1] / 'resources/app-build.json', json.dumps(build[2]['appBuild']).encode())
    write(build[1] / 'build-evidence.json', b'{}')
    with pytest.raises(RuntimeError, match='evidence changed'):
        run(build, 'seal')


def test_receipt_rejects_private_build_paths(build):
    p = build[1] / 'build-evidence.json'
    raw = json.loads(p.read_text())
    raw['binary'] = str(build[1] / 'Redactera.exe')
    p.write_text(json.dumps(raw))
    with pytest.raises(RuntimeError, match='evidence changed'):
        run(build, 'seal')


@pytest.mark.parametrize('name', ['CON', 'nul.txt', 'COM1.dll', 'LPT².txt', 'a:b', 'a\\b', 'bad.', 'bad ', 'a?b'])
def test_invalid_windows_path_names(name):
    with pytest.raises(RuntimeError, match='Invalid Windows'):
        payload.portable_name(name)


def test_case_aliases_rejected_where_filesystem_permits(build):
    output = build[1]
    first, second = output / 'Case.dll', output / 'case.dll'
    first.write_bytes(b'a')
    if second.exists():
        pytest.skip('case-insensitive filesystem prevents creating alias')
    second.write_bytes(b'b')
    with pytest.raises(RuntimeError, match='Case-colliding'):
        run(build, 'seal')


def test_hardlink_rejected(build):
    try:
        os.link(build[1] / 'unlisted.dll', build[1] / 'duplicate.dll')
    except OSError:
        pytest.skip('filesystem does not permit hardlinks')
    with pytest.raises(RuntimeError, match='ordinary files'):
        run(build, 'seal')


@pytest.mark.parametrize('location', ['file', 'directory', 'receipt'])
def test_links_rejected_when_supported(build, location):
    project, output, _, saved = build
    outside = project / 'outside'; outside.mkdir()
    (outside / 'data').write_bytes(b'outside')
    if location == 'receipt':
        run(build, 'seal')
        saved.unlink()
        link, target = saved, outside / 'data'
    elif location == 'directory':
        link, target = output / 'linked-directory', outside
    else:
        link, target = output / 'linked-file', outside / 'data'
    try:
        link.symlink_to(target, target_is_directory=target.is_dir())
    except OSError:
        pytest.skip('filesystem or privileges do not permit symlinks')
    with pytest.raises(RuntimeError, match='link or reparse'):
        run(build, 'verify' if location == 'receipt' else 'seal')
    assert (outside / 'data').read_bytes() == b'outside'


def test_reparse_attributes_rejected_even_if_mode_is_directory(build, monkeypatch):
    target = build[1] / 'empty'
    original = Path.lstat
    def lstat(path):
        if path == target:
            return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT)
        return original(path)
    monkeypatch.setattr(Path, 'lstat', lstat)
    with pytest.raises(RuntimeError, match='reparse point'):
        run(build, 'seal')


def test_windows_executable_mode_bits_do_not_change_handle_identity(build):
    info = (build[1] / 'Redactera.exe').lstat()
    values = {name: getattr(info, name) for name in ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')}
    values['st_file_attributes'] = getattr(info, 'st_file_attributes', 0)
    values['st_mode'] ^= 0o111
    assert payload.identity(info) == payload.identity(SimpleNamespace(**values))


def test_node_bridge_roundtrip(build):
    if shutil.which('node') is None:
        pytest.skip('Node unavailable')
    project, output, proof, saved = build
    env = {**os.environ, 'PDF_BUILD_PYTHON': sys.executable}
    env.pop('PDF_REQUIRE_RELEASE_RUNTIME', None)
    env.pop('PDF_RELEASE_SOURCE_COMMIT', None)
    script = ("const m=require(process.argv[1]);const p=JSON.parse(process.argv[4]);"
              "console.log(JSON.stringify(m.sealWindowsPayload(process.argv[2],process.argv[3],p)));"
              "console.log(JSON.stringify(m.verifyWindowsPayload(process.argv[2],process.argv[3],p)));")
    result = subprocess.run(['node', '-e', script, str(ROOT / 'scripts/application-payload.cjs'),
                             str(project), str(output), json.dumps(proof)], env=env, check=True, capture_output=True, text=True)
    a, b = map(json.loads, result.stdout.splitlines())
    assert a == b == run(build, 'verify') and saved.is_file()


def test_controlled_make_entry_reuses_only_native_normal_package():
    if shutil.which('node') is None:
        pytest.skip('Node unavailable')
    # Execute the actual entry in a VM with only the external process effects
    # replaced. This is argument/order coverage, not a Forge or native run.
    script = r'''
const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict');
const file=process.argv[1], code=fs.readFileSync(file,'utf8');
function run(args, platform='win32', arch='x64', release=false, status=0) {
  const events=[];
  const p={argv:['node',file,...args],platform,arch,execPath:'node',env:release?{PDF_REQUIRE_RELEASE_RUNTIME:'1'}:{}};
  const cp={execFileSync(){events.push('git');return 'a'.repeat(40)+'\n';},
    spawnSync(exe, argv, options){events.push(['forge',...argv.slice(1),options.env.PDF_E2E_BUILD]);return {status};}};
  const r=name=>({'node:child_process':cp,'node:path':require('node:path'),
    './build-backend.cjs':()=>events.push('backend'),'./backend-contract.cjs':{applicationSource:()=>events.push('source')}})[name];
  try {vm.runInNewContext(code,{require:r,process:p,__dirname:require('node:path').dirname(file),console:{error(){}}});}
  catch(e){return {events,error:e.message};}
  return {events,exitCode:p.exitCode};
}
assert.deepEqual(run(['make','--from-package'],'win32','x64',true).events,['git','source',['forge','make','--from-package','false']]);
assert.deepEqual(run(['make']).events,['backend',['forge','make','false']]);
assert.deepEqual(run(['package','--test-inspect']).events,['backend',['forge','package','true']]);
for(const [args,platform,arch] of [[['package','--from-package'],'win32','x64'],[['make','--from-package'],'linux','x64'],[['make','--from-package'],'win32','arm64'],[['make','--test-inspect'],'win32','x64'],[['make','--from-package','--test-inspect'],'win32','x64']]) {
 const x=run(args,platform,arch);assert.ok(x.error);assert.deepEqual(x.events,[]);
}
assert.equal(run(['make','--from-package'],'win32','x64',false,1).exitCode,1);
'''
    subprocess.run(['node', '-e', script, str(ROOT / 'scripts/build-app.cjs')], check=True)



@pytest.fixture
def squirrel(build):
    project, output, proof, _ = build
    write(output / 'LICENSES.chromium.html', b'chromium-notice')
    write(output / 'resources/third-party-licenses/electron/LICENSES.chromium.html', b'chromium-notice')
    write(output / 'version', b'45.2.1')
    run(build, 'seal')
    packaged = project / 'embedded'
    shutil.copytree(output, packaged)
    for name in ('build-evidence.json', 'version', 'LICENSES.chromium.html'):
        (packaged / name).unlink()
    write(packaged / 'squirrel.exe', b'updater')
    write(packaged / 'Redactera_ExecutionStub.exe', b'stub')
    return build, packaged


def test_complete_embedded_application_comparison(squirrel):
    build, packaged = squirrel
    result = payload.receipt(*build[:3], 'verify-squirrel', packaged)
    assert result['payloadSha256'] == run(build, 'verify')['payloadSha256']
    assert result['embeddedFiles']['unlisted.dll'] == hashlib.sha256(b'unlisted.dll').hexdigest()
    assert result['embeddedFiles']['squirrel.exe'] == hashlib.sha256(b'updater').hexdigest()
    assert len(result['embeddedFiles']) == len([x for x in packaged.rglob('*') if x.is_file()])


@pytest.mark.parametrize('name', ['unlisted.dll', 'locales/zh-CN.pak', 'resources/dist/backend-manifest.json',
                                  'resources/third-party-licenses/electron/LICENSES.chromium.html', 'squirrel.exe', 'Redactera_ExecutionStub.exe'])
def test_rejects_missing_embedded_files(squirrel, name):
    build, packaged = squirrel
    (packaged / name).unlink()
    with pytest.raises(RuntimeError, match='file set differs'):
        payload.receipt(*build[:3], 'verify-squirrel', packaged)


@pytest.mark.parametrize('name', ['unlisted.dll', 'locales/zh-CN.pak', 'resources/dist/backend-manifest.json',
                                  'resources/third-party-licenses/electron/LICENSES.chromium.html'])
def test_rejects_changed_embedded_bytes(squirrel, name):
    build, packaged = squirrel
    (packaged / name).write_bytes(b'tampered')
    with pytest.raises(RuntimeError, match='different application file'):
        payload.receipt(*build[:3], 'verify-squirrel', packaged)


@pytest.mark.parametrize('name', ['extra.dll', 'resources/unexpected.exe', 'build-evidence.json', 'version'])
def test_rejects_extra_embedded_files(squirrel, name):
    build, packaged = squirrel
    write(packaged / name, b'extra')
    with pytest.raises(RuntimeError, match='file set differs'):
        payload.receipt(*build[:3], 'verify-squirrel', packaged)


def test_chromium_notice_must_be_retained(build):
    write(build[1] / 'LICENSES.chromium.html', b'chromium-notice')
    run(build, 'seal')
    packaged = build[0] / 'embedded'; shutil.copytree(build[1], packaged)
    with pytest.raises(RuntimeError, match='Chromium license copy'):
        payload.receipt(*build[:3], 'verify-squirrel', packaged)


def test_installer_only_names_cannot_be_in_common_input(build):
    write(build[1] / 'Squirrel.exe', b'updater')
    run(build, 'seal')
    packaged = build[0] / 'embedded'; shutil.copytree(build[1], packaged)
    with pytest.raises(RuntimeError, match='installer-only file'):
        payload.receipt(*build[:3], 'verify-squirrel', packaged)


def check_zip(tmp_path, names, special=False):
    import zipfile
    import warnings
    if shutil.which('node') is None:
        pytest.skip('Node unavailable')
    archive = tmp_path / 'full.nupkg'
    with warnings.catch_warnings(), zipfile.ZipFile(archive, 'w') as output:
        warnings.simplefilter('ignore', UserWarning)
        for name in names:
            output.writestr(name, b'' if name.endswith('/') else b'synthetic')
        if special:
            info = zipfile.ZipInfo('lib/net45/linked.dll')
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            output.writestr(info, 'outside')
    script = ("const fs=require('node:fs');require(process.argv[1]).verifyFullPackageEntries(fs.readFileSync(process.argv[2]))"
              ".then(n=>console.log(n)).catch(e=>{console.error(e.message);process.exitCode=1;});")
    return subprocess.run(['node', '-e', script, str(ROOT / 'scripts/verify-windows-release.cjs'), str(archive)],
                          capture_output=True, text=True)


def test_raw_zip_valid_paths_and_explicit_parent(tmp_path):
    result = check_zip(tmp_path, ['_rels/.rels', 'lib/net45/Redactera.exe', 'lib/net45/', 'lib/net45/locales/简体.pak'])
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == '4'


@pytest.mark.parametrize('names', [
    ['_rels/.rels', '_rels/.rels'],
    ['_rels/.rels', 'lib/net45/file.dll', 'lib/net45/file.dll'],
    ['_rels/.rels', 'lib/net45/file.dll', 'lib/net45/FILE.dll'],
    ['_rels/.rels', 'lib/net45/file.dll', 'lib/NET45/other.dll'],
    ['_rels/.rels', 'lib/net45/file', 'lib/net45/file/child.dll'],
    ['_rels/.rels', 'lib/net45/../outside'],
    ['_rels/.rels', 'lib/net45/bad\\name.dll'],
    ['_rels/.rels', 'lib/net45/CON.dll'],
    ['_rels/.rels', 'lib/net45/bad.'],
    ['_rels/.rels', 'lib/net45/bad//name'],
    ['_rels/.rels', '/absolute.dll'],
    ['lib/net45/Redactera.exe'],
])
def test_raw_zip_rejects_conflicting_or_invalid_entries(tmp_path, names):
    result = check_zip(tmp_path, names)
    assert result.returncode == 1
    assert 'Windows full package' in result.stderr


def test_raw_zip_rejects_symlink(tmp_path):
    result = check_zip(tmp_path, ['_rels/.rels'], special=True)
    assert result.returncode == 1
    assert 'non-regular entry' in result.stderr
