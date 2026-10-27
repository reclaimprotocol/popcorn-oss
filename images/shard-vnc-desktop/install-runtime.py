"""Install checksum-pinned upstream archives without the SDK auto-updater."""
import hashlib
from pathlib import Path
import subprocess
import tempfile

root = Path('/opt/shard/runtime')
root.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory() as temp:
    for row in Path('/opt/shard/artifacts.lock').read_text().splitlines():
        checksum, url = row.split()
        archive = Path(temp) / url.rsplit('/', 1)[1]
        subprocess.run(['curl', '--fail', '--location', '--retry', '3', '--max-time', '300',
                        '--output', str(archive), url], check=True)
        with archive.open('rb') as source:
            actual = hashlib.file_digest(source, 'sha256').hexdigest()
        if actual != checksum:
            raise RuntimeError('ShardBrowser archive checksum mismatch: ' + url)
        subprocess.run(['unzip', '-q', str(archive), '-d', str(root)], check=True)
(root / 'shardx-fingerprints').rename(root / 'fingerprints')
(root / 'ShardX-Linux/chrome').chmod(0o755)
# Engine remains upstream's unmodified binary. Widevine is not bundled.
