"""In-memory PNG coordinate rulers and local image comparison; no device access."""
import base64
import io
import json
import math
import os
from pathlib import Path
import sys

if len(sys.argv) > 1:
    sys.path.insert(0, sys.argv[1])
from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat

MAX_PIXELS = 640000
MAX_EDGE = 1280
MAX_BYTES = 1024 * 1024
MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_INPUT_PIXELS = 32000000
MIN_EDGE = 120
Image.MAX_IMAGE_PIXELS = MAX_INPUT_PIXELS


def fail(code):
    raise ValueError(code)


def read_image(data):
    if not isinstance(data, str) or len(data) > 24 * 1024 * 1024:
        fail('visual_image')
    try:
        raw = base64.b64decode(data, validate=True)
        if len(raw) > MAX_INPUT_BYTES or not raw.startswith(b'\x89PNG\r\n\x1a\n'):
            fail('visual_image')
        with Image.open(io.BytesIO(raw)) as source:
            if source.format != 'PNG' or source.width * source.height > MAX_INPUT_PIXELS:
                fail('visual_image')
            return source.convert('RGB')
    except Exception:
        fail('visual_image')


def checked_region(region, size):
    if region is None:
        return {'x': 0, 'y': 0, 'width': size[0], 'height': size[1]}
    if (not isinstance(region, dict) or set(region) != {'x', 'y', 'width', 'height'}
            or any(type(value) is not int for value in region.values())
            or min(region['x'], region['y']) < 0 or min(region['width'], region['height']) < 1
            or region['x'] + region['width'] > size[0] or region['y'] + region['height'] > size[1]):
        fail('visual_region')
    return dict(region)


def checked_point(point, region, required=False):
    if point is None and not required:
        return None
    if (not isinstance(point, dict) or set(point) != {'x', 'y'}
            or any(type(value) is not int for value in point.values())
            or not region['x'] <= point['x'] < region['x'] + region['width']
            or not region['y'] <= point['y'] < region['y'] + region['height']):
        fail('visual_point')
    return dict(point)


