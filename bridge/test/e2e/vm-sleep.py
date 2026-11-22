"""Operator-only real macOS VM pause/resume test. Uses a synthetic HTTPS peer.

Does not suspend the host or copy personal pairing credentials into the VM.
Requires the exclusively leased office-marketplace VM to be running.
"""
import http.server
import json
import os
import shlex
import signal
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
import time

SPACE = 'local:office-marketplace'
GUEST = '/Users/lume/bridge-sleep-e2e-' + str(time.time_ns())
HERE = Path(__file__).parent


def run(*args, **kwargs):
    return subprocess.run(args, check=True, timeout=120, **kwargs)


def main():
    def interrupted(signum, frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    requests = []
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_POST(self):
            self.rfile.read(int(self.headers.get('Content-Length', '0')))
            if self.path == '/v1/connector/poll':
                time.sleep(2)
            requests.append({'path':self.path, 'at':time.time()})
            body = json.dumps({'pending':False, 'active_until':0, 'message':None, 'start':None, 'ok':True}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    result = {}
    child = None
    suspended = False
    with tempfile.TemporaryDirectory(prefix='bridge-vm-sleep-') as temporary:
        root = Path(temporary)
        run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=bridge-sleep-test', '-addext', 'subjectAltName=IP:192.168.64.1',
            '-keyout', str(root/'key.pem'), '-out', str(root/'cert.pem'),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        server = http.server.ThreadingHTTPServer(('0.0.0.0', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(root/'cert.pem', root/'key.pem')
        server.socket = context.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(root/'sshkey'))
        run('cua', 'sb', 'exec', SPACE, '--', f'mkdir -m 700 {GUEST}', stdout=subprocess.DEVNULL)
        for source, dest in [
            (Path.home()/'.local/share/opencode-v2/bin/native/agentview', 'agentview'),
            (HERE/'vm-sleep-fixture.py', 'fixture.py'),
            (root/'cert.pem', 'cert.pem'), (root/'sshkey.pub', 'sshkey.pub')]:
            run('cua', 'sb', 'cp', str(source), SPACE+':'+GUEST+'/'+dest, stdout=subprocess.DEVNULL)
        public = (root/'sshkey.pub').read_text().strip()
        run('cua', 'sb', 'exec', SPACE, '--',
            f'mkdir -p ~/.ssh; chmod 700 ~/.ssh; cat {GUEST}/sshkey.pub >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; chmod 700 {GUEST}/agentview',
            stdout=subprocess.DEVNULL)
        address = json.loads(subprocess.check_output(['curl', '-s', 'localhost:7777/lume/vms/office-marketplace']))['ipAddress']
        ssh = ['ssh', '-i', str(root/'sshkey'), '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile='+str(root/'known_hosts'),
            '-o', 'ConnectTimeout=10', 'lume@'+address]
        try:
            child = subprocess.Popen(ssh + [f'python3 {GUEST}/fixture.py {GUEST} https://192.168.64.1:{server.server_address[1]}'],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            deadline = time.monotonic()+60
            while not any(r['path']=='/v1/connector/start-lease' for r in requests):
                assert child.poll() is None, child.stdout.read()
                assert time.monotonic()<deadline, 'No completed initial pass'
                time.sleep(.5)
            result['baseline_checked'] = True
            print('VM BASELINE: real installed daemon completed an idle sync over HTTPS', flush=True)
            run('cua', 'sb', 'suspend', SPACE)
            suspended = True
            result['paused_at'] = time.time()
            print('VM PAUSED: holding the whole macOS guest for 45 seconds', flush=True)
            time.sleep(45)
            result['resume_started_at'] = time.time()
            run('cua', 'spaces', 'start', SPACE)
            suspended = False
            print('VM RESUMED: checking for an immediate sync, not the 15-minute timer', flush=True)
            deadline = time.monotonic()+45
            while not any(r['path']=='/v1/connector/checked' and r['at']>result['resume_started_at'] for r in requests):
                assert time.monotonic()<deadline, 'No fresh sync after VM resumed'
                time.sleep(.5)
            mark = next(r['at'] for r in requests if r['path']=='/v1/connector/checked' and r['at']>result['resume_started_at'])
            result['resumed_checked_after_seconds'] = round(mark-result['resume_started_at'], 2)
            run(*ssh, f'touch {GUEST}/finish')
            output, _ = child.communicate(timeout=30)
            result['daemon_log'] = output
            result['wake_detection_logged'] = 'bridge woke after' in output
            result['pass'] = result['wake_detection_logged']
        finally:
            if suspended:
                run('cua', 'spaces', 'start', SPACE)
            if child is not None and child.poll() is None:
                run(*ssh, f'touch {GUEST}/finish')
                output, _ = child.communicate(timeout=30)
                result['daemon_log'] = output
            cleanup = ('python3 -c ' + shlex.quote("from pathlib import Path; p=Path.home()/'.ssh/authorized_keys'; "
                + "p.write_text('\\n'.join(x for x in p.read_text().splitlines() if x!=" + repr(public) + ")+ '\\n')"))
            # Remove only the dedicated public key, not the user's other keys.
            run('cua', 'sb', 'exec', SPACE, '--', cleanup, stdout=subprocess.DEVNULL)
            server.shutdown()
            result['requests'] = requests
            report = Path.home()/'Documents/agentview-bridge-vm-sleep-results.json'
            report.write_text(json.dumps(result, indent=2))
            print('VM RESULT: '+str(report), flush=True)
    assert result.get('pass'), 'No sleep detection logged'


if __name__=='__main__':
    main()
