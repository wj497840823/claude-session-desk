"""Generate build/icon.png, build/tray.png and build/splash.bmp.

Requires Python 3 with Pillow:  pip install pillow
The Windows fonts below are preferred; missing fonts fall back to Pillow's
built-in default so the script still produces valid assets elsewhere.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
BUILD.mkdir(parents=True, exist_ok=True)

SIZE = 1024
TOP = (59, 130, 246)
BOTTOM = (29, 78, 216)
BLUE = (37, 99, 235)
CYAN = (34, 211, 238)
INK = (15, 23, 42)
CARD = (248, 250, 252)


def load_font(size: int, bold: bool = False, chinese: bool = False) -> ImageFont.FreeTypeFont:
    names = []
    if chinese:
        names = ["msyhbd.ttc" if bold else "msyh.ttc", "simhei.ttf"]
    else:
        names = ["segoeuib.ttf" if bold else "segoeui.ttf", "arialbd.ttf" if bold else "arial.ttf"]
    for name in names:
        path = Path("C:/Windows/Fonts") / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(image)
    for y in range(size):
        t = y / (size - 1)
        color = tuple(round(top[i] * (1 - t) + bottom[i] * t) for i in range(3))
        draw.line([(0, y), (size, y)], fill=color)
    return image


def squircle_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def app_icon() -> Image.Image:
    image = gradient(SIZE, TOP, BOTTOM)
    highlight = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(highlight).ellipse(
        [-SIZE * 0.25, -SIZE * 0.55, SIZE * 1.25, SIZE * 0.55], fill=44
    )
    image = Image.composite(
        Image.new("RGB", (SIZE, SIZE), (255, 255, 255)),
        image,
        highlight.point(lambda value: int(value * 0.22)),
    )
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(image, (0, 0), squircle_mask(SIZE, 224))

    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [218, 286, 806, 734], radius=96, fill=(8, 18, 40, 90)
    )
    icon.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(28)))

    draw = ImageDraw.Draw(icon)
    draw.rounded_rectangle([206, 266, 818, 712], radius=92, fill=CARD)
    draw.polygon([(300, 700), (300, 826), (452, 700)], fill=CARD)

    # Terminal prompt: >_
    width = 54
    x, y, w, h = 344, 402, 230, 170
    draw.line([(x, y), (x + w * 0.62, y + h / 2), (x, y + h)], fill=INK, width=width, joint="curve")
    for point in [(x, y), (x + w * 0.62, y + h / 2), (x, y + h)]:
        draw.ellipse(
            [point[0] - width / 2, point[1] - width / 2, point[0] + width / 2, point[1] + width / 2],
            fill=INK,
        )
    draw.rounded_rectangle(
        [x + w * 0.78, y + h - 34, x + w * 1.55, y + h], radius=17, fill=CYAN
    )
    return icon


def tray_icon() -> Image.Image:
    size = 64
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([1, 1, size - 2, size - 2], radius=15, fill=BLUE)
    # Larger relative prompt keeps the mark readable at 16px.
    width = 5
    x, y, w, h = 17, 22, 17, 20
    draw.line([(x, y), (x + w * 0.6, y + h / 2), (x, y + h)], fill=CARD, width=width, joint="curve")
    for point in [(x, y), (x + w * 0.6, y + h / 2), (x, y + h)]:
        draw.ellipse(
            [point[0] - width / 2, point[1] - width / 2, point[0] + width / 2, point[1] + width / 2],
            fill=CARD,
        )
    draw.rounded_rectangle([x + w * 0.8, y + h - 3, x + w * 1.6, y + h], radius=2, fill=CYAN)
    return image


def attention_badges() -> None:
    directory = BUILD / "badges"
    directory.mkdir(parents=True, exist_ok=True)
    for prefix, color in (("done", (16, 185, 129)), ("attention", (245, 158, 11))):
        for count in list(range(1, 10)) + ["9plus"]:
            size = 32
            image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            draw = ImageDraw.Draw(image)
            draw.ellipse([1, 1, size - 2, size - 2], fill=(255, 255, 255, 255))
            draw.ellipse([3, 3, size - 4, size - 4], fill=color)
            text = "9+" if count == "9plus" else str(count)
            font = load_font(13 if count == "9plus" else 18, bold=True)
            box = draw.textbbox((0, 0), text, font=font)
            x = (size - (box[2] - box[0])) / 2 - box[0]
            y = (size - (box[3] - box[1])) / 2 - box[1] - 1
            draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))
            image.save(directory / f"{prefix}-{count}.png", "PNG")


def splash(icon: Image.Image) -> Image.Image:
    width, height = 640, 360
    image = Image.new("RGB", (width, height), (15, 23, 42))
    glow = Image.new("L", (width, height), 0)
    ImageDraw.Draw(glow).ellipse([-220, -180, 420, 420], fill=120)
    glow = glow.filter(ImageFilter.GaussianBlur(70))
    image = Image.composite(Image.new("RGB", (width, height), (30, 58, 138)), image, glow)

    icon_small = icon.resize((96, 96), Image.LANCZOS)
    image.paste(icon_small, (48, 66), icon_small)
    draw = ImageDraw.Draw(image)
    draw.text((168, 78), "Claude Session Desk", font=load_font(34, bold=True), fill=(248, 250, 252))
    draw.text((170, 126), "会话工作台", font=load_font(18, chinese=True), fill=(203, 213, 225))
    draw.rounded_rectangle([170, 162, 240, 165], radius=2, fill=(34, 211, 238))
    draw.text(
        (50, 300),
        "正在解压并启动，请稍候…",
        font=load_font(14, chinese=True),
        fill=(148, 163, 184),
    )
    return image


def main() -> None:
    icon = app_icon()
    icon.save(BUILD / "icon.png", "PNG")
    tray_icon().save(BUILD / "tray.png", "PNG")
    attention_badges()
    splash(icon).save(BUILD / "splash.bmp", "BMP")
    print(BUILD / "icon.png")
    print(BUILD / "tray.png")
    print(BUILD / "badges")
    print(BUILD / "splash.bmp")


if __name__ == "__main__":
    main()