#!/usr/bin/env bash
# systemd 서비스 설정 스크립트 (현재 프로젝트 경로 자동 반영)

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$APP_DIR")"
SERVICE_FILE="/etc/systemd/system/ebrcs.service"
RUN_USER="$(id -un)"
TMP_SERVICE="$(mktemp)"
LOG_DIR="$APP_DIR/logs"
SETUP_LOG="$LOG_DIR/setup_systemd.log"

mkdir -p "$LOG_DIR"
: > "$SETUP_LOG"

log() {
    printf '%s\n' "$*"
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$SETUP_LOG"
}

run_logged() {
    "$@" >> "$SETUP_LOG" 2>&1
}

cleanup() {
    rm -f "$TMP_SERVICE"
}
trap cleanup EXIT

log "⚙️  systemd 서비스 설정"
log "====================="
log "App dir      : $APP_DIR"
log "Project root : $PROJECT_ROOT"
log "Run user     : $RUN_USER"
log "Log file     : $SETUP_LOG"
log ""

cat > "$TMP_SERVICE" <<EOF
[Unit]
Description=EBRCS Smart Checkout Web App
After=network.target

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/run_web_production.sh
ExecStop=$APP_DIR/stop_web.sh
RemainAfterExit=yes
Restart=no
TimeoutStartSec=900
StandardOutput=journal
StandardError=journal
Environment="PATH=$APP_DIR/backend/.venv/bin:/usr/local/bin:/usr/bin:/bin"
EnvironmentFile=$PROJECT_ROOT/.env

[Install]
WantedBy=multi-user.target
EOF

log "📋 서비스 파일 설치 중..."
run_logged sudo install -m 644 "$TMP_SERVICE" "$SERVICE_FILE"

log "🔄 systemd 리로드 중..."
run_logged sudo systemctl daemon-reload

log "✅ 서비스 활성화 중..."
run_logged sudo systemctl enable ebrcs.service

log "🚀 서비스 재시작 중..."
run_logged sudo systemctl restart ebrcs.service

sleep 3
SERVICE_STATE="$(sudo systemctl is-active ebrcs.service 2>> "$SETUP_LOG" || true)"
if [ "$SERVICE_STATE" != "active" ]; then
    log "❌ 서비스 상태가 비정상입니다: $SERVICE_STATE"
    run_logged sudo systemctl status ebrcs.service --no-pager -l
    exit 1
fi

log ""
log "====================="
log "✅ systemd 설정 완료! (state: $SERVICE_STATE)"
log ""
log "📝 서비스 관리 명령어:"
log "  시작:   sudo systemctl start ebrcs"
log "  종료:   sudo systemctl stop ebrcs"
log "  재시작: sudo systemctl restart ebrcs"
log "  상태:   sudo systemctl status ebrcs --no-pager"
log "  로그:   sudo journalctl -u ebrcs -n 100 --no-pager"
log "  상세 로그 파일: $SETUP_LOG"
log ""
