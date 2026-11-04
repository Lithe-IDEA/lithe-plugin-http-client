"""Drive the real Lithe Core plugin session via C ABI (run under a 30s watchdog)."""
import argparse
import ctypes
import json
from pathlib import Path
import tempfile
import time
import threading
import http.server
from test_protocol import Handler

parser = argparse.ArgumentParser()
parser.add_argument("--core", type=Path, required=True)
parser.add_argument("--binary", type=Path, required=True)
args = parser.parse_args()
core = ctypes.CDLL(str(args.core.resolve()))
core.lithe_core_execute_json.argtypes = [ctypes.c_char_p]
core.lithe_core_execute_json.restype = ctypes.c_void_p
core.lithe_core_free_string.argtypes = [ctypes.c_void_p]
diagnostics = []


def execute(command, payload):
    pointer = core.lithe_core_execute_json(json.dumps({"command": command, "payload": payload}).encode())
    assert pointer, "Core returned no response"
    try:
        reply = json.loads(ctypes.string_at(pointer))
    finally:
        core.lithe_core_free_string(pointer)
    assert reply.get("ok"), reply
    return reply.get("data")


def await_event(session, predicate):
    deadline = time.monotonic() + 8
    observed = []
    while time.monotonic() < deadline:
        value = execute("lsp.waitEvents", {"sessionId": session, "timeoutMilliseconds": 200})
        diagnostics.extend(execute("diagnostics.drainCoreEvents", {})["events"])
        for event in value["events"]:
            observed.append(event)
            if predicate(event):
                return event
    raise AssertionError(f"event deadline exceeded: {observed}")


root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "plugin.json").read_text())
validated = execute("plugins.declarative.validate", {"manifest": manifest})
assert validated.get("status") != "rejected", validated
with tempfile.TemporaryDirectory() as directory:
    started = execute("lsp.startServer", {
        "providerId": "http-client", "pluginId": manifest["id"],
        "role": "backend",
        "executablePath": str(args.binary.resolve()), "arguments": [],
        "rootUri": Path(directory).as_uri(), "workingDirectory": directory,
        "initializeTimeoutMilliseconds": 5000, "requestTimeoutMilliseconds": 5000,
        "shutdownTimeoutMilliseconds": 2000,
    })
    session = started["sessionId"]
    try:
        await_event(session, lambda event: event.get("type") == "functionsChanged")
        execute("lsp.functionRequest", {
            "sessionId": session, "operationId": "pilot-parse",
            "function": {"pluginID": manifest["id"], "functionID": "requests.parse"},
            "params": {"text": "GET http://example.invalid/hello"},
            "timeoutMilliseconds": 5000,
        })
        event = await_event(session, lambda event: event.get("type") == "requestCompleted" and event.get("operationId") == "pilot-parse")
        assert event["result"]["value"]["requests"][0]["method"] == "GET", event
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            execute("lsp.functionRequest", {
                "sessionId": session, "operationId": "pilot-http",
                "function": {"pluginID": manifest["id"], "functionID": "requests.execute"},
                "params": {"text": f"GET http://127.0.0.1:{server.server_port}/ok", "index": 0},
                "timeoutMilliseconds": 5000,
            })
            event = await_event(session, lambda event: event.get("type") == "requestCompleted" and event.get("operationId") == "pilot-http")
            assert event["result"]["value"]["status"] == 200, event
            assert json.loads(event["result"]["value"]["body"]) == {"ok": True}, event
            diagnostics.extend(execute("diagnostics.drainCoreEvents", {})["events"])
            finished = [entry for entry in diagnostics if entry["event"] == "plugins.operation.finished" and entry.get("op") == "pilot-http"]
            assert len(finished) == 1, diagnostics
            assert finished[0]["level"] == "INFO", finished
            assert finished[0]["channel"] == f"plugins/{manifest['id']}/host", finished
            assert finished[0]["fields"]["operation"] == "requests.execute", finished
            assert finished[0]["fields"]["duration_ms"] >= 0, finished
            assert not any(entry["event"] == "plugins.operation.finished" and entry.get("op") == "pilot-parse" for entry in diagnostics)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)
            assert not worker.is_alive()
        print(json.dumps({"manifest": "accepted", "functions": ["requests.parse", "requests.execute"], "result": "passed", "core": str(args.core.resolve())}))
    finally:
        execute("lsp.stopServer", {"sessionId": session})
