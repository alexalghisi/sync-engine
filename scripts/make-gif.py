"""Composes frames from capture-preview.ts into the README GIF.

    python3 scripts/make-gif.py <frames-dir> docs/preview.gif

Needs Pillow. Each frame puts tab A and tab B side by side under a caption, then the
whole sequence is quantized to one shared palette to keep the file small.
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SCALE = 0.8
GAP = 14
MARGIN = 14
CAPTION_HEIGHT = 46
LABEL_HEIGHT = 24
BACKGROUND = (10, 11, 13)
TEXT = (227, 228, 232)
MUTED = (138, 143, 152)

FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def font(size: int) -> ImageFont.ImageFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def compose(a: Image.Image, b: Image.Image, caption: str) -> Image.Image:
    a = a.convert("RGB").resize((int(a.width * SCALE), int(a.height * SCALE)), Image.LANCZOS)
    b = b.convert("RGB").resize((int(b.width * SCALE), int(b.height * SCALE)), Image.LANCZOS)
    width = MARGIN * 2 + a.width + GAP + b.width
    height = CAPTION_HEIGHT + LABEL_HEIGHT + a.height + MARGIN
    canvas = Image.new("RGB", (width, height), BACKGROUND)
    draw = ImageDraw.Draw(canvas)
    draw.text((MARGIN, 13), caption, fill=TEXT, font=font(19))
    top = CAPTION_HEIGHT + LABEL_HEIGHT
    for label, image, left in (("Tab A", a, MARGIN), ("Tab B", b, MARGIN + a.width + GAP)):
        draw.text((left, CAPTION_HEIGHT + 2), label, fill=MUTED, font=font(14))
        canvas.paste(image, (left, top))
        draw.rectangle((left - 1, top - 1, left + image.width, top + image.height), outline=(37, 39, 45))
    return canvas


def main() -> None:
    frames_dir, output = Path(sys.argv[1]), Path(sys.argv[2])
    manifest = json.loads((frames_dir / "manifest.json").read_text())
    composed = [compose(Image.open(f["a"]), Image.open(f["b"]), f["caption"]) for f in manifest]

    # One adaptive palette for the whole animation avoids colour flicker between frames.
    sheet = Image.new("RGB", (composed[0].width, composed[0].height * min(len(composed), 6)))
    step = max(1, len(composed) // 6)
    for i, frame in enumerate(composed[::step][:6]):
        sheet.paste(frame, (0, i * frame.height))
    palette = sheet.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    quantized = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in composed]

    output.parent.mkdir(parents=True, exist_ok=True)
    quantized[0].save(
        output,
        save_all=True,
        append_images=quantized[1:],
        duration=[f["durationMs"] for f in manifest],
        loop=0,
        optimize=True,
        disposal=1,
    )
    print(f"{output}: {len(quantized)} frames, {output.stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
