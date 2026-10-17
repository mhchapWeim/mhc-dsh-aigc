#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
backup=${1:-$(cat LAST_BACKUP)}
args=(--fail --silent --show-error --connect-timeout 10 --max-time 60)
ca=${CA_FILE:-tls/ca-chain.crt}
if [[ -s "$ca" ]]; then args+=(--cacert "$ca"); fi
curl "${args[@]}" https://aigcplatform.boschhuayu-steering.com/health
curl "${args[@]}" https://aigcplatform.boschhuayu-steering.com/api/auth/sso/config | python3 -c 'import json,sys; assert json.load(sys.stdin)["enabled"] is True'
curl "${args[@]}" -o /dev/null https://aigcplatform.boschhuayu-steering.com/login/local
curl "${args[@]}" https://aigcbackend.boschhuayu-steering.com/health
curl "${args[@]}" -I https://aigcbackend.boschhuayu-steering.com/ | python3 -c 'import sys; h=sys.stdin.read().lower(); assert "308" in h and "location: https://aigcplatform.boschhuayu-steering.com/" in h'
model=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["publicModelEndpoint"])' "$backup/switch-state.json")
if [[ "$model" == https://aigcplatform.boschhuayu-steering.com:30443/* ]]; then
  curl "${args[@]}" https://aigcplatform.boschhuayu-steering.com:30443/healthz
fi
echo 'HTTPS checks passed. Finish real browser SSO, download, backup and model acceptance.'
