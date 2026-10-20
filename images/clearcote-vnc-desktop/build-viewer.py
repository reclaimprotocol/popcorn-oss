"""Build the shared viewer from the repository's checksum-pinned dependencies."""
import gzip
import hashlib
import io
import re
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path('/usr/share/novnc')
LOCKS = Path('/tmp/viewer-locks')


def fetch(url, expected):
    with urllib.request.urlopen(url, timeout=120) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError('Dependency checksum mismatch: ' + url)
    return data


def lock(name):
    return dict(line.split('=', 1) for line in (LOCKS / name).read_text().splitlines() if '=' in line)


def extract(data, destination):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        archive.extractall(destination, filter='data')


with tempfile.TemporaryDirectory() as temporary:
    work = Path(temporary)
    novnc = lock('novnc.lock')
    extract(fetch(novnc['url'], novnc['sha256']), work / 'novnc')
    source = next((work / 'novnc').iterdir())
    for directory in ('core', 'vendor'):
        shutil.copytree(source / directory, ROOT / directory)
    shutil.copy(source / 'LICENSE.txt', ROOT / ('LICENSE.noVNC-' + novnc['version'] + '.txt'))
    browser_js = ROOT / 'core/util/browser.js'
    browser = browser_js.read_text()
    old = 'supportsWebCodecsH264Decode = await _checkWebCodecsH264DecodeSupport();'
    if old not in browser:
        raise RuntimeError('noVNC WebCodecs backport needs review')
    browser_js.write_text(browser.replace(old, '_checkWebCodecsH264DecodeSupport().then((result) => { supportsWebCodecsH264Decode = result; });'))

    for line in (LOCKS / 'noble.lock').read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        name, _, url, checksum = line.split('\t')
        destination = work / name
        extract(fetch(url, checksum), destination)
        shutil.copytree(destination / 'package', ROOT / 'node_modules/@noble' / name)

    esbuild = lock('esbuild.lock')
    extract(fetch(esbuild['url'], esbuild['sha256']), work / 'esbuild')
    executable = work / 'esbuild/package/bin/esbuild'
    executable.chmod(0o755)
    bundle = work / 'viewer.js'
    subprocess.run([str(executable), str(ROOT / 'viewer.js'), '--bundle', '--format=esm',
                    '--supported:top-level-await=false', '--minify', '--outfile=' + str(bundle)], check=True)
    script = re.sub(r'</script', lambda _: '<' + chr(92) + '/script', bundle.read_text(), flags=re.I)
    html = ROOT / 'liveview.html'
    document = html.read_text()
    marker = '<!-- VIEWER_BUNDLE -->'
    if document.count(marker) != 1:
        raise RuntimeError('Expected one viewer bundle marker')
    html.write_text(document.replace(marker, '<script type="module">\n' + script + '\n</script>'))
    with (ROOT / 'liveview.html.gz').open('wb') as output:
        with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as compressor:
            compressor.write(html.read_bytes())
    subprocess.run(['brotli', '-q', '11', '-f', '-k', str(html)], check=True)
    shutil.rmtree(ROOT / 'node_modules')
