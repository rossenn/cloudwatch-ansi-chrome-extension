#!/usr/bin/env python3
"""
Generates 16/48/128 px PNG icons for the extension.

Uses only the standard library (zlib + struct). The icon is a 2x2 grid
of the four highlight colors that MessageHighlightConverter emits:
   top-left  ORANGE          xterm 208  rgb(255,135,0)
   top-right LIGHT_ORANGE    xterm 215  rgb(255,175,95)
   bottom-l  BLUE            xterm 75   rgb(95,175,255)
   bottom-r  LIGHT_BLUE      xterm 4    rgb(0,0,128)
A thin dark border is added so it stays visible on light toolbars.
"""
import os
import struct
import zlib

QUADRANTS = (
    (255, 135,   0),  # ORANGE     (xterm 208)
    (255, 175,  95),  # LIGHT_ORANGE (xterm 215)
    ( 95, 175, 255),  # BLUE       (xterm 75)
    (  0,   0, 128),  # LIGHT_BLUE (xterm 4 in 256-mode)
)
BORDER = (40, 40, 40)
ICON_SIZES = (16, 48, 128)


def render_pixels(size: int) -> bytes:
    half = size // 2
    border_thickness = max(1, size // 32)
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # PNG row filter "None"
        for x in range(size):
            on_border = (
                x < border_thickness
                or y < border_thickness
                or x >= size - border_thickness
                or y >= size - border_thickness
            )
            if on_border:
                r, g, b = BORDER
            else:
                idx = (1 if x >= half else 0) | (2 if y >= half else 0)
                r, g, b = QUADRANTS[idx]
            rows.extend((r, g, b, 255))
    return bytes(rows)


def png_chunk(tag: bytes, data: bytes) -> bytes:
    chunk = tag + data
    return struct.pack(">I", len(data)) + chunk + struct.pack(">I", zlib.crc32(chunk) & 0xFFFFFFFF)


def write_png(path: str, size: int) -> None:
    pixels = render_pixels(size)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(pixels, 9)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", idat)
        + png_chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in ICON_SIZES:
        path = os.path.join(out_dir, f"icon{size}.png")
        write_png(path, size)
        print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    main()
