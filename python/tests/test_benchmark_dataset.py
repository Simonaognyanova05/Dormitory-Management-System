import hashlib
import io
import sys
import unittest
from pathlib import Path

import pymupdf
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from generate_benchmark_dataset import build_dataset, certificate_pdf, ROMAN


class BenchmarkDatasetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files, cls.manifest = build_dataset()

    def test_has_twelve_distinct_annotated_bulgarian_samples(self):
        self.assertTrue(self.manifest['synthetic'])
        self.assertEqual(self.manifest['language'], 'bg')
        self.assertEqual(len(self.manifest['documents']), 12)
        self.assertEqual(len({item['expectedFields']['facultyNumber'] for item in self.manifest['documents']}), 12)
        self.assertEqual(len({hashlib.sha256(self.files[item['file']]).hexdigest() for item in self.manifest['documents']}), 12)
        self.assertEqual(sum(value is None for item in self.manifest['documents'] for value in item['expectedFields'].values()), 2)

    def test_source_text_matches_ground_truth_and_missing_labels_are_genuinely_absent(self):
        font = pymupdf.Font('cjk')
        for item in self.manifest['documents']:
            expected = item['expectedFields']
            with pymupdf.open(stream=certificate_pdf(expected, font), filetype='pdf') as document:
                text = ' '.join(document[0].get_text().split())
            self.assertIn(expected['fullName'], text)
            self.assertIn(expected['facultyNumber'], text)
            if expected['specialty'] is None: self.assertNotIn('Специалност:', text)
            else: self.assertIn(expected['specialty'], text)
            if expected['yearOfStudy'] is None: self.assertNotIn('Курс:', text)
            else: self.assertIn('Курс: ' + ROMAN[expected['yearOfStudy']], text)
            self.assertIn('2026/2027', text)  # Academic year must not become course.

    def test_pdf_and_image_variants_are_readable_files_within_admission_limits(self):
        for item in self.manifest['documents']:
            with self.subTest(quality=item['quality']):
                content = self.files[item['file']]
                self.assertLessEqual(len(content), 10 * 1024 * 1024)
                if item['mimeType'] == 'application/pdf':
                    with pymupdf.open(stream=content, filetype='pdf') as document:
                        self.assertEqual(document.page_count, 2 if item['quality'] == 'two_page_pdf' else 1)
                        if item['quality'] == 'scanned_pdf': self.assertEqual(document[0].get_text().strip(), '')
                        else: self.assertIn(item['expectedFields']['fullName'], document[0].get_text())
                else:
                    with Image.open(io.BytesIO(content)) as image:
                        image.load()
                        self.assertLessEqual(image.width * image.height, 20_000_000)
                        if item['quality'] == 'exif_rotation': self.assertEqual(image.getexif().get(274), 6)


if __name__ == '__main__':
    unittest.main()
