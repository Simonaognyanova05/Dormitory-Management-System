import io
import json
import sys
import unittest
from pathlib import Path

import pymupdf
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from generate_order_demo import build_demo


class OrderDemoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = build_demo()

    def test_actual_source_distinguishes_order_date_from_placement_start(self):
        expected = json.loads(self.files['expected-fields.json'])
        self.assertEqual(expected, {'orderNumber': 'РД-001', 'orderDate': '2026-11-03', 'dormitory': '01', 'room': '012А'})
        with pymupdf.open(stream=self.files['placement-order.pdf'], filetype='pdf') as document:
            text = document[0].get_text()
            self.assertEqual(document.page_count, 1)
        for value in ('РД-001', '3.11.2026', '01', '012А', '10.11.2026'):
            self.assertIn(value, text)
        self.assertIn('Дата на заповедта', text)
        self.assertIn('Начална дата на настаняване', text)

    def test_all_demo_formats_fit_file_and_pixel_limits(self):
        for filename in ('placement-order.pdf', 'placement-order.png', 'placement-order.jpg'):
            self.assertLessEqual(len(self.files[filename]), 10 * 1024 * 1024)
        for filename in ('placement-order.png', 'placement-order.jpg'):
            with Image.open(io.BytesIO(self.files[filename])) as image:
                image.load()
                self.assertLessEqual(image.width * image.height, 20_000_000)
                self.assertEqual(image.mode, 'RGB')


if __name__ == '__main__':
    unittest.main()
