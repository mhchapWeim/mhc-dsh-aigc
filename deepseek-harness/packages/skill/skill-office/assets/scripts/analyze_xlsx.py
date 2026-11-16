"""Run a declarative local table analysis and create a new XLSX report.

See ../office-xlsx/analysis.md for the JSON configuration contract.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile

import pandas as pd
from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def columns(frame, names):
    missing = set(names) - set(frame.columns)
    if missing:
        raise ValueError(f"Missing columns: {sorted(missing)}")


def fields(value, required, optional=()):
    if not isinstance(value, dict):
        raise ValueError("Configuration entries must be objects")
    missing = set(required) - value.keys()
    unknown = value.keys() - set(required) - set(optional)
    if missing or unknown:
        raise ValueError(f"Configuration fields: missing={sorted(missing)}, unknown={sorted(unknown)}")


def load_input(spec, base):
    fields(spec, ["id", "path", "sheet"], ["header_row", "columns", "normalize_keys", "numeric_columns"])
    path = (base / spec["path"]).resolve()
    header = spec.get("header_row", 1)
    if not isinstance(header, int) or header < 1:
        raise ValueError("header_row must be a positive one-based row number")
    frame = pd.read_excel(path, sheet_name=spec["sheet"], header=header - 1, dtype=object)
    frame = frame.dropna(how="all")
    if spec.get("columns"):
        columns(frame, spec["columns"])
        frame = frame[spec["columns"]].copy()
    for name in spec.get("normalize_keys", []):
        columns(frame, [name])
        frame[name] = frame[name].map(lambda value: value.strip() if isinstance(value, str) else value)
    for name in spec.get("numeric_columns", []):
        columns(frame, [name])
        frame[name] = pd.to_numeric(frame[name], errors="raise")
    return frame


def transform(spec, tables):
    fields(spec, ["id", "source", "sheet"], ["joins", "filters", "group_by", "aggregates", "ratios",
                                           "sort_by", "ascending", "columns", "number_formats", "charts"])
    frame = tables[spec["source"]].copy()
    for join in spec.get("joins", []):
        fields(join, ["source", "on", "validate"], ["how"])
        if join.get("how", "left") not in ("left", "inner"):
            raise ValueError("Supported join modes: left, inner")
        if join.get("validate") not in ("one_to_one", "many_to_one"):
            raise ValueError("Every join must declare one_to_one or many_to_one validation")
        frame = frame.merge(tables[join["source"]], on=join["on"],
                            how=join.get("how", "left"), validate=join["validate"])
    for item in spec.get("filters", []):
        fields(item, ["column", "op"], ["values"])
        columns(frame, [item["column"]])
        if item["op"] == "in":
            mask = frame[item["column"]].isin(item["values"])
        elif item["op"] == "not_null":
            mask = frame[item["column"]].notna()
        else:
            raise ValueError("Supported filter operations: in, not_null")
        frame = frame.loc[mask].copy()
    metrics = spec.get("aggregates", [])
    if metrics:
        groups = spec.get("group_by", [])
        columns(frame, groups + [metric["column"] for metric in metrics])
        pieces = []
        for metric in metrics:
            fields(metric, ["column", "op", "as"])
            if metric["op"] not in ("sum", "mean", "min", "max", "count"):
                raise ValueError("Unsupported aggregate operation")
            name = metric["as"]
            values = frame[metric["column"]]
            if metric["op"] != "count":
                values = pd.to_numeric(values, errors="raise")
            if groups:
                grouped = values.groupby([frame[key] for key in groups], dropna=False, sort=False)
                result = grouped.sum(min_count=1) if metric["op"] == "sum" else getattr(grouped, metric["op"])()
                pieces.append(result.rename(name))
            else:
                value = values.sum(min_count=1) if metric["op"] == "sum" else getattr(values, metric["op"])()
                pieces.append(pd.Series([value], name=name))
        frame = pd.concat(pieces, axis=1).reset_index() if groups else pd.concat(pieces, axis=1)
    for ratio in spec.get("ratios", []):
        fields(ratio, ["numerator", "denominator", "as"])
        columns(frame, [ratio["numerator"], ratio["denominator"]])
        numerator = pd.to_numeric(frame[ratio["numerator"]], errors="raise")
        denominator = pd.to_numeric(frame[ratio["denominator"]], errors="raise")
        frame[ratio["as"]] = numerator / denominator.where(denominator != 0)
    if spec.get("sort_by"):
        frame = frame.sort_values(spec["sort_by"], ascending=spec.get("ascending", True), kind="stable")
    if spec.get("columns"):
        columns(frame, spec["columns"])
        frame = frame[spec["columns"]]
    if frame.columns.duplicated().any():
        raise ValueError("Output columns must be unique")
    return frame.reset_index(drop=True)


def cell_value(value):
    if pd.isna(value):
        return None
    if hasattr(value, "item"):
        return value.item()
    if isinstance(value, pd.Timestamp):
        return value.to_pydatetime()
    return value


def write_report(config, tables, target):
    workbook = Workbook()
    workbook.remove(workbook.active)
    summaries = []
    for spec in config["reports"]:
        if spec["id"] in tables:
            raise ValueError("Input and report IDs must be unique")
        frame = transform(spec, tables)
        tables[spec["id"]] = frame
        title = spec["sheet"]
        if title in workbook.sheetnames:
            raise ValueError(f"Duplicate output sheet: {title}")
        sheet = workbook.create_sheet(title)
        sheet.append(list(frame.columns))
        for row in frame.itertuples(index=False, name=None):
            sheet.append([cell_value(value) for value in row])
        # Imported strings are literal data, even when they start with '='.
        for row in sheet:
            for cell in row:
                if isinstance(cell.value, str):
                    cell.data_type = "s"
                if isinstance(cell.value, (int, float)):
                    cell.number_format = "#,##0.00"
        for cell in sheet[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="244062")
            cell.alignment = Alignment(wrap_text=True)
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
        for index, name in enumerate(frame.columns, 1):
            sheet.column_dimensions[get_column_letter(index)].width = min(36, max(14, len(str(name)) * 2 + 2))
        for name, number_format in spec.get("number_formats", {}).items():
            columns(frame, [name])
            for row in range(2, len(frame) + 2):
                sheet.cell(row, frame.columns.get_loc(name) + 1).number_format = number_format
        for index, chart_spec in enumerate(spec.get("charts", [])):
            fields(chart_spec, ["type", "title", "category", "values"], ["unit"])
            columns(frame, [chart_spec["category"]] + chart_spec["values"])
            if frame.empty:
                raise ValueError("Cannot chart an empty result")
            if chart_spec["type"] not in ("bar", "line"):
                raise ValueError("Supported chart types: bar, line")
            chart = BarChart() if chart_spec["type"] == "bar" else LineChart()
            chart.title = chart_spec["title"]
            chart.y_axis.title = chart_spec.get("unit")
            chart.height, chart.width = 8, 18
            for name in chart_spec["values"]:
                if not pd.api.types.is_numeric_dtype(frame[name]):
                    raise ValueError(f"Chart values must be numeric: {name}")
                col = frame.columns.get_loc(name) + 1
                chart.add_data(Reference(sheet, min_col=col, min_row=1, max_row=len(frame) + 1), titles_from_data=True)
            cat = frame.columns.get_loc(chart_spec["category"]) + 1
            chart.set_categories(Reference(sheet, min_col=cat, min_row=2, max_row=len(frame) + 1))
            sheet.add_chart(chart, f"A{len(frame) + 4 + index * 22}")
        summaries.append({"sheet": title, "rows": len(frame), "columns": len(frame.columns),
                          "charts": len(spec.get("charts", []))})
    if not summaries:
        raise ValueError("At least one report is required")
    workbook.save(target)
    workbook.close()
    checked = load_workbook(target, read_only=True)
    try:
        for item in summaries:
            sheet = checked[item["sheet"]]
            if sheet.max_row != item["rows"] + 1 or sheet.max_column != item["columns"]:
                raise ValueError("Saved report dimensions do not match computed results")
    finally:
        checked.close()
    return summaries


def run(config_path):
    config_path = Path(config_path).resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    fields(config, ["inputs", "output", "reports"])
    base = config_path.parent
    inputs = [(base / spec["path"]).resolve() for spec in config["inputs"]]
    output = (base / config["output"]).resolve()
    manifest = output.with_suffix(output.suffix + ".analysis.json")
    if output in inputs or manifest in inputs:
        raise ValueError("Report and manifest must not overwrite an input")
    input_hashes = {str(path): digest(path) for path in inputs}
    fingerprint = hashlib.sha256(json.dumps({
        "config": config, "inputs": input_hashes,
        "executor": digest(__file__),
    }, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    if output.exists() and manifest.exists():
        try:
            previous = json.loads(manifest.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            previous = {}
        if previous.get("fingerprint") == fingerprint and previous.get("output_sha256") == digest(output):
            return {"status": "reused", "output": str(output), "reports": previous["reports"]}
    tables = {}
    for spec in config["inputs"]:
        if spec["id"] in tables:
            raise ValueError("Input IDs must be unique")
        tables[spec["id"]] = load_input(spec, base)
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(suffix=".xlsx", dir=output.parent)
    os.close(descriptor)
    try:
        summaries = write_report(config, tables, temporary)
        if any(digest(path) != input_hashes[str(path)] for path in inputs):
            raise ValueError("An input changed during analysis; the existing report was not replaced")
        os.replace(temporary, output)
    finally:
        Path(temporary).unlink(missing_ok=True)
    record = {"fingerprint": fingerprint, "output_sha256": digest(output), "reports": summaries}
    manifest.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"status": "created", "output": str(output), "reports": summaries,
            "checks": "Reopened saved workbook; verified report dimensions. Formula results were not recalculated."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.config), ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"status": "error", "message": str(error)[:1000]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
