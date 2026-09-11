#!/usr/bin/env python3
"""本地开发用的小服务器。

和 `python3 -m http.server` 干的事一样，只多做一件：
**明确告诉浏览器不要缓存任何文件**。

为什么需要它：Python 自带的服务器不发缓存头，浏览器就会自己决定缓存多久，
结果是你改完代码刷新页面，看到的还是旧版本。这个坑连续踩过好几次，
每次都要花时间才反应过来"不是代码写错了，是根本没加载新代码"。

用法：

    python3 tools/dev-server.py          # 默认 4173 端口
    python3 tools/dev-server.py 8080     # 指定端口

注意这只用于本地开发。线上（GitHub Pages）该缓存还是要缓存的，
那是 sw.js 负责的事。
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PORT = 4173


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, format, *args):
        # 默认会把每个请求都打印出来，太吵，只留下错误
        if not args or not str(args[1]).startswith('2'):
            super().log_message(format, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    handler = partial(NoCacheHandler, directory=str(PROJECT_ROOT))

    print(f'心愿单：http://localhost:{port}')
    print(f'测试页面：http://localhost:{port}/tools/test.html')
    print('（这个服务器不缓存任何文件，改完代码刷新就能看到最新的）')

    ThreadingHTTPServer(('', port), handler).serve_forever()


if __name__ == '__main__':
    main()
