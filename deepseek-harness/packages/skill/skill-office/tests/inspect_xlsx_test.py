"""Workbook profiler coverage without a model or external spreadsheet engine."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from openpyxl import Workbook

SPEC = importlib.util.spec_from_file_location(
    "inspect_xlsx", Path(__file__).parents[1] / "assets/scripts/inspect_xlsx.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class InspectWorkbookTests(unittest.TestCase):
    def test_counts_formulas_without_exposing_them_or_claiming_cached_results(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "电费.xlsx"
            workbook = Workbook()
            workbook.active.append(["成本中心", "产量", "电量"])
            workbook.active.append(["装配 ", 2, "=B2*3"])
            workbook.active.append(["辅助设施", None, "#DIV/0!"])
            workbook.save(path)
            before = path.read_bytes()
            report = MODULE.inspect(path)
            sheet = report["sheets"][0]
            self.assertTrue(sheet["scan_complete"])
            self.assertEqual(sheet["formula_cells"], 1)
            self.assertEqual(sheet["missing_formula_cache"], 1)
            self.assertEqual(sheet["error_cells"], 1)
            self.assertEqual(sheet["samples"][0], ["装配 ", 2, None])
            self.assertNotIn("=B2*3", json.dumps(report))
            self.assertEqual(path.read_bytes(), before)

    def test_scan_limits_and_output_omissions_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "wide.xlsx"
            workbook = Workbook()
            for _ in range(6):
                workbook.active.append(["长表头" * 100] * 20)
            workbook.create_sheet("Not scanned")
            workbook.save(path)
            report = MODULE.inspect(path, max_sheets=1, max_rows=2, max_cols=3)
            self.assertFalse(report["sheets"][0]["scan_complete"])
            self.assertEqual(report["omitted_sheets"], 1)
            self.assertEqual(report["sheets"][0]["nonempty_cells"], 6)
            output = MODULE.bounded_json(report, 512)
            self.assertLessEqual(len(output) + 1, 512)
            self.assertTrue(json.loads(output)["output_truncated"])


if __name__ == "__main__":
    unittest.main()
