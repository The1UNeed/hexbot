#!/usr/bin/env python3
"""Render the Hexbot app icons from the Icon Composer bundle.

Source: apps/desktop/build/Hexbot.icon (layer images and scales in icon.json).
Outputs:
  apps/desktop/build/icon.png                1024 px: macOS squircle on a transparent ground (Linux, DMG)
  apps/desktop/build/icon.icns               the same render as a macOS icon set (used when actool < 26)
  apps/desktop/resources/tray-16.png, tray-16@2x.png, tray-32.png
                                             menu bar template images: the face as a black silhouette
Run: ./venv/bin/python scripts/desktop/make-icons.py
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / "apps/desktop"
SOURCE = DESKTOP / "build/Hexbot.icon"
SIZE = 1024
SUPERSAMPLE = 4


def layers() -> list[tuple[Image.Image, float]]:
    """Bottom-to-top layers as (image, scale). icon.json lists them top first."""
    spec = json.loads((SOURCE / "icon.json").read_text())
    result = []
    for group in reversed(spec["groups"]):
        for layer in reversed(group["layers"]):
            image = Image.open(SOURCE / "Assets" / layer["image-name"]).convert("RGBA")
            result.append((image, float(layer["position"]["scale"])))
    return result


def place(canvas: Image.Image, image: Image.Image, scale: float) -> None:
    """Fit the layer image to the canvas, then apply the layer's own scale."""
    side = round(canvas.width * scale)
    resized = image.resize((side, side), Image.LANCZOS)
    offset = (canvas.width - side) // 2
    canvas.alpha_composite(resized, (offset, offset))


def squircle(size: int, inset: float, radius: float, fill) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    box = [size * inset, size * inset, size * (1 - inset), size * (1 - inset)]
    ImageDraw.Draw(image).rounded_rectangle(box, radius=size * radius, fill=fill)
    return image


def app_icon() -> Image.Image:
    """The macOS icon grid: an 824/1024 rounded square with the face on it."""
    size = SIZE * SUPERSAMPLE
    inset, radius = 100 / 1024, 0.2237 * 824 / 1024
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    shadow = squircle(size, inset, radius, (0, 0, 0, 70))
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.012))
    canvas.alpha_composite(shadow, (0, round(size * 0.01)))

    mask = squircle(size, inset, radius, (255, 255, 255, 255)).getchannel("A")
    gradient = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(gradient)
    for y in range(size):
        t = y / size
        tone = round(255 - 22 * t)
        draw.line([(0, y), (size, y)], fill=(tone, tone, tone + min(3, 255 - tone), 255))
    canvas.paste(gradient, (0, 0), mask)

    face = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    for image, scale in layers():
        place(face, image, scale)
    canvas.alpha_composite(face)
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def tray_icon(size: int) -> Image.Image:
    """Black face silhouette with the eyes cut out, for template rendering."""
    big = SIZE
    hexagon, eyes = Image.new("RGBA", (big, big)), Image.new("RGBA", (big, big))
    bottom, *top = layers()
    place(hexagon, *bottom)
    for image, scale in top:
        place(eyes, image, scale)
    alpha = hexagon.getchannel("A")
    cut = eyes.getchannel("A")
    alpha = ImageChops.subtract(alpha, cut)
    silhouette = Image.new("RGBA", (big, big), (0, 0, 0, 255))
    silhouette.putalpha(alpha)
    silhouette = silhouette.crop(silhouette.getbbox())
    margin = max(1, round(size / 16))
    fit = size - 2 * margin
    scale = fit / max(silhouette.size)
    resized = silhouette.resize(
        (max(1, round(silhouette.width * scale)), max(1, round(silhouette.height * scale))),
        Image.LANCZOS,
    )
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.alpha_composite(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return out


def write_icns(master: Image.Image, target: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for points in (16, 32, 128, 256, 512):
            for factor in (1, 2):
                px = points * factor
                name = f"icon_{points}x{points}{'@2x' if factor == 2 else ''}.png"
                master.resize((px, px), Image.LANCZOS).save(iconset / name)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(target)], check=True)


def main() -> None:
    icon = app_icon()
    icon.save(DESKTOP / "build/icon.png")
    write_icns(icon, DESKTOP / "build/icon.icns")
    resources = DESKTOP / "resources"
    tray_icon(16).save(resources / "tray-16.png")
    tray_icon(32).save(resources / "tray-16@2x.png")
    tray_icon(32).save(resources / "tray-32.png")
    print("Wrote icon.png, icon.icns, and the tray images")


if __name__ == "__main__":
    main()
