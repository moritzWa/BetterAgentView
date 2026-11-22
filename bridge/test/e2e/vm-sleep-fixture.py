"""Run inside a disposable macOS guest. Synthetic source and Keychain item only."""
import json
import os
from pathlib import Path
import signal
import shlex
import sqlite3
import subprocess
import sys
import time

root = Path(sys.argv[1])
endpoint = sys.argv[2]
root.mkdir(mode=0o700, exist_ok=True)
database = root / 'source.sqlite'
with sqlite3.connect(database) as db:
    db.executescript('''
      CREATE TABLE session_v2(id TEXT PRIMARY KEY);
      CREATE TABLE session_message(id TEXT PRIMARY KEY);
      CREATE TABLE event_sequence(seq INTEGER);
      CREATE TABLE event(seq INTEGER);
    ''')
service = 'agentview-bridge-' + os.urandom(16).hex()
config = dict(version=1, endpoint=endpoint, device_id='1'*32,
    database_epoch='2'*32, database=str(database), opencode_bin='/usr/bin/false',
    keychain_service=service, inode=database.stat().st_ino)
(root / 'config.json').write_text(json.dumps(config))
keychain = str(root / 'disposable.keychain-db')
password = os.urandom(16).hex()
original = shlex.split(subprocess.check_output(['/usr/bin/security', 'list-keychains', '-d', 'user']).decode())
subprocess.run(['/usr/bin/security', 'create-keychain', '-p', password, keychain], check=True)
subprocess.run(['/usr/bin/security', 'unlock-keychain', '-p', password, keychain], check=True)
subprocess.run(['/usr/bin/security', 'set-keychain-settings', '-lut', '3600', keychain], check=True)
subprocess.run(['/usr/bin/security', 'add-generic-password', '-a', 'connector',
    '-s', service, '-w', 'a'*43, '-T', '/usr/bin/security', keychain], check=True, stdout=subprocess.DEVNULL)
subprocess.run(['/usr/bin/security', 'list-keychains', '-d', 'user', '-s', keychain, *original], check=True)
child = None
try:
    with (root / 'daemon.log').open('w') as log:
        child = subprocess.Popen([str(root / 'agentview'), 'bridge', '--state-dir', str(root), 'run'],
            env={**os.environ, 'CURL_CA_BUNDLE':str(root / 'cert.pem')},
            stdout=subprocess.DEVNULL, stderr=log, start_new_session=True)
        start = time.monotonic()
        print('FIXTURE_PID=' + str(child.pid), flush=True)
        while time.monotonic() - start < 180 and not (root / 'finish').exists():
            assert child.poll() is None, 'Daemon exited early'
            time.sleep(1)
finally:
    if child is not None and child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=10)
    subprocess.run(['/usr/bin/security', 'list-keychains', '-d', 'user', '-s', *original], check=True)
    subprocess.run(['/usr/bin/security', 'delete-keychain', keychain], check=True)
    print((root / 'daemon.log').read_text(), flush=True)
