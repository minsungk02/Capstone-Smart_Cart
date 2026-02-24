#!/usr/bin/env bash
# One-shot start helper from ~/EBRCS/app:
# - DB connectivity/schema check
# - Start production web stack
# - Verify core health endpoints

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$APP_DIR"

echo "[1/3] DB 준비 확인..."
./setup_db.sh --check || ./setup_db.sh

echo "[2/3] 웹 서비스 기동..."
./run_web_production.sh

echo "[3/3] 헬스체크..."
curl -fsS http://127.0.0.1:8000/api/health >/dev/null
curl -kfsS https://127.0.0.1/api/health >/dev/null

echo "✅ 서비스 정상 기동 확인 완료"
echo "   - 내부 API : http://127.0.0.1:8000/api/health"
echo "   - 외부 HTTPS: https://<EC2_PUBLIC_IP>/api/health"
