#!/usr/bin/env python3
"""Local-only two-account controlled validation runner. Python 3 standard library; no signup/email sending.

Authentication tokens remain only in browser memory. Do not reload the verified
page. Closing it discards the session. Grocery operations run only after the explicit approved-test button; no management API is called.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlsplit

CONFIG = json.loads(Path(__file__).with_name('public-config.json').read_text())
PROJECT = 'https://grocery-review.invalid'  # Sanitized placeholder, not a Supabase project.
EXPECTED_EMAIL = 'account-1@example.invalid'  # Sanitized synthetic identity, not an account.
if CONFIG.get('url') != PROJECT or not CONFIG.get('publishableKey', '').startswith('sb_publishable_'):
    sys.exit('Unexpected public project configuration. Stopped.')

import secrets
RUN_ID = secrets.token_urlsafe(24)
HTML = b'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Controlled Grocery App validation</title><style>body{font:18px system-ui;max-width:850px;margin:32px auto;padding:20px;line-height:1.5}button{font:inherit;padding:12px}li{margin:10px 0}</style></head><body><h1>Controlled Grocery App validation</h1><p id="status" role="status">Preparing...</p><p id="identity"></p><p id="accounts"></p><button id="start" disabled>Run the approved one-list sharing test ONCE</button><ol id="results"></ol><p>Leave each authenticated tab open. No email, password changes, import, cleanup, configuration changes, or pre-existing grocery queries are performed. Sessions are memory-only. Do not reload after starting.</p><script src="/config.js"></script><script src="/supabase.js"></script><script src="/mutation-protocol.js"></script><script src="/runner.js"></script></body></html>'


class CallbackHandler(BaseHTTPRequestHandler):
    server_version = 'LocalGroceryCallback'

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.headers.get('Host') not in ('localhost:3000', '127.0.0.1:3000'):
            self.reply(403, b'Unexpected host. Stopped.', 'text/plain')
            return
        path = urlsplit(self.path).path
        if path == '/':
            self.reply(200, HTML, 'text/html; charset=utf-8')
        elif path == '/config.js':
            script = 'window.PUBLIC_CONFIG=' + json.dumps(CONFIG) + ';window.RUN_ID=' + json.dumps(RUN_ID) + ';'
            self.reply(200, script.encode(), 'text/javascript; charset=utf-8')
        elif path in ('/runner.js', '/supabase.js', '/mutation-protocol.js'):
            body = Path(__file__).with_name(path[1:]).read_bytes()
            self.reply(200, body, 'text/javascript; charset=utf-8')
        else:
            self.reply(404, b'Not found', 'text/plain')

    def do_POST(self):
        # The server never accepts tokens, credentials, or application actions.
        self.reply(405, b'Not supported', 'text/plain')

    def reply(self, code, body, content_type):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src " + PROJECT + ' ' + PROJECT.replace('https://', 'wss://') + "; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)


class LocalServer(HTTPServer):
    def handle_error(self, request, client_address):
        print('Local request failed. No request details were logged.', flush=True)


if __name__ == '__main__':
    try:
        server = LocalServer(('127.0.0.1', 3000), CallbackHandler)
    except OSError:
        sys.exit('Cannot listen on 127.0.0.1:3000. Stop and report this error; do not change ports or stop another service.')
    print('READY: listening only on 127.0.0.1:3000. Open http://localhost:3000 on THIS Mac.', flush=True)
    print('No email sent. No authentication tokens are logged or saved. Press Control-C to stop.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.', flush=True)
    finally:
        server.server_close()