def ruler_font(size):
    fonts = [Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts' / 'consolab.ttf',
             'DejaVuSansMono-Bold.ttf']
    for font in fonts:
        try:
            return ImageFont.truetype(str(font), size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def overlay(source, size, region, point):
    image = source.resize(size, Image.Resampling.LANCZOS) if source.size != size else source.copy()
    width, height = size
    draw = ImageDraw.Draw(image, 'RGBA')
    font = ruler_font(max(6, min(14, min(width, height) // 36)))
    line_color, shadow = (0, 208, 245, 100), (0, 0, 0, 55)
    for tick in range(0, 1001, 100):
        x = min(width - 1, round(tick * width / 1000))
        y = min(height - 1, round(tick * height / 1000))
        draw.line((min(x + 1, width - 1), 0, min(x + 1, width - 1), height - 1), fill=shadow)
        draw.line((0, min(y + 1, height - 1), width - 1, min(y + 1, height - 1)), fill=shadow)
        draw.line((x, 0, x, height - 1), fill=line_color)
        draw.line((0, y, width - 1, y), fill=line_color)

    def label(text, x, y):
        box = draw.textbbox((0, 0), text, font=font)
        tw, th = box[2] - box[0], box[3] - box[1]
        x, y = max(1, min(width - tw - 3, round(x))), max(1, min(height - th - 3, round(y)))
        draw.rectangle((x - 1, y - 1, x + tw + 1, y + th + 1), fill=(0, 0, 0, 210))
        draw.text((x - box[0], y - box[1]), text, font=font, fill=(255, 255, 255, 255))
        return tw, th

    sample = draw.textbbox((0, 0), '1000', font=font)
    label_height = sample[3] - sample[1]
    for tick in range(0, 1001, 100):
        text = str(tick)
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        x, y = min(width - 1, round(tick * width / 1000)), min(height - 1, round(tick * height / 1000))
        label(text, x - tw / 2, 2)
        label(text, x - tw / 2, height - label_height - 2)
        # Vertical endpoint labels sit just inside the horizontal ruler row.
        side_y = max(label_height + 5, min(height - 2 * label_height - 7, y - label_height / 2))
        label(text, 2, side_y)
        label(text, width - tw - 2, side_y)
    if point is not None:
        cx = min(width - 1, round((point['x'] - region['x']) * width / region['width']))
        cy = min(height - 1, round((point['y'] - region['y']) * height / region['height']))
        # Hollow center: the highlighted point remains visible beneath the ring.
        for color, stroke, radius in [((0, 0, 0, 255), 5, 11), ((255, 255, 255, 255), 3, 11), ((255, 0, 125, 255), 2, 11)]:
            draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), outline=color, width=stroke)
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            segment = (cx + dx * 16, cy + dy * 16, cx + dx * 27, cy + dy * 27)
            draw.line(segment, fill=(255, 255, 255, 255), width=5)
            draw.line(segment, fill=(255, 0, 125, 255), width=3)
    return image


def render(request):
    image = read_image(request.get('png'))
    region = checked_region(request.get('region'), image.size)
    point = checked_point(request.get('point'), region)
    cropped = image.crop((region['x'], region['y'], region['x'] + region['width'], region['y'] + region['height']))
    scale = min(2 if request.get('region') is not None else 1,
                math.sqrt(MAX_PIXELS / (cropped.width * cropped.height)), MAX_EDGE / max(cropped.size))
    width, height = max(1, math.floor(cropped.width * scale)), max(1, math.floor(cropped.height * scale))
    for _ in range(12):
        if min(width, height) < MIN_EDGE:
            fail('visual_region_small')
        output = io.BytesIO()
        overlay(cropped, (width, height), region, point).save(output, format='PNG', optimize=True)
        data = output.getvalue()
        if len(data) <= MAX_BYTES:
            return {'image': {'mimeType': 'image/png', 'data': base64.b64encode(data).decode('ascii')},
                    'view': {'width': width, 'height': height, 'region': region,
                             'coordinateSpace': 'view_normalized_1000'}}
        shrink = min(.9, math.sqrt(MAX_BYTES / len(data)) * .94)
        width, height = max(1, math.floor(width * shrink)), max(1, math.floor(height * shrink))
    fail('visual_budget')


def compare(request):
    before, after = read_image(request.get('before')), read_image(request.get('after'))
    region = checked_region(None, before.size)
    point = checked_point(request.get('point'), region, required=True)
    if before.size != after.size:
        return {'sameDimensions': False, 'changed': True, 'difference': None}
    def local_difference(radius):
        area = (max(0, point['x'] - radius), max(0, point['y'] - radius),
                min(before.width, point['x'] + radius), min(before.height, point['y'] + radius))
        delta = ImageChops.difference(before.crop(area), after.crop(area))
        mean = sum(ImageStat.Stat(delta).mean) / (3 * 255)
        maximum = ImageChops.lighter(ImageChops.lighter(delta.getchannel('R'), delta.getchannel('G')), delta.getchannel('B'))
        hist = maximum.histogram()
        return mean, sum(hist[24:]) / (delta.width * delta.height)

    mean, fraction = local_difference(80)
    center_mean, center_fraction = local_difference(16)
    # A small icon can disappear without changing much of the surrounding panel.
    # Both tests remain pixel heuristics, not proof that the intended target is unchanged.
    changed = (fraction >= .03 and mean >= .012) or (center_fraction >= .05 and center_mean >= .02)
    return {'sameDimensions': True, 'changed': changed, 'difference': round(mean, 6)}


def main():
    limit = 48 * 1024 * 1024
    while True:
        line = sys.stdin.buffer.readline(limit + 1)
        if not line:
            break
        if len(line) > limit:
            break
        request = {}
        try:
            request = json.loads(line)
            action = request.get('action')
            if action not in ('render', 'compare'):
                fail('visual_process')
            value = render(request) if action == 'render' else compare(request)
            result = {'id': request.get('id'), 'ok': True, 'value': value}
        except Exception as error:
            code = str(error) if isinstance(error, ValueError) and str(error).startswith('visual_') else 'visual_process'
            result = {'id': request.get('id') if isinstance(request, dict) else None, 'ok': False, 'code': code}
        print(json.dumps(result, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
