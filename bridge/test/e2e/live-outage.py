"""Bounded operator-only outage test of the installed, paired connector.

Temporarily replaces ONLY its launchd process. The normal pairing, source and
journal are reused, without source writes. Requests still reach the deployed
Worker, except during a 70-second silent transport blackhole. No credentials or
conversation bodies are logged. Always restores the launchd job in finally.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import signal
import socketserver
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time


def projection(config, session):
    with sqlite3.connect('file:' + config['database'] + '?mode=ro', uri=True) as db:
        db.execute('BEGIN')
        title, archived, revert = db.execute(
            'SELECT title,time_archived,revert FROM session_v2 WHERE id=?', [session]
        ).fetchone()
        assert revert is None, 'Use a session without a revert boundary'
        lines = ['archived=' + str(archived is not None).lower(),
                 'deleted=false', 'title=' + title, 'visible_before=']
        count = 0
        for mid, role, seq, raw in db.execute(
            "SELECT id,type,seq,data FROM session_message WHERE session_id=? AND type IN ('user','assistant') ORDER BY seq,id", [session]
        ):
            value = json.loads(raw)
            text = value['text'] if role == 'user' else '\n'.join(
                p['text'] for p in value.get('content', []) if p['type'] == 'text'
            )
            if not text.strip():
                continue
            assert '\x00' not in text and len(json.dumps(text, ensure_ascii=False).encode()) < 800000
            count += 1
            lines.append(f'{mid}\t{seq}\t{role}\t{text}')
        return hashlib.md5('\n'.join(lines).encode()).hexdigest(), count


def main():
    def interrupted(signum, frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    state = Path.home() / '.local/state/agentview/bridge'
    config = json.loads((state / 'config.json').read_text())
    session = os.environ['CLAUDE_CODE_SESSION_ID']
    label = 'com.agentview.bridge.' + config['device_id']
    domain = 'gui/' + str(os.getuid())
    plist = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
    job = plistlib.loads(plist.read_bytes())
    command = list(job['ProgramArguments'])
    command[0] = os.environ.get('AGENTVIEW_TEST_BRIDGE_BIN', command[0])
    token = subprocess.check_output(
        ['/usr/bin/security', 'find-generic-password', '-s', config['keychain_service'], '-w'],
        stderr=subprocess.DEVNULL, timeout=5
    ).decode().strip()

    def verify(expected):
        digest, count = expected
        data = json.dumps({'session_id': session, 'hash': digest}).encode()
        request_config = '\n'.join([
            'url = ' + json.dumps(config['endpoint'] + '/v1/sync/verify'),
            'header = ' + json.dumps('Authorization: Bearer ' + token),
            'header = "Content-Type: application/json"',
            'data-binary = ' + json.dumps(data.decode()),
            'max-time = 30', 'silent', 'show-error', 'fail'])
        result = json.loads(subprocess.check_output(
            ['/usr/bin/curl', '--config', '-'], input=request_config.encode(), timeout=35))
        return result['match'] and result['cloud_count'] == count

    class Blackhole(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.settimeout(80)
            try:
                self.request.recv(65536)
                time.sleep(75)
            except OSError:
                pass

    class Server(socketserver.ThreadingTCPServer):
        daemon_threads = True

    server = Server(('127.0.0.1', 0), Blackhole)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    process = None
    stopped = False
    result = {}
    report = Path.home() / 'Documents/agentview-bridge-outage-results.json'
    with tempfile.TemporaryDirectory(prefix='bridge-outage-') as temporary:
        root = Path(temporary)
        shim = root / 'curl'
        shim.write_text('''#!/usr/bin/python3
import json,os,subprocess,sys,time
from pathlib import Path
root=Path(os.environ['BRIDGE_OUTAGE_ROOT'])
config=sys.stdin.buffer.read()
path=next((line for line in config.decode().splitlines() if line.startswith('url = ')), '')
path=path.split('.workers.dev')[-1].rstrip('"')
blocked=(root/'blocked').exists()
args=['/usr/bin/curl','--config','-']
if blocked:
    args+=['--connect-to','agentvoice-private.moritzw.workers.dev:443:127.0.0.1:'+os.environ['BRIDGE_BLACKHOLE_PORT']]
start=time.time()
r=subprocess.run(args,input=config,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
with (root/'requests.jsonl').open('a') as f:
    item={'at':time.time(),'path':path,'code':r.returncode,'blocked':blocked,'seconds':time.time()-start}
    if path=='/v1/connector/poll' and r.returncode==0:
        try: item['active_until']=json.loads(r.stdout.rsplit(b'\\n',1)[0]).get('active_until',0)
        except (ValueError,TypeError): pass
    f.write(json.dumps(item)+'\\n')
sys.stdout.buffer.write(r.stdout)
sys.exit(r.returncode)
''')
        shim.chmod(0o700)
        env = {**os.environ, **job.get('EnvironmentVariables', {}),
               'PATH': str(root) + ':' + os.environ['PATH'],
               'BRIDGE_OUTAGE_ROOT': str(root),
               'BRIDGE_BLACKHOLE_PORT': str(server.server_address[1])}
        try:
            subprocess.run(['launchctl', 'bootout', domain, str(plist)], check=True, timeout=20)
            stopped = True
            with (root / 'daemon.log').open('w') as log:
                process = subprocess.Popen(command, env=env,
                    stdout=subprocess.DEVNULL, stderr=log, start_new_session=True)
                baseline = projection(config, session)
                deadline = time.monotonic() + 120
                def completed_pass(since=0):
                    path = root / 'requests.jsonl'
                    if not path.exists():
                        return False
                    requests = [json.loads(line) for line in path.read_text().splitlines()]
                    return any(r['path'] == '/v1/connector/start-lease' and r['code'] == 0 and r['at'] > since for r in requests)
                while not completed_pass() or not verify(baseline):
                    assert process.poll() is None, 'Connector exited'
                    assert time.monotonic() < deadline, 'Baseline did not reach the Worker'
                    time.sleep(3)
                result['baseline_match'] = True
                print('BASELINE: connector text hash matches real Worker', flush=True)
                (root / 'blocked').touch()
                result['drop_at'] = time.time()
                print('DROP: only connector requests now silently blackholed for 70 seconds. Add a commentary marker now.', flush=True)
                time.sleep(70)
                during = projection(config, session)
                result['source_changed_during_drop'] = during != baseline
                result['during_drop_cloud_match'] = verify(during)
                (root / 'blocked').unlink()
                result['restored_at'] = time.time()
                print('RESTORED: observing automatic recovery for up to 90 seconds', flush=True)
                deadline = time.monotonic() + 90
                matched = False
                while time.monotonic() < deadline:
                    assert process.poll() is None, 'Connector exited'
                    # This is a live chat: progress messages and monitor notices
                    # can append text after the drop snapshot. Compare the latest
                    # complete local projection, not a prefix the cloud has passed.
                    current = projection(config, session)
                    if verify(current) and completed_pass(result['restored_at']):
                        matched = True
                        result['verified_message_count'] = current[1]
                        break
                    time.sleep(3)
                result['recovered_text_hash_match'] = matched
                result['recovery_seconds'] = round(time.time() - result['restored_at'], 2)
                requests = [json.loads(line) for line in (root / 'requests.jsonl').read_text().splitlines()]
                result['transport_timeouts'] = [r for r in requests if r['blocked']]
                result['post_restore_successes'] = [r for r in requests if not r['blocked'] and r['at'] > result['restored_at']]
                result['phone_was_idle'] = all(r.get('active_until', 0) <= result['drop_at'] * 1000 for r in requests)
                result['daemon_log'] = (root / 'daemon.log').read_text()
        finally:
            if process is not None and process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=15)
            if stopped:
                subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True, timeout=20)
                subprocess.run(['launchctl', 'print', domain + '/' + label], check=True,
                    stdout=subprocess.DEVNULL, timeout=20)
            server.shutdown()
            result['login_item_restored'] = stopped
            report.write_text(json.dumps(result, indent=2))
            print('RESULT: ' + str(report), flush=True)
    assert result.get('source_changed_during_drop'), 'No new visible text arrived during the outage'
    assert result.get('phone_was_idle'), 'Mobile activity invalidated the idle-connector test'
    assert any(r['code'] == 28 for r in result['transport_timeouts']), 'No real curl timeout occurred'
    assert not result.get('during_drop_cloud_match'), 'Drop did not isolate the cloud copy'
    assert result.get('recovered_text_hash_match'), 'Network returned but history did not catch up within 90 seconds'


if __name__ == '__main__':
    main()
