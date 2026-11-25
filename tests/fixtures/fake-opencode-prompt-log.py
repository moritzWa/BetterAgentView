#!/usr/bin/env python3
"""Fake `opencode serve` for model-routing tests.

Speaks just enough of the V1 and V2 HTTP APIs for a managed launch, and
appends the model each initial prompt ran with (V2 selects it with a separate
model request before the prompt) to $HOME/opencode-prompts.log (one JSON value
per line, null when no model was sent). It never runs a model.

It imports only socket, json and a few small modules: hosted macOS runners
start Python slowly, and importing http.server alone can use up the
supervisor's readiness window.
"""
import base64
import json
import os
import socket
import sys
import threading

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
lock = threading.Lock()


def log_model(model):
    with open(os.path.join(os.environ["HOME"], "opencode-prompts.log"), "a") as log:
        log.write(json.dumps(model) + "\n")


def parse_query(query):
    pairs = (item.split("=", 1) for item in query.split("&") if "=" in item)
    return {key: value.replace("%2F", "/") for key, value in pairs}


def route(method, target, data):
    path, _, query = target.partition("?")
    parts = path.split("/")
    v2 = path.startswith("/api/")

    if method == "GET":
        if path == "/global/health":
            return 200, {"healthy": True, "version": "fake"}
        if path == "/api/info":
            return 200, {"pid": os.getpid(), "capabilities": {}}
        if path == "/session/status":
            return 200, {k: {"type": v} for k, v in statuses.items()}
        if path == "/api/session/active":
            return 200, {"data": {}}
        if path == "/session":
            return 200, list(sessions.values())
        if path == "/api/session":
            return 200, {"data": list(sessions.values())}
        if path.endswith("/message"):
            return 200, {"data": [], "cursor": {}} if v2 else []
        if v2 and path.startswith("/api/session/"):
            found = sessions.get(parts[3])
            return (200 if found else 404), {"data": found}
        if path.startswith("/session/"):
            found = sessions.get(parts[2])
            return (200 if found else 404), found
        return 404, {"error": "unknown"}

    if path in ("/session", "/api/session"):
        directory = parse_query(query).get("directory")
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
        return 200, ({"data": session} if v2 else session)
    if path.endswith("/prompt_async"):
        log_model(data.get("model"))
        statuses[parts[2]] = "busy"
        return 204, None
    if v2 and path.endswith("/model"):
        selected[parts[3]] = data.get("model")
        return 200, {"data": None}
    if v2 and path.endswith("/prompt"):
        log_model(selected.get(parts[3], data.get("_settings", {}).get("model")))
        statuses[parts[3]] = "busy"
        return 200, {"data": {"id": "input"}}
    return 404, {"error": "unknown"}


def read_request(connection):
    buffer = b""
    while b"\r\n\r\n" not in buffer:
        chunk = connection.recv(65536)
        if not chunk:
            return None
        buffer += chunk
    head, _, body = buffer.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    method, target, _ = lines[0].split(" ", 2)
    headers = {}
    for line in lines[1:]:
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    length = int(headers.get("content-length", "0"))
    while len(body) < length:
        chunk = connection.recv(65536)
        if not chunk:
            break
        body += chunk
    return method, target, headers, body


def serve(connection):
    with connection:
        request = read_request(connection)
        if request is None:
            return
        method, target, headers, body = request
        if headers.get("authorization") != authorization:
            status, value = 401, None
        else:
            with lock:
                status, value = route(method, target, json.loads(body or b"{}"))
        payload = b"" if value is None else json.dumps(value).encode()
        reason = {200: "OK", 204: "No Content", 401: "Unauthorized", 404: "Not Found"}[status]
        connection.sendall(
            (
                f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n"
                f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n"
            ).encode()
            + payload
        )


listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", port))
listener.listen(64)
while True:
    connection, _ = listener.accept()
    threading.Thread(target=serve, args=(connection,), daemon=True).start()
