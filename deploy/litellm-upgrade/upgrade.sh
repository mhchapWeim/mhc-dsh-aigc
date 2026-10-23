#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v python3 >/dev/null || { echo '需要 Python 3.8+（仅标准库）。' >&2; exit 1; }
exec python3 "$ROOT/manager.py" upgrade "$@"
