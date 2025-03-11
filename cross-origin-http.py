#!/usr/bin/env python3
from http.server import HTTPServer, SimpleHTTPRequestHandler
import sys

class CustomRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        return super(CustomRequestHandler, self).end_headers()

host = sys.argv[1] if len(sys.argv) > 2 else '0.0.0.0'
port = int(sys.argv[len(sys.argv)-1]) if len(sys.argv) > 1 else 8000

print("Listening on {}:{}".format(host, port))
print("Connect to http://localhost:{}/ for cross-origin isolation".format(port))
httpd = HTTPServer((host, port), CustomRequestHandler)
httpd.serve_forever()
