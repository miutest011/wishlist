#!/usr/bin/env python3
"""生成 PWA 需要的应用图标（绿底 + 一张歪着的拍立得）。

不依赖任何第三方库，PNG 是手写编码的。想换颜色或图案，改下面的参数再重跑：

    python3 tools/make-icons.py
"""

import math
import struct
import zlib
from pathlib import Path

# 想换配色改这三行就行（和 style.css 里的颜色对应）
BACKGROUND = (47, 111, 69)       # #2F6F45 种草绿
FRAME = (252, 252, 249)          # 相框的白
PHOTO = (196, 214, 190)          # 相片区域，比背景浅一点的绿

TILT_DEGREES = -8                # 相框歪多少度
FRAME_WIDTH = 0.52               # 相框宽度，占整张图的比例
FRAME_HEIGHT = 0.60
BORDER = 0.045                   # 相框左右和上方的白边
BOTTOM_BORDER = 0.13             # 下方白边更宽，这是拍立得的特征
SAMPLES = 3                      # 每个像素细分成 3x3 来采样，边缘才不会有锯齿

OUTPUT_DIR = Path(__file__).resolve().parent.parent / 'icons'
SIZES = {
    'icon-192.png': 192,
    'icon-512.png': 512,
    'apple-touch-icon.png': 180,  # iPhone 添加到主屏幕时用这个
}


def color_at(x, y):
    """给定一个点（坐标是 0~1 的比例），返回它该是什么颜色。"""
    # 把坐标转到「相框自己的方向」上：绕中心反向旋转，之后就只用判断矩形范围
    angle = math.radians(-TILT_DEGREES)
    dx, dy = x - 0.5, y - 0.5
    fx = dx * math.cos(angle) - dy * math.sin(angle) + 0.5
    fy = dx * math.sin(angle) + dy * math.cos(angle) + 0.5

    left = (1 - FRAME_WIDTH) / 2
    top = (1 - FRAME_HEIGHT) / 2
    right = left + FRAME_WIDTH
    bottom = top + FRAME_HEIGHT

    if not (left <= fx <= right and top <= fy <= bottom):
        return BACKGROUND

    # 相片区域：左右上留细白边，下面留宽白边
    if (left + BORDER <= fx <= right - BORDER
            and top + BORDER <= fy <= bottom - BOTTOM_BORDER):
        return PHOTO

    return FRAME


def draw_icon(size):
    """画一张图标，返回 RGBA 像素数据。"""
    rows = bytearray()
    step = 1.0 / (SAMPLES + 1)

    for y in range(size):
        for x in range(size):
            # 一个像素里取 3x3 个点求平均，边缘就不会是硬邦邦的锯齿
            totals = [0, 0, 0]
            for sy in range(1, SAMPLES + 1):
                for sx in range(1, SAMPLES + 1):
                    color = color_at((x + sx * step) / size, (y + sy * step) / size)
                    for channel in range(3):
                        totals[channel] += color[channel]

            count = SAMPLES * SAMPLES
            rows.extend(round(total / count) for total in totals)
            rows.append(255)      # 不透明
    return bytes(rows)


def write_png(path, size, pixels):
    """手写一个最简单的 PNG 文件。"""
    def chunk(tag, data):
        return (
            struct.pack('>I', len(data))
            + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    # PNG 要求每行数据前面加一个字节表示「过滤方式」，0 表示不过滤
    raw = b''.join(
        b'\x00' + pixels[y * size * 4:(y + 1) * size * 4]
        for y in range(size)
    )

    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8 位 RGBA
    path.write_bytes(
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', header)
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )


def main():
    OUTPUT_DIR.mkdir(exist_ok=True)
    for name, size in SIZES.items():
        path = OUTPUT_DIR / name
        write_png(path, size, draw_icon(size))
        print(f'{path.relative_to(OUTPUT_DIR.parent)}  ({size}x{size}, {path.stat().st_size} 字节)')


if __name__ == '__main__':
    main()
