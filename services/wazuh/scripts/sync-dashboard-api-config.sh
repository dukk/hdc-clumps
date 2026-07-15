#!/usr/bin/env bash
# Sync Wazuh dashboard wazuh.yml API password from docker-compose.yml API_PASSWORD.
set -euo pipefail
STACK="${1:-/opt/wazuh/wazuh-docker/single-node}"
cd "$STACK"
api_pw="$(grep -m1 'API_PASSWORD=' docker-compose.yml | cut -d= -f2-)"
export STACK API_PW="$api_pw"
python3 - <<'PY'
import os
import re
from pathlib import Path

stack = Path(os.environ["STACK"])
api_pw = os.environ["API_PW"]
wazuh_yml = stack / "config" / "wazuh_dashboard" / "wazuh.yml"
text = wazuh_yml.read_text()
text = re.sub(
    r'(password:\s*)"[^"]*"',
    lambda m: m.group(1) + '"' + api_pw.replace("\\", "\\\\").replace('"', '\\"') + '"',
    text,
    count=1,
)
wazuh_yml.write_text(text)
print("patched", wazuh_yml)
PY
docker compose restart wazuh.dashboard wazuh.manager
