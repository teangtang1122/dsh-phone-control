"""Offline PNG rendering checks; no screenshots or device input."""
import base64
import importlib.util
import io
from pathlib import Path
import random
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / '.phone-python-deps'))
from PIL import Image, ImageDraw, PngImagePlugin
spec = importlib.util.spec_from_file_location('phone_visual_test', ROOT / 'scripts' / 'phone-visual.py')
V = importlib.util.module_from_spec(spec)
spec.loader.exec_module(V)


def png(image, **options):
    stream = io.BytesIO()
    image.save(stream, format='PNG', **options)
    return base64.b64encode(stream.getvalue()).decode('ascii')


def decoded(result):
    return Image.open(io.BytesIO(base64.b64decode(result['image']['data']))).convert('RGB')


class PhoneVisual(unittest.TestCase):
    def test_full_frame_has_no_padding_and_respects_pixel_budget(self):
        source = Image.new('RGB', (1080, 2400), (80, 90, 110))
        result = V.render({'png': png(source)})
        view = result['view']
        self.assertEqual(view['region'], {'x': 0, 'y': 0, 'width': 1080, 'height': 2400})
        self.assertEqual(view['coordinateSpace'], 'view_normalized_1000')
        self.assertLessEqual(view['width'] * view['height'], 640000)
        self.assertLessEqual(max(view['width'], view['height']), 1280)
        self.assertEqual(decoded(result).size, (view['width'], view['height']))
        self.assertAlmostEqual(view['width'] / view['height'], source.width / source.height, delta=.002)
        self.assertEqual(decoded(result).getpixel((view['width'] // 3, view['height'] // 3)), (80, 90, 110))

    def test_crop_enlarges_at_most_twice_without_counting_any_margin(self):
        source = Image.new('RGB', (1080, 2400), 'white')
        region = {'x': 101, 'y': 203, 'width': 300, 'height': 420}
        result = V.render({'png': png(source), 'region': region})
        self.assertEqual(result['view'], {'width': 600, 'height': 840, 'region': region,
                                         'coordinateSpace': 'view_normalized_1000'})

    def test_noisy_rgb_png_stays_within_encoded_byte_limit(self):
        source = Image.frombytes('RGB', (1600, 1600), random.Random(7).randbytes(1600 * 1600 * 3))
        result = V.render({'png': png(source)})
        self.assertLessEqual(len(base64.b64decode(result['image']['data'])), 1048576)
        self.assertLessEqual(result['view']['width'] * result['view']['height'], 640000)

    def test_crosshair_marks_mapped_point_without_covering_its_center(self):
        source = Image.new('RGB', (640, 480), (50, 100, 150))
        region = {'x': 80, 'y': 90, 'width': 240, 'height': 240}
        common = {'png': png(source), 'region': region}
        plain = decoded(V.render(common))
        marked = decoded(V.render({**common, 'point': {'x': 187, 'y': 211}}))
        cx, cy = 214, 242
        self.assertEqual(plain.crop((cx - 4, cy - 4, cx + 5, cy + 5)).tobytes(),
                         marked.crop((cx - 4, cy - 4, cx + 5, cy + 5)).tobytes())
        self.assertNotEqual(plain.crop((cx - 29, cy - 29, cx + 30, cy + 30)).tobytes(),
                            marked.crop((cx - 29, cy - 29, cx + 30, cy + 30)).tobytes())
        self.assertEqual(marked.getpixel((cx + 22, cy)), (255, 0, 125))

    def test_invalid_crop_or_point_is_rejected_explicitly(self):
        encoded = png(Image.new('RGB', (300, 400), 'white'))
        for region in [{'x': 250, 'y': 0, 'width': 100, 'height': 100},
                       {'x': True, 'y': 0, 'width': 100, 'height': 100}]:
            with self.assertRaisesRegex(ValueError, 'visual_region'):
                V.render({'png': encoded, 'region': region})
        with self.assertRaisesRegex(ValueError, 'visual_region_small'):
            V.render({'png': encoded, 'region': {'x': 0, 'y': 0, 'width': 20, 'height': 30}})
        with self.assertRaisesRegex(ValueError, 'visual_point'):
            V.render({'png': encoded, 'region': {'x': 0, 'y': 0, 'width': 100, 'height': 100}, 'point': {'x': 101, 'y': 50}})

    def test_same_pixels_with_different_png_metadata_are_unchanged(self):
        source = Image.new('RGB', (300, 400), 'white')
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text('fixture', 'different encoding, same pixels')
        before, after = png(source), png(source, pnginfo=metadata, compress_level=0)
        self.assertNotEqual(before, after)
        result = V.compare({'before': before, 'after': after, 'point': {'x': 150, 'y': 200}})
        self.assertEqual(result, {'sameDimensions': True, 'changed': False, 'difference': 0})

    def test_comparison_is_local_and_requires_visible_change(self):
        source = Image.new('RGB', (500, 600), 'white')
        local = source.copy()
        ImageDraw.Draw(local).rectangle((230, 280, 270, 320), fill='black')
        changed = V.compare({'before': png(source), 'after': png(local), 'point': {'x': 250, 'y': 300}})
        self.assertTrue(changed['changed'])
        self.assertGreater(changed['difference'], .05)
        remote = source.copy()
        ImageDraw.Draw(remote).rectangle((0, 0, 100, 100), fill='black')
        self.assertFalse(V.compare({'before': png(source), 'after': png(remote), 'point': {'x': 250, 'y': 300}})['changed'])
        minor = Image.new('RGB', source.size, (254, 254, 254))
        self.assertFalse(V.compare({'before': png(source), 'after': png(minor), 'point': {'x': 250, 'y': 300}})['changed'])

    def test_small_icon_disappearing_at_point_is_changed_even_with_small_panel_difference(self):
        after = Image.new('RGB', (500, 600), 'white')
        before = after.copy()
        ImageDraw.Draw(before).rectangle((245, 295, 254, 304), fill='black')
        result = V.compare({'before': png(before), 'after': png(after), 'point': {'x': 250, 'y': 300}})
        self.assertTrue(result['sameDimensions'])
        self.assertTrue(result['changed'])
        # The reported metric still describes the original 160x160 area.
        self.assertAlmostEqual(result['difference'], 100 / (160 * 160), places=6)
        self.assertLess(result['difference'], .012)

    def test_small_icon_change_at_screen_corner_uses_clamped_center_region(self):
        after = Image.new('RGB', (500, 600), 'white')
        before = after.copy()
        ImageDraw.Draw(before).rectangle((0, 0, 9, 9), fill='black')
        result = V.compare({'before': png(before), 'after': png(after), 'point': {'x': 0, 'y': 0}})
        self.assertTrue(result['changed'])

    def test_small_change_away_from_point_does_not_trigger_center_detection(self):
        before = Image.new('RGB', (500, 600), 'white')
        after = before.copy()
        ImageDraw.Draw(after).rectangle((300, 295, 309, 304), fill='black')
        result = V.compare({'before': png(before), 'after': png(after), 'point': {'x': 250, 'y': 300}})
        self.assertFalse(result['changed'])
        self.assertGreater(result['difference'], 0)

    def test_low_amplitude_pixel_noise_does_not_trigger_center_detection(self):
        before = Image.new('RGB', (300, 400), (127, 127, 127))
        rng = random.Random(19)
        after = Image.frombytes('RGB', before.size, bytes(127 + rng.randint(-4, 4) for _ in range(300 * 400 * 3)))
        result = V.compare({'before': png(before), 'after': png(after), 'point': {'x': 150, 'y': 200}})
        self.assertFalse(result['changed'])
        self.assertGreater(result['difference'], 0)

    def test_dimension_change_is_reported_without_comparing_wrong_coordinates(self):
        result = V.compare({'before': png(Image.new('RGB', (300, 400))),
                            'after': png(Image.new('RGB', (400, 300))), 'point': {'x': 150, 'y': 200}})
        self.assertEqual(result, {'sameDimensions': False, 'changed': True, 'difference': None})


if __name__ == '__main__':
    unittest.main()
