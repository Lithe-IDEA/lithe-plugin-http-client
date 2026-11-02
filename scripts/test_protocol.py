"""Bounded integration tests: real plugin SDK process + unchanged upstream + loopback HTTP.

Run with a packaged or debug binary. No external network or installed Lithe required.
"""
import argparse
import hashlib
import html
import http.server
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile
import threading
import time
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "target/debug/lithe-http-client"


class Host:
    def __init__(self, directory):
        self.log = tempfile.TemporaryFile()
        self.process = subprocess.Popen([str(BINARY)], cwd=directory, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.log, start_new_session=True)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b""
        self.number = 0

    def send(self, method, params, request=True):
        self.number += 1
        message = {"jsonrpc": "2.0", "method": method, "params": params}
        if request:
            message["id"] = self.number
        body = json.dumps(message).encode()
        self.process.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        self.process.stdin.flush()
        return self.number

    def answer(self, number, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if b"\r\n\r\n" in self.buffer:
                headers, body = self.buffer.split(b"\r\n\r\n", 1)
                length = int(next(line.split(b":", 1)[1] for line in headers.split(b"\r\n")
                                  if line.lower().startswith(b"content-length:")))
                if len(body) >= length:
                    frame = json.loads(body[:length])
                    self.buffer = body[length:]
                    if frame.get("id") == number and "method" not in frame:
                        return frame
                    continue
            if not self.selector.select(max(0, deadline - time.monotonic())):
                break
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise AssertionError("backend exited before its reply")
            self.buffer += chunk
        raise AssertionError(f"request {number} exceeded {timeout}s")

    def invoke(self, name, params):
        return self.send("lithe/function/invoke", {"functionID": name, "operationID": f"op-{self.number + 1}", "params": params})

    def close(self):
        try:
            if self.process.poll() is None:
                try:
                    self.answer(self.send("shutdown", {}), timeout=2)
                    self.send("exit", {}, request=False)
                    self.process.wait(timeout=3)
                except (AssertionError, BrokenPipeError, subprocess.TimeoutExpired):
                    os.killpg(self.process.pid, signal.SIGKILL)
                    self.process.wait(timeout=3)
        finally:
            self.selector.close()
            self.process.stdin.close()
            self.process.stdout.close()
            self.log.close()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/slow":
            self.server.entered.set()
            self.server.release.wait(timeout=8)
        body = ("好🙂" * 20000).encode() if self.path == "/large" else b'{"ok":true}'
        self.reply(body)

    def do_POST(self):
        self.reply(self.rfile.read(int(self.headers.get("Content-Length", 0))))

    def reply(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.host = Host(self.temp.name)
        self.addCleanup(self.host.close)
        initialized = self.host.answer(self.host.send("initialize", {
            "rootUri": Path(self.temp.name).as_uri(),
            "capabilities": {"experimental": {"litheFunctions": {"versions": [1, 2, 3]}}}
        }))
        self.assertIn("result", initialized)
        self.host.send("initialized", {}, request=False)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.server.entered = threading.Event()
        self.server.release = threading.Event()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close_server(self):
        self.server.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())

    def execute(self, text, index=0):
        return self.host.answer(self.host.invoke("requests.execute", {"text": text, "index": index}))

    def test_parse_multiple_requests_without_network(self):
        reply = self.host.answer(self.host.invoke("requests.parse", {"text": "### first\nGET http://example.invalid/a\n### second\nPOST http://example.invalid/b\n\nx"}))
        self.assertEqual([r["method"] for r in reply["result"]["requests"]], ["GET", "POST"])

    def test_post_uses_upstream_file_variables_and_body(self):
        reply = self.execute(f"@base = {self.url}\nPOST {{{{base}}}}/echo\nContent-Type: application/json\n\n{{\"hello\":\"世界\"}}")
        value = reply["result"]
        self.assertEqual(value["status"], 200)
        self.assertEqual(json.loads(value["body"]), {"hello": "世界"})

    def test_rejects_file_include_before_reading(self):
        reply = self.execute(f"POST {self.url}/echo\n\n< private.json")
        self.assertIn("httpClient.fileIncludeUnsupported", json.dumps(reply))

    def test_rejects_handlers_and_redirects(self):
        for directive in ["> {% client.test('x', () => {}); %}", ">> output.json", "<> response.json"]:
            with self.subTest(directive=directive):
                self.assertIn("httpClient.handlerUnsupported", json.dumps(self.execute(f"GET {self.url}/ok\n\n{directive}")))

    def test_rejects_oversized_input_and_non_http_scheme(self):
        self.assertIn("httpClient.invalidInput", json.dumps(self.execute("x" * (128 * 1024 + 1))))
        self.assertIn("httpClient.invalidScheme", json.dumps(self.execute("GET file:///secret")))

    def test_rejects_unresolved_variable(self):
        reply = self.execute("GET https://{{unknown}}/secret")
        self.assertIn("httpClient.prepareFailed", json.dumps(reply))
        self.assertNotIn("https://", json.dumps(reply))

    def test_cancel_after_server_accepts_then_reuse_backend(self):
        number = self.host.invoke("requests.execute", {"text": f"GET {self.url}/slow", "index": 0})
        self.assertTrue(self.server.entered.wait(timeout=5), "request must reach server before cancellation")
        self.host.send("$/cancelRequest", {"id": number}, request=False)
        reply = self.host.answer(number)
        self.assertEqual(reply["error"]["code"], -32800)
        self.server.release.set()
        self.assertEqual(self.execute(f"GET {self.url}/ok")["result"]["status"], 200)

    def test_unicode_response_preview_is_bounded(self):
        reply = self.execute(f"GET {self.url}/large")
        value = reply["result"]
        self.assertTrue(value["truncated"])
        self.assertLessEqual(len(value["body"].encode()), 48 * 1024)
        self.assertNotIn("\ufffd", value["body"])

    def test_no_state_files_written(self):
        self.assertEqual(self.execute(f"GET {self.url}/ok")["result"]["status"], 200)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])


