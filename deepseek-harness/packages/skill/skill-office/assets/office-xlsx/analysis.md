# Reusable local analysis

For ordinary grouped analysis, joins, ratios, tables, and native bar/line charts, write a small JSON configuration instead of generating a workbook builder from scratch:

```text
<python> -X utf8 <skill-directory>/../scripts/analyze_xlsx.py <task-workspace>/analysis.json
```

Paths are relative to the configuration file. Source files are read only; output must be a separate XLSX. The tool writes computed values, not formulas, and does not preserve or modify source workbook features. For formula deliverables, targeted template edits, complex charts, or unsupported transformations, use a focused Python pipeline.

```json
{
  "inputs": [{
    "id": "orders", "path": "orders.xlsx", "sheet": "Orders",
    "header_row": 1, "columns": ["Region", "Units", "Revenue"],
    "normalize_keys": ["Region"], "numeric_columns": ["Units", "Revenue"]
  }],
  "output": "regional-analysis.xlsx",
  "reports": [{
    "id": "regional", "source": "orders", "sheet": "Regional summary",
    "group_by": ["Region"],
    "aggregates": [
      {"column": "Units", "op": "sum", "as": "Total units"},
      {"column": "Revenue", "op": "sum", "as": "Total revenue"}
    ],
    "ratios": [{"numerator": "Total revenue", "denominator": "Total units", "as": "Revenue per unit"}],
    "number_formats": {"Total units": "#,##0", "Revenue per unit": "0.00"},
    "charts": [{"type": "bar", "title": "Revenue by region", "category": "Region", "values": ["Total revenue"], "unit": "Currency"}]
  }]
}
```

## Supported configuration

- Inputs require unique `id`, `path`, and worksheet name `sheet`. `header_row` is one-based, default 1. Optional `columns` selects fields, `normalize_keys` trims string edges only, and `numeric_columns` converts numeric values or fails on invalid data. Empty rows are dropped; embedded total rows are not removed automatically.
- Reports require unique `id`, `source` naming an input or earlier report, and valid Excel worksheet name `sheet`. Operations run in this order: joins, filters, grouping/aggregates, ratios, sorting, column selection.
- Optional `joins` entries require `source`, `on` (column or columns), and `validate` (`one_to_one` or `many_to_one`); `how` defaults to `left`. Duplicate lookup keys fail instead of inflating totals. Pandas matches null join keys; use a focused pipeline to exclude null keys before joining when required by the task.
- Optional `filters`: `{"column":"Region","op":"in","values":["North","South"]}` or `{"column":"Units","op":"not_null"}`.
- Optional `group_by` is a field list. `aggregates` require `column`, `op` (`sum`, `mean`, `min`, `max`, `count`), and output name `as`. Without grouping, aggregates return one total row. All-null sums remain blank; missing group keys remain a separate group. `count` counts nonmissing values.
- `ratios` require `numerator`, `denominator`, and `as`, referring to columns after grouping. Zero or missing denominators produce blanks. Ensure common reporting periods and compatible units before comparing results.
- Optional `sort_by` is a field or list; `ascending` defaults to true. Optional `columns` sets final field order. Optional `number_formats` maps field names to Excel format strings.
- `charts` require `type` (`bar` or `line`), `title`, `category`, and numeric `values` fields. Optional `unit` labels the vertical axis. Charts sit below the data. Imported strings remain literal text, including strings beginning with `=`.

## Checks and retries

The executor reopens the saved workbook and checks report dimensions. A sidecar `<output>.analysis.json` records configuration/input/executor/output hashes. An unchanged run returns `status: "reused"` only while all hashes match; changed inputs, configuration, executor, or output force rebuilding. Keep the sidecar between retries. Business meaning, independent totals, and appearance still need task-appropriate verification. Once those checks and the shared Office checker pass, present the workbook; do not add optional pages or repeatedly inspect unchanged output.
