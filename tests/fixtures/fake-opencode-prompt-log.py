#!/usr/bin/env python3
"""Fake `opencode serve` for model-routing tests.

Speaks just enough of the V1 and V2 HTTP APIs for a managed launch, and
appends the model each initial prompt ran with (V2 selects it with a separate
model request before the prompt) to $HOME/opencode-prompts.log
(one JSON value per line, null when no model was sent). It never runs a model.
"""
import base64
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

if len(sys.argv) < 2 or sys.argv[1] != "serve":
    print("[]")
    raise SystemExit(0)

port = int(sys.argv[sys.argv.index("--port") + 1])
username = os.environ.get("OPENCODE_SERVER_USERNAME", "opencode")
password = os.environ["OPENCODE_SERVER_PASSWORD"]
authorization = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()
sessions = {}
statuses = {}
selected = {}


def log_model(model):
    with open(os.path.join(os.environ["HOME"], "opencode-prompts.log"), "a") as log:
        log.write(json.dumps(model) + "\n")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def authorized(self):
        if self.headers.get("Authorization") != authorization:
            self.send_response(401)
            self.end_headers()
            return False
        return True

    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def respond(self, status, value=None):
        body = b"" if value is None else json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.authorized():
            return
        path = urlparse(self.path).path
        parts = path.split("/")
        if path == "/global/health":
            return self.respond(200, {"healthy": True, "version": "fake"})
        if path == "/api/info":
            return self.respond(200, {"pid": os.getpid(), "capabilities": {}})
        if path == "/session/status":
            return self.respond(200, {k: {"type": v} for k, v in statuses.items()})
        if path == "/api/session/active":
            return self.respond(200, {"data": {}})
        if path == "/session":
            return self.respond(200, list(sessions.values()))
        if path == "/api/session":
            return self.respond(200, {"data": list(sessions.values())})
        if path.endswith("/message"):
            if path.startswith("/api/"):
                return self.respond(200, {"data": [], "cursor": {}})
            return self.respond(200, [])
        if path.startswith("/api/session/"):
            found = sessions.get(parts[3])
            return self.respond(200 if found else 404, {"data": found})
        if path.startswith("/session/"):
            found = sessions.get(parts[2])
            return self.respond(200 if found else 404, found)
        return self.respond(404, {"error": "unknown"})

    def do_POST(self):
        if not self.authorized():
            return
        parsed = urlparse(self.path)
        path = parsed.path
        data = self.body()
        if path in ("/session", "/api/session"):
            directory = parse_qs(parsed.query).get("directory", [None])[0]
            directory = directory or data.get("location", {}).get("directory", os.getcwd())
            session_id = "ses_owned_%d" % (len(sessions) + 1)
            session = {
                "id": session_id,
                "title": "task",
                "directory": directory,
                "location": {"directory": directory},
                "time": {"created": 1, "updated": 9000000000000},
            }
            sessions[session_id] = session
            statuses[session_id] = "idle"
            return self.respond(200, {"data": session} if path.startswith("/api") else session)
        if path.endswith("/prompt_async"):
            log_model(data.get("model"))
            statuses[path.split("/")[2]] = "busy"
            return self.respond(204)
        if path.startswith("/api/session/") and path.endswith("/model"):
            selected[path.split("/")[3]] = data.get("model")
            return self.respond(200, {"data": None})
        if path.startswith("/api/session/") and path.endswith("/prompt"):
            log_model(selected.get(path.split("/")[3], data.get("_settings", {}).get("model")))
            statuses[path.split("/")[3]] = "busy"
            return self.respond(200, {"data": {"id": "input"}})
        return self.respond(404, {"error": "unknown"})


ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
