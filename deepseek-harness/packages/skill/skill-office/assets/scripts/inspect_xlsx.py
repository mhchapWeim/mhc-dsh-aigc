"""Read-only, bounded workbook profiling for the Office XLSX workflow."""

import argparse
import datetime
import json
from pathlib import Path

import openpyxl


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def preview(value):
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, str):
        return value[:120] + ("…" if len(value) > 120 else "")
    return value


def inspect(path, *, max_sheets=8, max_rows=10000, max_cols=80, sample_rows=3):
    formulas = openpyxl.load_workbook(path, read_only=True, data_only=False)
    try:
        cached = openpyxl.load_workbook(path, read_only=True, data_only=True)
        try:
            report = {"sheet_count": len(formulas.sheetnames), "sheets": []}
            for sheet in formulas.worksheets[:max_sheets]:
                row_limit = min(sheet.max_row or 0, max_rows)
                col_limit = min(sheet.max_column or 0, max_cols)
                item = {
                    "name": sheet.title,
                    "rows": sheet.max_row,
                    "columns": sheet.max_column,
                    "scanned_rows": row_limit,
                    "scanned_columns": col_limit,
                    "scan_complete": row_limit == sheet.max_row and col_limit == sheet.max_column,
                    "nonempty_cells": 0,
                    "formula_cells": 0,
                    "missing_formula_cache": 0,
                    "error_cells": 0,
                    "headers": [],
                    "samples": [],
                }
                if row_limit and col_limit:
                    source_rows = sheet.iter_rows(max_row=row_limit, max_col=col_limit)
                    cached_rows = cached[sheet.title].iter_rows(max_row=row_limit, max_col=col_limit)
                    for index, (source, values) in enumerate(zip(source_rows, cached_rows), start=1):
                        for cell, value in zip(source, values):
                            item["nonempty_cells"] += cell.value is not None
                            item["formula_cells"] += cell.data_type == "f"
                            item["missing_formula_cache"] += cell.data_type == "f" and value.value is None
                            item["error_cells"] += cell.data_type == "e" or value.data_type == "e"
                        if index == 1:
                            item["headers"] = [preview(c.value) if c.data_type != "f" else "[formula]" for c in source]
                        elif len(item["samples"]) < sample_rows:
                            item["samples"].append([preview(c.value) for c in values])
                report["sheets"].append(item)
            report["omitted_sheets"] = report["sheet_count"] - len(report["sheets"])
            report["formula_values"] = "Stored caches, not recalculated results. Counts cover scanned cells only."
            return report
        finally:
            cached.close()
    finally:
        formulas.close()


def bounded_json(report, max_chars):
    """Keep valid JSON and explicit omissions within the complete stdout budget."""
    def encode():
        return json.dumps(report, ensure_ascii=False, default=str, allow_nan=False)

    text = encode()
    if len(text) + 1 <= max_chars:
        return text
    report["output_truncated"] = True
    for field in ("samples", "headers"):
        for sheet in reversed(report.get("sheets", [])):
            sheet.pop(field, None)
            text = encode()
            if len(text) + 1 <= max_chars:
                return text
    while report.get("sheets"):
        report["sheets"].pop()
        report["omitted_sheets"] += 1
        text = encode()
        if len(text) + 1 <= max_chars:
            return text
    return '{"output_truncated": true, "error": "Metadata exceeds output budget; inspect fewer sheets or increase --max-chars."}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--max-sheets", type=positive, default=8)
    parser.add_argument("--max-rows", type=positive, default=10000)
    parser.add_argument("--max-cols", type=positive, default=80)
    parser.add_argument("--sample-rows", type=positive, default=3)
    parser.add_argument("--max-chars", type=positive, default=12000)
    args = parser.parse_args()
    if args.max_chars < 256:
        parser.error("--max-chars must be at least 256")
    try:
        report = inspect(args.input, max_sheets=args.max_sheets, max_rows=args.max_rows,
                         max_cols=args.max_cols, sample_rows=args.sample_rows)
    except Exception as error:
        print(bounded_json({"error": str(error)[:120]}, args.max_chars))
        return 1
    print(bounded_json(report, args.max_chars))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
