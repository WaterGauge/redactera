"""Build the Windows launcher and managed updater from locked source."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from urllib.request import urlopen
from zipfile import ZipFile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
STATE = ROOT / '.project-state/windows-installer'
LOCK = HERE / 'lock.json'
PATCH = HERE / 'squirrel-full-only.patch'
LAUNCHER_PATCH = HERE / 'squirrel-launcher.patch'


def digest(path, algorithm='sha256'):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def locked_input(entry, work):
    name = entry['file']
    require(re.fullmatch(r'[\w.-]+', name) and name not in ('.', '..'), 'Invalid installer input filename')
    algorithm = 'sha512' if 'sha512' in entry else 'sha256'
    cache = STATE / 'inputs' / name
    if not cache.exists():
        url = entry['url']
        require(url.startswith('https://'), 'Installer inputs require HTTPS')
        temp = work / name
        with urlopen(url, timeout=90) as response, temp.open('xb') as output:
            require(response.geturl().startswith('https://'), 'Installer input redirected outside HTTPS')
            shutil.copyfileobj(response, output, length=1024 * 1024)
        require(digest(temp, algorithm) == entry[algorithm], 'Installer input hash mismatch: ' + name)
        cache.parent.mkdir(exist_ok=True)
        os.replace(temp, cache)
    require(cache.is_file() and digest(cache, algorithm) == entry[algorithm],
            'Installer cache hash mismatch: ' + name)
    return cache


def write_member(name, destination, stream):
    relative = PurePosixPath(name)
    require(relative.parts and not relative.is_absolute() and '..' not in relative.parts
            and '\\' not in name and ':' not in name, 'Invalid installer archive path')
    target = destination.joinpath(*relative.parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('xb') as output:
        shutil.copyfileobj(stream, output)


def unpack_zip(archive, destination, prefix=''):
    with ZipFile(archive) as source:
        for member in source.infolist():
            if member.is_dir() or not member.filename.startswith(prefix):
                continue
            require(not stat.S_ISLNK(member.external_attr >> 16), 'Unexpected installer archive link')
            with source.open(member) as stream:
                write_member(member.filename, destination, stream)


def unpack_sources(archive, destination, prefixes, exact):
    with tarfile.open(archive) as source:
        for member in source:
            name = member.name.partition('/')[2]
            if not (name in exact or name.startswith(prefixes)):
                continue
            if member.isdir() or Path(name).suffix.lower() in ('.exe', '.dll', '.com', '.pdb'):
                continue
            require(member.isfile(), 'Unexpected installer source archive member')
            with source.extractfile(member) as stream:
                write_member(name, destination, stream)


def run(args, cwd, env, timeout=300):
    subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True, timeout=timeout)


def apply_source_patch(source, patch, env, encoding):
    for line in patch.read_text(encoding='utf-8').splitlines():
        if line.startswith('--- a/'):
            target = source / line[len('--- a/'):]
            content = target.read_text(encoding=encoding)
            target.write_text(content, encoding='utf-8', newline='\n')
    # Apply in the extracted source only. Git must not discover the project's worktree.
    patch_env = {**env, 'GIT_CEILING_DIRECTORIES': str(source.parent)}
    run(['git', '-c', 'core.autocrlf=false', 'apply', '--no-index', '--whitespace=nowarn', patch], source, patch_env)


def prepare_source(source, inputs, env):
    unpack_sources(inputs['squirrel'], source, ('src/Squirrel/', 'src/Update/', 'src/Setup/', 'src/Directory.Build.'),
                   {'COPYING', 'version.json'})
    unpack_sources(inputs['nuget'], source / 'vendor/nuget', ('src/Core/', 'Build/', 'Common/'),
                   {'LICENSE.txt', 'NuGet.ruleset', 'CodeAnalysisDictionary.xml', 'Extended.Settings.targets'})
    apply_source_patch(source, PATCH, env, 'utf-8-sig')


def select_launcher_tools(settings, env):
    program_files = os.environ.get('ProgramFiles(x86)')
    require(program_files, 'The Windows ProgramFiles(x86) directory is required to locate Visual Studio')
    installer = Path(program_files) / 'Microsoft Visual Studio/Installer/vswhere.exe'
    require(installer.is_file(), 'Install Visual Studio 2026 or 2022 Build Tools to build Setup')
    result = subprocess.run([str(installer), '-products', '*', '-version', '[17.0,19.0)',
                             '-requires', 'Microsoft.Component.MSBuild', 'Microsoft.VisualStudio.Component.Windows11SDK.26100',
                             '-format', 'json', '-utf8'],
                            env=env, capture_output=True, encoding='utf-8-sig', check=True, timeout=30)
    instances = sorted(json.loads(result.stdout),
                       key=lambda instance: tuple(map(int, instance['installationVersion'].split('.'))),
                       reverse=True)
    prefix = settings['vcToolsVersionPrefix']
    required = ('bin/Hostx86/x86/cl.exe', 'lib/x86/libcmt.lib', 'atlmfc/include/atlbase.h',
                'atlmfc/lib/x86/atls.lib', 'atlmfc/lib/x64/atls.lib')
    for instance in instances:
        location = Path(instance['installationPath'])
        msbuild = location / 'MSBuild/Current/Bin/MSBuild.exe'
        if not msbuild.is_file():
            continue
        versions = [version.name for version in (location / 'VC/Tools/MSVC').glob(prefix + '.*')
                    if re.fullmatch(re.escape(prefix) + r'\.\d+', version.name)
                    and all((version / item).is_file() for item in required)]
        if versions:
            vc_version = max(versions, key=lambda version: int(version.rsplit('.', 1)[1]))
            return msbuild, instance['installationVersion'], vc_version
    raise RuntimeError(f'Install MSVC {settings["platformToolset"]} (v{prefix}) and matching C++ ATL (x86 and x64) '
                       f'in a Visual Studio 2026 or 2022 instance with Windows SDK {settings["windowsSdkVersion"]}')


def build_launcher(source, vendor, settings, env):
    """Build the native Setup with the upstream DLL loading fix applied."""
    msbuild, vs_version, vc_version = select_launcher_tools(settings, env)
    apply_source_patch(source, LAUNCHER_PATCH, env, 'utf-8')
    for name, expected in settings['patchedSourceSha256'].items():
        require(digest(source / name) == expected, 'Patched Setup source does not match upstream: ' + name)
    project = source / 'src/Setup/Setup.vcxproj'
    output = source / 'build/launcher'
    run([msbuild, project, '/nologo', '/m', '/nr:false', '/v:minimal', '/t:Build',
         '/p:Configuration=Release', '/p:Platform=Win32', '/p:PlatformToolset=' + settings['platformToolset'],
         '/p:VCToolsVersion=' + vc_version, '/p:WindowsTargetPlatformVersion=' + settings['windowsSdkVersion'],
         '/p:LinkIncremental=false',
         '/p:OutDir=' + output.as_posix() + '/'], source, env)
    setup = output / 'Setup.exe'
    require(setup.is_file() and setup.stat().st_size > 0, 'Missing rebuilt native Setup launcher')
    shutil.copyfile(setup, vendor / 'Setup.exe')
    return {
        'upstreamCommit': settings['upstreamCommit'], 'windowsSdkVersion': settings['windowsSdkVersion'],
        'platformToolset': settings['platformToolset'], 'visualStudioVersion': vs_version,
        'vcToolsVersion': vc_version, 'patchSha256': digest(LAUNCHER_PATCH),
        'templateSha256': digest(setup),
    }


def build(output):
    require(sys.platform == 'win32' and platform.machine().lower() in ('amd64', 'x86_64'),
            'The Windows installer requires native x64 Windows tools')
    require(output.parent == STATE and not output.exists(), 'Use a new Windows installer build directory')
    lock = json.loads(LOCK.read_text(encoding='utf-8'))
    package_root = ROOT / 'node_modules/electron-winstaller'
    require(json.loads((package_root / 'package.json').read_text(encoding='utf-8'))['version']
            == lock['electronWinstallerVersion'], 'Unexpected electron-winstaller version')

    STATE.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='work-', dir=STATE) as directory:
        work = Path(directory)
        sdk = work / 'sdk'
        feed = work / 'feed'
        feed.mkdir()
        unpack_zip(locked_input(lock['sdk'], work), sdk)
        for entry in lock['packages']:
            shutil.copyfile(locked_input(entry, work), feed / entry['file'])
        inputs = {name: locked_input(entry, work) for name, entry in lock['sources'].items()}
        vendor = work / 'ready/vendor'
        vendor.mkdir(parents=True)
        for name, expected in lock['vendorTools'].items():
            native = package_root / 'vendor' / name
            require(native.is_file() and digest(native) == expected, 'Unexpected installer helper: ' + name)
            shutil.copyfile(native, vendor / name)

        source = work / 'source'
        cache = work / 'packages'
        env = {**os.environ, 'DOTNET_CLI_HOME': str(work / 'dotnet-home'), 'DOTNET_NOLOGO': '1',
               'DOTNET_SKIP_FIRST_TIME_EXPERIENCE': '1', 'DOTNET_CLI_TELEMETRY_OPTOUT': '1',
               'DOTNET_ADD_GLOBAL_TOOLS_TO_PATH': '0', 'DOTNET_CLI_USE_MSBUILD_SERVER': '0',
               'NUGET_PACKAGES': str(cache), 'NUGET_HTTP_CACHE_PATH': str(work / 'nuget-http'),
               'NUGET_CREDENTIALPROVIDER_SESSIONTOKENCACHE_ENABLED': 'false', 'MSBUILDDISABLENODEREUSE': '1'}
        prepare_source(source, inputs, env)
        launcher = build_launcher(source, vendor, lock['launcher'], env)

        references = work / 'references'
        unpack_zip(feed / 'microsoft.netframework.referenceassemblies.net45.1.0.3.nupkg',
                   references, 'build/.NETFramework/v4.5/')
        ref = references / 'build/.NETFramework/v4.5'
        require((ref / 'mscorlib.dll').is_file() and (ref / 'RedistList/FrameworkList.xml').is_file(),
                'Missing .NET Framework 4.5 reference assemblies')
        for name in ('Microsoft.Data.Edm', 'Microsoft.Data.OData', 'Microsoft.Data.Services.Client', 'System.Spatial'):
            destination = source / 'packages' / (name + '.5.6.1')
            unpack_zip(feed / (name.lower() + '.5.6.1.nupkg'), destination, 'lib/net40/')
            require((destination / 'lib/net40' / (name + '.dll')).is_file(), 'Missing build reference: ' + name)

        config = work / 'NuGet.Config'
        config.write_text('<configuration><packageSources><clear /></packageSources></configuration>', encoding='utf-8')
        dotnet = sdk / 'dotnet.exe'
        project = source / 'src/Update/Update.csproj'
        params = ['-p:FrameworkPathOverride=' + str(ref), '-p:TargetFrameworkRootPath=' + str(references / 'build'),
                  '-p:AutomaticallyUseReferenceAssemblyPackages=false', '-p:NuGetAudit=false',
                  '-p:EnableSourceLink=false', '-p:UseSharedCompilation=false', '-p:Configuration=Release']
        run([dotnet, 'restore', project, '--configfile', config, '--source', feed, '--packages', cache, *params], source, env)
        run([dotnet, 'build', project, '--no-restore', '-c', 'Release', '-v:minimal', *params], source, env)
        compiled = source / 'build/Release/net45'
        merged = ['Update.exe', 'WpfAnimatedGif.dll', 'Squirrel.dll', 'NuGet.Squirrel.dll', 'Mono.Cecil.dll']
        require(all((compiled / name).is_file() for name in merged), 'Missing updater build outputs')
        for pattern in ('*XmlTransform*', 'SharpCompress*', 'DeltaCompressionDotNet*'):
            require(not list(compiled.glob(pattern)), 'Unexpected legacy updater output: ' + pattern)
        updater = vendor / 'Squirrel.exe'
        run([cache / 'ilrepack/1.26.0/tools/ILRepack.exe', '/internalize', '/out:' + str(updater), *merged], compiled, env)
        run([vendor / 'rcedit.exe', updater, '--set-icon', ROOT / 'assets/icon.ico'], vendor, env, timeout=45)
        require(updater.is_file() and updater.stat().st_size > 0, 'Missing merged updater')
        proof = {
            'framework': 'net45', 'sdkVersion': lock['sdk']['version'], 'lockSha256': digest(LOCK),
            'patchSha256': digest(PATCH), 'updaterSha256': digest(updater), 'launcher': launcher,
        }
        (work / 'ready/build.json').write_text(json.dumps(proof, indent=2) + '\n', encoding='utf-8')
        (work / 'ready').rename(output)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('Use build.py NEW_WINDOWS_INSTALLER_BUILD_DIRECTORY')
    build(Path(sys.argv[1]).resolve())
