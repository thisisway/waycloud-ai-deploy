"""Serves /var/www/vhosts/<Host>/httpdocs by the Host header. A docroot containing a `.fail` file answers 500."""
import http.server
import os
import posixpath
import urllib.parse

ROOT = os.environ.get("WC_VHOSTS", "/var/www/vhosts")


class Handler(http.server.SimpleHTTPRequestHandler):
    def _doc(self):
        return os.path.join(ROOT, (self.headers.get("Host") or "").split(":")[0], "httpdocs")

    def translate_path(self, path):
        rel = posixpath.normpath(urllib.parse.unquote(path.split("?", 1)[0])).lstrip("/")
        return os.path.join(self._doc(), rel)

    def do_GET(self):
        if os.path.exists(os.path.join(self._doc(), ".fail")):
            self.send_error(500, "fail marker present")
            return
        super().do_GET()

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("0.0.0.0", 8088), Handler).serve_forever()
