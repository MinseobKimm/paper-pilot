import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

spec = importlib.util.spec_from_file_location("retrieval", Path(__file__).with_name("paperqa_sparse_retrieve.py"))
retrieval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retrieval)


class RetrievalTests(unittest.TestCase):
    def test_dependency_failure_still_returns_page_grounded_evidence(self):
        with tempfile.TemporaryDirectory(prefix="paper pilot 한글 ") as directory:
            root = Path(directory)
            request = root / "input.json"
            response = root / "output.json"
            request.write_text(json.dumps({
                "documentId": "test", "queries": ["experience replay"],
                "pages": [{"pageNumber": 7, "text": "Experience replay reuses stored transitions."}],
                "cacheDir": str(root / "cache"),
            }))
            with patch("sys.argv", ["retrieval", "--input", str(request), "--output", str(response)]), \
                 patch.object(retrieval, "paperqa_available", return_value=True), \
                 patch.object(retrieval, "try_paperqa2_sparse", new=AsyncMock(side_effect=RuntimeError("unavailable"))):
                self.assertEqual(retrieval.main(), 0)
            result = json.loads(response.read_text())
            self.assertEqual(result["engine"], "local-sparse-compatible")
            self.assertEqual(result["evidence"][0]["pageNumber"], 7)
            self.assertTrue(result["warnings"])

    def test_cache_round_trip_preserves_unicode_and_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            pages = [{"pageNumber": 3, "text": "한국어 설명. Experience replay improves efficiency."}]
            first, reused, key = retrieval.load_or_build_chunks(pages, Path(directory), "논문", 1100, 220)
            second, reused_again, next_key = retrieval.load_or_build_chunks(pages, Path(directory), "논문", 1100, 220)
            self.assertFalse(reused)
            self.assertTrue(reused_again)
            self.assertEqual(first, second)
            self.assertEqual(key, next_key)
            self.assertEqual(first[0]["pageNumber"], 3)


if __name__ == "__main__":
    unittest.main()
