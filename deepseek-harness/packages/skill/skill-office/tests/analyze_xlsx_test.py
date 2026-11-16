"""Generic analysis and retry behavior on unrelated tabular datasets."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from openpyxl import Workbook, load_workbook

SPEC = importlib.util.spec_from_file_location(
    "analyze_xlsx", Path(__file__).parents[1] / "assets/scripts/analyze_xlsx.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "orders.xlsx"
        workbook = Workbook()
        workbook.active.title = "Orders"
        for row in [("Region", "Units", "Revenue"), ("North ", 2, 10),
                    ("North", 8, 24), ("South", 0, 7), ("Unknown", None, None)]:
            workbook.active.append(row)
        workbook.save(self.source)
        self.config = {
            "inputs": [{"id": "orders", "path": "orders.xlsx", "sheet": "Orders",
                        "normalize_keys": ["Region"]}],
            "output": "report.xlsx",
            "reports": [{"id": "summary", "source": "orders", "sheet": "Summary",
                         "group_by": ["Region"],
                         "aggregates": [{"column": "Units", "op": "sum", "as": "Units"},
                                        {"column": "Revenue", "op": "sum", "as": "Revenue"}],
                         "ratios": [{"numerator": "Revenue", "denominator": "Units", "as": "Rate"}],
                         "charts": [{"type": "bar", "title": "Revenue", "category": "Region", "values": ["Revenue"]}]}],
        }
        self.config_path = self.root / "analysis.json"

    def run_analysis(self):
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        return MODULE.run(self.config_path)

    def test_grouped_weighted_ratio_chart_and_hash_checked_reuse(self):
        original = self.source.read_bytes()
        self.assertEqual(self.run_analysis()["status"], "created")
        workbook = load_workbook(self.root / "report.xlsx")
        try:
            sheet = workbook["Summary"]
            self.assertEqual(list(sheet.values)[1], ("North", 10, 34, 3.4))
            self.assertIsNone(sheet["D3"].value)
            self.assertIsNone(sheet["B4"].value)
            self.assertEqual(len(sheet._charts), 1)
        finally:
            workbook.close()
        before = (self.root / "report.xlsx").stat().st_mtime_ns
        self.assertEqual(self.run_analysis()["status"], "reused")
        self.assertEqual((self.root / "report.xlsx").stat().st_mtime_ns, before)
        self.assertEqual(self.source.read_bytes(), original)
        workbook = load_workbook(self.source)
        workbook.active["C2"] = 20
        workbook.save(self.source)
        workbook.close()
        self.assertEqual(self.run_analysis()["status"], "created")
        (self.root / "report.xlsx").write_bytes(b"tampered")
        self.assertEqual(self.run_analysis()["status"], "created")

    def test_join_validation_prevents_duplicate_lookup_inflation(self):
        lookup = Workbook()
        lookup.active.title = "Map"
        for row in [("Region", "Group"), ("North", "A"), ("North", "B")]:
            lookup.active.append(row)
        lookup.save(self.root / "map.xlsx")
        self.config["inputs"].append({"id": "mapping", "path": "map.xlsx", "sheet": "Map"})
        self.config["reports"][0]["joins"] = [{"source": "mapping", "on": "Region", "validate": "many_to_one"}]
        with self.assertRaises(Exception):
            self.run_analysis()
        self.assertFalse((self.root / "report.xlsx").exists())

    def test_join_and_filter_on_a_different_business_mapping(self):
        lookup = Workbook()
        lookup.active.title = "Map"
        for row in [("Region", "Manager"), ("North", "Alex"), ("South", "Bo")]:
            lookup.active.append(row)
        lookup.save(self.root / "map.xlsx")
        self.config["inputs"].append({"id": "mapping", "path": "map.xlsx", "sheet": "Map"})
        spec = self.config["reports"][0]
        spec["joins"] = [{"source": "mapping", "on": "Region", "validate": "many_to_one"}]
        spec["filters"] = [{"column": "Manager", "op": "not_null"}]
        spec["group_by"] = ["Manager"]
        spec["charts"][0]["category"] = "Manager"
        self.run_analysis()
        workbook = load_workbook(self.root / "report.xlsx")
        try:
            self.assertEqual(list(workbook["Summary"].values)[1], ("Alex", 10, 34, 3.4))
        finally:
            workbook.close()

    def test_unknown_configuration_field_fails_instead_of_ignoring_a_business_rule(self):
        self.config["reports"][0]["grouping"] = ["Region"]
        with self.assertRaisesRegex(ValueError, "unknown=.*grouping"):
            self.run_analysis()

    def test_failed_config_keeps_previous_result_and_input_is_never_output(self):
        self.run_analysis()
        original = (self.root / "report.xlsx").read_bytes()
        self.config["reports"][0]["ratios"][0]["numerator"] = "Missing column"
        with self.assertRaisesRegex(ValueError, "Missing columns"):
            self.run_analysis()
        self.assertEqual((self.root / "report.xlsx").read_bytes(), original)
        self.config["output"] = "orders.xlsx"
        with self.assertRaisesRegex(ValueError, "must not overwrite"):
            self.run_analysis()

    def test_unaggregated_string_data_remains_literal_and_second_report_can_use_first(self):
        workbook = load_workbook(self.source)
        workbook.active["A2"] = "=1+1"
        workbook.active["A2"].data_type = "s"
        workbook.save(self.source)
        workbook.close()
        self.config["reports"] = [
            {"id": "detail", "source": "orders", "sheet": "Detail", "filters": [
                {"column": "Region", "op": "in", "values": ["=1+1", "North"]}]},
            {"id": "total", "source": "detail", "sheet": "Total", "aggregates": [
                {"column": "Units", "op": "sum", "as": "Total units"}]},
        ]
        self.run_analysis()
        workbook = load_workbook(self.root / "report.xlsx")
        try:
            self.assertEqual(workbook["Detail"]["A2"].data_type, "s")
            self.assertEqual(workbook["Total"]["A2"].value, 10)
        finally:
            workbook.close()


if __name__ == "__main__":
    unittest.main()
