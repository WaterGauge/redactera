"""Real yauzl/extract-zip contract controls; not native installer acceptance."""
import json
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import warnings
import zipfile
import zlib

import pytest


ROOT = Path(__file__).resolve().parents[2]


def entry(name, data=b'file', creator=0, attributes=32, extra=b''):
    info = zipfile.ZipInfo(name)
    info.create_system = creator
    info.external_attr = attributes
    info.extra = extra
    return info, data


def unicode_path(name, replacement, crc=None):
    raw = replacement.encode('utf-8')
    return struct.pack('<HHBI', 0x7075, 5 + len(raw), 1,
                       zlib.crc32(name.encode('ascii')) if crc is None else crc) + raw


def archive(tmp_path, entries):
    result = tmp_path / 'fixture.zip'
    with warnings.catch_warnings(), zipfile.ZipFile(result, 'w') as output:
        warnings.simplefilter('ignore', UserWarning)
        for info, data in entries:
            output.writestr(info, data)
    return result


def check(tmp_path, entries, accepted=False, options=None):
    node = shutil.which('node')
    if node is None:
        pytest.skip('Node unavailable')
    fixture = archive(tmp_path, entries)
    output = tmp_path / 'output'
    # Exercise the same production preflight AND extraction path; a negative
    # must fail before extract-zip even creates the destination directory.
    script = r'''
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [file, archive, output, rawOptions, accepted] = process.argv.slice(1);
const verifier = require(file);
const bytes = fs.readFileSync(archive);
const options = JSON.parse(rawOptions);
(async () => {
  if (accepted === 'true') {
    const count = await verifier.extractCheckedZip(archive, output, bytes, options);
    if (options.fullPackage) assert.equal(await verifier.verifyFullPackageEntries(bytes), count);
    console.log(count);
  } else {
    await assert.rejects(() => verifier.extractCheckedZip(archive, output, bytes, options));
    assert.equal(fs.existsSync(output), false);
    if (options.fullPackage) await assert.rejects(() => verifier.verifyFullPackageEntries(bytes));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
'''
    result = subprocess.run([node, '-e', script, str(ROOT / 'scripts/verify-windows-release.cjs'),
                             str(fixture), str(output), json.dumps(options or {'fullPackage': True}),
                             str(accepted).lower()], cwd=ROOT, check=True, capture_output=True, text=True, timeout=20)
    if accepted:
        assert int(result.stdout.strip()) == len(entries)
        for info, data in entries:
            target = output / info.filename
            if info.filename.endswith('/'):
                assert target.is_dir()
            else:
                assert target.is_file() and target.read_bytes() == data
    else:
        assert not output.exists()


BASE = [entry('_rels/.rels'), entry('lib/net45/a.dll')]


def test_valid_actual_extract_with_explicit_parent_and_unicode(tmp_path):
    check(tmp_path, BASE + [entry('lib/net45/', b'', attributes=16),
                           entry('lib/net45/locales/简体.pak'),
                           entry('lib/net45/empty/', b'', creator=3, attributes=(stat.S_IFDIR | 0o755) << 16),
                           entry('lib/net45/unix.dll', creator=3, attributes=(stat.S_IFREG | 0o644) << 16)], True)


@pytest.mark.parametrize('creator', [0, 3, 10, 19])
def test_rejects_link_mode_for_every_creator(tmp_path, creator):
    check(tmp_path, BASE + [entry('lib/net45/b.dll', b'a.dll', creator=creator, attributes=(stat.S_IFLNK | 0o777) << 16)])


@pytest.mark.parametrize('attributes,data', [(16, b'data'), (16, b''), (0x30, b'data'), ((stat.S_IFDIR | 0o755) << 16, b'')])
def test_rejects_directory_without_slash(tmp_path, attributes, data):
    check(tmp_path, BASE + [entry('lib/net45/b.dll', data, attributes=attributes)])


@pytest.mark.parametrize('replacement,crc', [('lib/net45/a.dll', None), ('lib/net45/other.dll', None),
                                           ('lib/net45/b.dll', None), ('lib/net45/a.dll', 0)])
def test_rejects_unicode_path_override_even_if_identity_or_crc_invalid(tmp_path, replacement, crc):
    name = 'lib/net45/b.dll'
    check(tmp_path, BASE + [entry(name, extra=unicode_path(name, replacement, crc))])


@pytest.mark.parametrize('name,attributes,data', [
    ('lib/net45/dir/', 16, b'nonempty'),
    ('lib/net45/dir/', (stat.S_IFREG | 0o644) << 16, b''),
    ('lib/net45/fifo', (stat.S_IFIFO | 0o644) << 16, b''),
    ('lib/net45/a.dll', 32, b'duplicate'),
    ('lib/net45/A.dll', 32, b'alias'),
    ('lib/NET45/b.dll', 32, b'parent alias'),
    ('lib/net45/a.dll/child', 32, b'conflict'),
    ('lib/net45/../outside', 32, b'unsafe'),
    ('lib/net45/bad\\name', 32, b'unsafe'),
    ('lib/net45/CON.dll', 32, b'unsafe'),
    ('lib/net45/bad.', 32, b'unsafe'),
    ('lib/net45/bad//name', 32, b'unsafe'),
    ('/absolute.dll', 32, b'unsafe'),
    ('lib/net45/del\x7f.dll', 32, b'unsafe'),
    ('__MACOSX/hidden', 32, b'skipped by extractor'),
    ('_rels/.rels', 32, b'duplicate relationship'),
])
def test_rejects_inconsistent_or_ambiguous_raw_entries(tmp_path, name, attributes, data):
    check(tmp_path, BASE + [entry(name, data, attributes=attributes)])


def test_requires_relationship_entry(tmp_path):
    check(tmp_path, [entry('lib/net45/a.dll')])


OUTER = ['RELEASES', 'Update.exe', 'background.gif', 'synthetic-full.nupkg', 'setupIcon.ico']


def test_outer_exact_entries_actual_extract(tmp_path):
    check(tmp_path, [entry(name) for name in OUTER], True, {'expectedNames': OUTER})


@pytest.mark.parametrize('variant', ['extra', 'missing', 'unicode', 'link', 'directory'])
def test_outer_checks_before_extraction(tmp_path, variant):
    entries = [entry(name) for name in OUTER]
    if variant == 'extra':
        entries.append(entry('unexpected'))
    elif variant == 'missing':
        entries.pop()
    elif variant == 'unicode':
        entries[-1] = entry(OUTER[-1], extra=unicode_path(OUTER[-1], 'Update.exe'))
    elif variant == 'link':
        entries[-1] = entry(OUTER[-1], b'Update.exe', attributes=(stat.S_IFLNK | 0o777) << 16)
    else:
        entries[-1] = entry(OUTER[-1], attributes=16)
    check(tmp_path, entries, options={'expectedNames': OUTER})
