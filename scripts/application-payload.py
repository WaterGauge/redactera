"""Local, unsigned build receipt for the common Windows application payload.

Only ordinary files/default data streams and directories are included. The
build and receipt directories must be controlled and quiescent; this is not a
signature, an ACL/ADS audit, or protection from a malicious concurrent writer.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


MAX_JSON = 16 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def plain(path, directory):
    info = path.lstat()
    require(not (stat.S_ISLNK(info.st_mode) or
                 getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT),
            'Application payload contains a link or reparse point')
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink <= 1,
            'Application payload requires ordinary files and directories')
    return info


def identity(info):
    # Windows lstat adds execute bits based on the filename suffix; fstat does
    # not. Compare file type and identity, not these synthetic mode bits.
    return (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode), info.st_nlink, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, getattr(info, 'st_file_attributes', 0))


def ordinary_directory(path):
    # Check ancestors before descending, including Windows junctions.
    for parent in (*reversed(path.parents), path):
        plain(parent, True)


def file_value(path, capture=False):
    before = plain(path, False)
    if capture:
        require(before.st_size <= MAX_JSON, 'Application payload JSON is too large')
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    with os.fdopen(os.open(path, flags), 'rb') as stream:
        require(identity(os.fstat(stream.fileno())) == identity(before), 'Application payload changed during verification')
        data = stream.read(MAX_JSON + 1) if capture else None
        if capture:
            require(len(data) <= MAX_JSON and len(data) == before.st_size, 'Application payload JSON changed or is too large')
        sha = digest(data) if capture else hashlib.file_digest(stream, 'sha256').hexdigest()
        require(identity(os.fstat(stream.fileno())) == identity(before), 'Application payload changed during verification')
    require(identity(plain(path, False)) == identity(before), 'Application payload changed during verification')
    return before.st_size, sha, data


def portable_name(name):
    name.encode('utf-8', 'strict')
    require(not re.search(r'[\x00-\x1f<>:"/\\|?*]', name) and not name.endswith((' ', '.'))
            and not re.fullmatch(r'(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])',
                                 name.split('.')[0].rstrip(' ').upper()), 'Invalid Windows application payload path')
    return name.casefold()


def snapshot(root):
    ordinary_directory(root)
    files = {}
    directories = []

    def walk(directory, relative):
        before = plain(directory, True)
        names = sorted(os.listdir(directory))
        aliases = set()
        for name in names:
            alias = portable_name(name)
            require(alias not in aliases, 'Case-colliding Windows application payload paths')
            aliases.add(alias)
            entry = directory / name
            key = relative + name
            info = entry.lstat()
            if stat.S_ISDIR(info.st_mode):
                directories.append(key)
                walk(entry, key + '/')
            else:
                size, sha, _ = file_value(entry)
                files[key] = {'size': size, 'sha256': sha}
        require(sorted(os.listdir(directory)) == names and identity(plain(directory, True)) == identity(before),
                'Application payload directory changed during verification')

    walk(root, '')
    require(bool(files), 'Application payload is empty')
    return {'directories': sorted(directories), 'files': files}


def checked_identity(proof):
    require(isinstance(proof, dict) and set(proof) == {'appBuild', 'asarSha256', 'backendSha256', 'pythonLicensesSha256', 'sourceCommit'},
            'Invalid application payload evidence')
    build = proof['appBuild']
    require(isinstance(build, dict) and set(build) == {'schema', 'buildId', 'flavor', 'applicationSourceSha256', 'contract', 'backendSha256'}
            and build['schema'] == 2 and build['flavor'] == 'normal'
            and isinstance(build['buildId'], str) and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', build['buildId']),
            'Invalid normal application build identity')
    contract = build['contract']
    require(isinstance(contract, dict) and set(contract) == {'protocol', 'appVersion', 'sourceSha256'}
            and contract['protocol'] == 1 and isinstance(contract['appVersion'], str) and bool(contract['appVersion']),
            'Invalid backend contract')
    for value in (build['applicationSourceSha256'], build['backendSha256'], contract['sourceSha256'],
                  proof['asarSha256'], proof['backendSha256'], proof['pythonLicensesSha256']):
        require(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value), 'Invalid application payload SHA256')
    require(build['backendSha256'] == proof['backendSha256'], 'Inconsistent application backend identity')
    commit = proof['sourceCommit']
    require(commit is None or isinstance(commit, str) and re.fullmatch(r'[a-f0-9]{40}', commit), 'Invalid release source commit')
    return build


def squirrel_payload_files(common, packaged):
    # electron-winstaller's pinned template omits these Forge-root-only files.
    # Chromium's notice must still be present byte-for-byte inside resources.
    omitted = {'build-evidence.json', 'version', 'LICENSES.chromium.html'}
    expected = {name: value for name, value in common.items() if name not in omitted}
    if 'LICENSES.chromium.html' in common:
        require(expected.get('resources/third-party-licenses/electron/LICENSES.chromium.html') ==
                common['LICENSES.chromium.html'], 'Chromium license copy differs from the common payload')
    # The maker adds the verified updater and execution stub; their own
    # identity/icon checks remain in verify-windows-release.cjs.
    extras = {'squirrel.exe', 'redactera_executionstub.exe'}
    folded = {name.casefold(): (name, value) for name, value in packaged.items()}
    require(len(folded) == len(packaged), 'Case-colliding embedded application files')
    require(not extras.intersection(name.casefold() for name in expected), 'Unexpected installer-only file in common application')
    require(set(folded) == {name.casefold() for name in expected} | extras,
            'Installer embedded file set differs from the common application')
    for name, value in expected.items():
        actual_name, actual = folded[name.casefold()]
        require(actual_name == name and actual == value, 'Installer embeds a different application file: ' + name)
    for name in extras:
        require(folded[name][1]['size'] > 0, 'Empty installer-only application file')
    return {name: value['sha256'] for name, value in sorted(packaged.items())}


def receipt(project, output, proof, mode, embedded=None):
    build = checked_identity(proof)
    require(mode in ('seal', 'verify', 'verify-squirrel') and (embedded is not None) == (mode == 'verify-squirrel'),
            'Invalid application payload mode')
    ordinary_directory(project)
    # No receipt is allowed inside the payload, even when using a custom output directory.
    state = project / '.project-state' / 'application-payload'
    require(output != state and output not in state.parents and state not in output.parents,
            'Application payload and receipt directories must be separate')
    content = snapshot(output)
    files = content['files']
    for name, expected in (('resources/app.asar', proof['asarSha256']),
                           ('resources/dist/python_backend.exe', proof['backendSha256']),
                           ('resources/dist/python-licenses.zip', proof['pythonLicensesSha256'])):
        require(files.get(name, {}).get('sha256') == expected, 'Application payload differs from verified package: ' + name)
    for name in ('Redactera.exe', 'resources/dist/backend-manifest.json', 'resources/LICENSE', 'resources/icon.ico'):
        require(files.get(name, {}).get('size', 0) > 0, 'Required application payload file missing: ' + name)
    for name in ('resources/app-build.json', 'build-evidence.json'):
        require(name in files, 'Missing application build evidence: ' + name)
        size, sha, data = file_value(output / name, True)
        require(files[name] == {'size': size, 'sha256': sha}, 'Application build evidence changed during verification')
        value = json.loads(data)
        if name == 'resources/app-build.json':
            require(value == build, 'Application build identity changed')
        else:
            require(isinstance(value, dict) and all(value.get(key) == proof[key] for key in
                    ('appBuild', 'asarSha256', 'backendSha256', 'pythonLicensesSha256')) and
                    'binary' not in value and 'resources' not in value, 'Application package evidence changed')
    result = {'schema': 1, 'platform': 'win32', 'arch': 'x64', **proof,
              'payloadSha256': digest(canonical(content)), 'payload': content}
    raw = canonical(result)
    require(len(raw) < MAX_JSON, 'Application payload receipt is too large')
    if mode == 'seal':
        for directory in (state.parent, state):
            directory.mkdir(exist_ok=True)
            plain(directory, True)
        with (state / (build['buildId'] + '.json')).open('xb') as stream:
            stream.write(raw)
            stream.write(b'\n')
    else:
        ordinary_directory(state)
        _, _, saved = file_value(state / (build['buildId'] + '.json'), True)
        require(saved == raw + b'\n', 'Application payload receipt differs from the verified build; rebuild the application')
    summary = {'payloadSha256': result['payloadSha256'], 'files': len(files), 'directories': len(content['directories'])}
    if mode == 'verify-squirrel':
        summary['embeddedFiles'] = squirrel_payload_files(files, snapshot(embedded)['files'])
    return summary


if __name__ == '__main__':
    if len(sys.argv) not in (4, 5):
        raise SystemExit('Usage: application-payload.py seal|verify|verify-squirrel PROJECT OUTPUT [EMBEDDED] (package evidence JSON on stdin)')
    # Resolve neither path through links; the scanner rejects reparse points.
    root, output = (Path(os.path.abspath(value)) for value in sys.argv[2:4])
    embedded = Path(os.path.abspath(sys.argv[4])) if len(sys.argv) == 5 else None
    print(json.dumps(receipt(root, output, json.load(sys.stdin), sys.argv[1], embedded)))
