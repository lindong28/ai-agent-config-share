import tempfile
import unittest
from pathlib import Path

from cache import MtimeCache


class CacheTests(unittest.TestCase):
    def test_first_load_parses_all_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self.write(root / "a.jsonl", "a1")
            b = self.write(root / "b.jsonl", "b1")
            calls = []
            cache = MtimeCache(lambda: [a, b], lambda path: calls.append(Path(path).name) or [Path(path).name])

            self.assertEqual(cache.load(), ["a.jsonl", "b.jsonl"])
            self.assertEqual(calls, ["a.jsonl", "b.jsonl"])

    def test_second_load_without_changes_reuses_cached_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self.write(root / "a.jsonl", "a1")
            calls = []
            cache = MtimeCache(lambda: [a], lambda path: calls.append(Path(path).name) or [Path(path).name])

            cache.load()
            cache.load()

            self.assertEqual(calls, ["a.jsonl"])

    def test_touch_one_file_only_reparses_that_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self.write(root / "a.jsonl", "a1")
            b = self.write(root / "b.jsonl", "b1")
            calls = []
            cache = MtimeCache(lambda: [a, b], lambda path: calls.append(Path(path).name) or [Path(path).read_text()])

            cache.load()
            self.write(b, "b2")
            result = cache.load()

            self.assertEqual(calls, ["a.jsonl", "b.jsonl", "b.jsonl"])
            self.assertEqual(result, ["a1", "b2"])

    @staticmethod
    def write(path: Path, text: str) -> Path:
        path.write_text(text, encoding="utf-8")
        return path


if __name__ == "__main__":
    unittest.main()