class TimedResult(unittest.TextTestResult):
    def startTest(self, test):
        self.started = time.monotonic()
        super().startTest(test)

    def stopTest(self, test):
        records.append((test.id(), time.monotonic() - self.started))
        super().stopTest(test)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, default=BINARY)
    args = parser.parse_args()
    BINARY = args.binary.resolve()
    original = hashlib.sha256(BINARY.read_bytes()).hexdigest()
    records = []
    result = unittest.TextTestRunner(verbosity=2, resultclass=TimedResult).run(unittest.defaultTestLoader.loadTestsFromTestCase(ProtocolTests))
    assert hashlib.sha256(BINARY.read_bytes()).hexdigest() == original
    directory = ROOT / ".artifacts/test-stability"
    directory.mkdir(parents=True, exist_ok=True)
    suite = ET.Element("testsuite", name="http-client-protocol", tests=str(result.testsRun), failures=str(len(result.failures)), errors=str(len(result.errors)))
    failures = {test.id(): message for test, message in result.failures + result.errors}
    for name, duration in records:
        case = ET.SubElement(suite, "testcase", name=name, time=f"{duration:.6f}")
        if name in failures:
            ET.SubElement(case, "failure").text = failures[name]
    ET.ElementTree(suite).write(directory / "junit.xml", encoding="unicode")
    rows = "".join(f"<tr><td>{html.escape(name)}</td><td>{duration:.3f}s</td><td>{'FAIL' if name in failures else 'PASS'}</td></tr>" for name, duration in records)
    (directory / "index.html").write_text(f"<!doctype html><meta charset='utf-8'><title>HTTP pilot tests</title><h1>HTTP pilot protocol integration</h1><table>{rows}</table>")
    raise SystemExit(not result.wasSuccessful())
