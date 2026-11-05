#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
极简本地服务器（零依赖）
------------------------------------------------------------
用途：浏览器的 Web Serial / fetch 在 file:// 下受限，用本地 http 提供页面。

用法：
    python3 tools/serve.py            # 默认 8080，自动打开浏览器
    python3 tools/serve.py 9000       # 指定端口
    python3 tools/serve.py --no-open  # 不自动打开
    python3 tools/serve.py --lan      # 共享到局域网，让别人用 http://<你的IP>:8080 打开
                                      # （启动后终端会直接打印可复制的地址）
"""
from __future__ import annotations

import http.server
import json
import os
import socketserver
import re
import subprocess
import sys
import threading
import webbrowser


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARENT = os.path.dirname(ROOT)


# 只放行游戏目录和数据集目录，其余一律 403。
# 之前把整个项目根目录（含 .opencode、uploads）当静态根，同机任何页面都能读走。
ALLOW_PREFIXES = ("/blink-flappy/", "/EEG-EyeBlinks 5/", "/EEG-EyeBlinks%205/")
REDIRECT_ROOT = "/blink-flappy/index.html"


class Handler(http.server.SimpleHTTPRequestHandler):
    """静态根为项目根，但只允许访问白名单目录，禁用缓存。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PARENT, **kwargs)

    def _guard(self) -> bool:
        from urllib.parse import unquote

        raw = self.path.split("?")[0].split("#")[0]
        path = unquote(raw)
        if path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", REDIRECT_ROOT)
            self.end_headers()
            return False
        if not any(path.startswith(p) or path.startswith(unquote(p)) for p in ALLOW_PREFIXES):
            body = b"403 forbidden: only /blink-flappy/ and the EEG dataset are served"
            self.send_response(403)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return False
        return True

    def do_GET(self):
        if self._guard():
            super().do_GET()

    def do_HEAD(self):
        if self._guard():
            super().do_HEAD()

    def list_directory(self, path):
        # 不提供目录浏览
        self.send_error(403, "Directory listing disabled")
        return None

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 只打印非静态资源噪音较少的日志
        if "GET /blink-flappy" in str(args[0]) or "GET /EEG" in str(args[0]):
            return
        sys.stderr.write("[http] " + (fmt % args) + "\n")


def pick_port(start: int, host: str = "127.0.0.1") -> int:
    for p in range(start, start + 40):
        try:
            with socketserver.TCPServer((host, p), None):
                return p
        except OSError:
            continue
    raise SystemExit("找不到可用端口")


def lan_addresses() -> list:
    """列出本机局域网 IPv4 地址，供别人访问。"""
    out = []
    try:
        txt = subprocess.run(["ifconfig"], capture_output=True, text=True).stdout
        for m in re.finditer(r"^\s*inet (\d+\.\d+\.\d+\.\d+)", txt, re.M):
            ip = m.group(1)
            if ip.startswith("127.") or ip.startswith("169.254."):
                continue
            out.append(ip)
    except Exception:
        pass
    # 常见家用网段排前面
    out.sort(key=lambda x: (not (x.startswith("192.168.") or x.startswith("10.")), x))
    return out


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    lan = "--lan" in argv
    no_open = "--no-open" in argv
    argv = [a for a in argv if not a.startswith("--")]
    host = "0.0.0.0" if lan else "127.0.0.1"
    port = int(argv[0]) if argv else 8080
    port = pick_port(port, host)

    url = f"http://127.0.0.1:{port}/blink-flappy/index.html"
    socketserver.TCPServer.allow_reuse_address = True

    with socketserver.ThreadingTCPServer((host, port), Handler) as httpd:
        print("=" * 62)
        print("  眨眼小鸟 Blink Bird")
        print("  本机打开： " + url)
        if lan:
            ips = lan_addresses()
            if ips:
                print("  ---- 把这个发给别人（需连同一个 WiFi）----")
                for ip in ips:
                    print("    http://%s:%d/blink-flappy/index.html" % (ip, port))
                print("  注意：首次启动 macOS 可能弹窗询问是否允许 Python")
                print("        接受传入连接，要选「允许」。")
            else:
                print("  未检测到局域网地址，请检查是否连着 WiFi")
            print("  提示：数据集目录也会一并共享，演示完记得 Ctrl+C 关掉")
        print("  Ctrl+C 停止")
        print("=" * 62)
        if not no_open:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
