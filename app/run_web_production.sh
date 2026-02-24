#!/usr/bin/env bash
# EBRCS production runner.
# Prints only high-level status to console; detailed output goes to logs/.

set -euo pipefail

MIN_NODE_VERSION="20.19.0"

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$APP_DIR")"
LOG_DIR="$APP_DIR/logs"
RUNNER_LOG="$LOG_DIR/run_web_production.log"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"
FRONTEND_BUILD_LOG="$LOG_DIR/frontend_build.log"

timestamp() {
    date '+%Y-%m-%d %H:%M:%S'
}

log_line() {
    local level="$1"
    shift
    printf '%s [%s] %s\n' "$(timestamp)" "$level" "$*" >> "$RUNNER_LOG"
}

say() {
    printf '%s\n' "$*"
    log_line INFO "$*"
}

warn() {
    printf 'WARN: %s\n' "$*" >&2
    log_line WARN "$*"
}

die() {
    printf 'ERROR: %s\n' "$*" >&2
    log_line ERROR "$*"
    exit 1
}

version_lt() {
    [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" != "$1" ]
}

require_command() {
    local cmd="$1"
    command -v "$cmd" >/dev/null 2>&1 || die "Missing command: $cmd"
}

tail_for_error() {
    local file="$1"
    local lines="${2:-40}"
    if [ -f "$file" ]; then
        echo "----- $file (last ${lines} lines) -----" >&2
        tail -n "$lines" "$file" >&2 || true
        echo "--------------------------------------" >&2
    fi
}

wait_for_http() {
    local pid="$1"
    local url="$2"
    local retries="$3"
    local delay_seconds="$4"

    for _ in $(seq 1 "$retries"); do
        if ! ps -p "$pid" >/dev/null 2>&1; then
            return 1
        fi
        if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep "$delay_seconds"
    done
    return 1
}

stop_stale_processes() {
    log_line INFO "Stopping stale backend/frontend processes if present."

    if [ -f "$LOG_DIR/backend.pid" ]; then
        local old_backend_pid
        old_backend_pid="$(cat "$LOG_DIR/backend.pid" 2>/dev/null || true)"
        [ -n "$old_backend_pid" ] && kill "$old_backend_pid" 2>/dev/null || true
    fi

    if [ -f "$LOG_DIR/frontend.pid" ]; then
        local old_frontend_pid
        old_frontend_pid="$(cat "$LOG_DIR/frontend.pid" 2>/dev/null || true)"
        [ -n "$old_frontend_pid" ] && kill "$old_frontend_pid" 2>/dev/null || true
    fi

    pkill -f "uvicorn backend.main:app" >/dev/null 2>&1 || true
    pkill -f "vite preview" >/dev/null 2>&1 || true
    sleep 2

    local port_pid
    port_pid="$(lsof -ti:8000 || true)"
    [ -n "$port_pid" ] && kill -9 "$port_pid" >/dev/null 2>&1 || true

    port_pid="$(lsof -ti:5173 || true)"
    [ -n "$port_pid" ] && kill -9 "$port_pid" >/dev/null 2>&1 || true

    sleep 1

    if lsof -i:8000 >/dev/null 2>&1; then
        die "Port 8000 is still in use after cleanup."
    fi
    if lsof -i:5173 >/dev/null 2>&1; then
        die "Port 5173 is still in use after cleanup."
    fi

    return 0
}

main() {
    mkdir -p "$LOG_DIR"
    : > "$RUNNER_LOG"
    log_line INFO "run_web_production.sh started (app_dir=$APP_DIR)."

    [ -d "$APP_DIR/backend/.venv" ] || die "Backend virtualenv not found. Run ./setup_venv.sh first."
    source "$APP_DIR/backend/.venv/bin/activate"

    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

    require_command node
    require_command lsof
    require_command curl
    require_command uvicorn
    require_command npm

    local node_version
    node_version="$(node -v | sed 's/^v//')"
    if version_lt "$MIN_NODE_VERSION" "$node_version"; then
        die "Node.js v${MIN_NODE_VERSION}+ required (current: v${node_version})."
    fi

    [ -f "$PROJECT_ROOT/.env" ] || die ".env not found at $PROJECT_ROOT/.env"
    set -a
    # shellcheck disable=SC1090
    source "$PROJECT_ROOT/.env"
    set +a

    say "Starting EBRCS production stack..."

    log_line INFO "Checking DB schema."
    if ! "$APP_DIR/setup_db.sh" --check >> "$RUNNER_LOG" 2>&1; then
        warn "DB check failed. Running bootstrap..."
        "$APP_DIR/setup_db.sh" >> "$RUNNER_LOG" 2>&1 || die "DB bootstrap failed. See $RUNNER_LOG"
    fi
    say "DB schema ready."

    local uvicorn_workers
    uvicorn_workers="${UVICORN_WORKERS:-1}"
    if ! [[ "$uvicorn_workers" =~ ^[1-9][0-9]*$ ]]; then
        warn "Invalid UVICORN_WORKERS=$uvicorn_workers. Using 1."
        uvicorn_workers="1"
    fi
    if [ "$uvicorn_workers" -gt 1 ]; then
        warn "UVICORN_WORKERS=$uvicorn_workers may break in-memory session behavior."
    fi

    stop_stale_processes

    say "Building frontend..."
    if ! (cd "$APP_DIR/frontend" && npm run build > "$FRONTEND_BUILD_LOG" 2>&1); then
        tail_for_error "$FRONTEND_BUILD_LOG"
        die "Frontend build failed. See $FRONTEND_BUILD_LOG"
    fi
    log_line INFO "Frontend build completed."

    export PYTHONPATH="$APP_DIR:$PROJECT_ROOT"

    nohup uvicorn backend.main:app \
        --host 0.0.0.0 \
        --port 8000 \
        --workers "$uvicorn_workers" \
        > "$BACKEND_LOG" 2>&1 &
    local backend_pid=$!
    echo "$backend_pid" > "$LOG_DIR/backend.pid"
    log_line INFO "Started backend pid=$backend_pid"

    cd "$APP_DIR/frontend"
    nohup npx vite preview \
        --host 0.0.0.0 \
        --port 5173 \
        --strictPort \
        > "$FRONTEND_LOG" 2>&1 &
    local frontend_pid=$!
    cd "$APP_DIR"
    echo "$frontend_pid" > "$LOG_DIR/frontend.pid"
    log_line INFO "Started frontend pid=$frontend_pid"

    say "Waiting for services..."
    if ! wait_for_http "$backend_pid" "http://127.0.0.1:8000/api/health" 180 1; then
        tail_for_error "$BACKEND_LOG"
        die "Backend startup failed. See $BACKEND_LOG"
    fi

    if ! wait_for_http "$frontend_pid" "http://127.0.0.1:5173" 60 1; then
        tail_for_error "$FRONTEND_LOG"
        die "Frontend startup failed. See $FRONTEND_LOG"
    fi

    local public_ip
    public_ip="$(curl -s ifconfig.me 2>/dev/null || true)"
    [ -n "$public_ip" ] || public_ip="YOUR_EC2_IP"

    if ! curl -k -s --max-time 3 https://127.0.0.1/ >/dev/null 2>&1; then
        warn "Nginx HTTPS check failed on https://127.0.0.1/."
    fi

    say "EBRCS started successfully."
    say "  Web: https://${public_ip}"
    say "  API: https://${public_ip}/api/health"
    say "  Logs:"
    say "    - $RUNNER_LOG"
    say "    - $BACKEND_LOG"
    say "    - $FRONTEND_LOG"
    say "Stop: cd $APP_DIR && ./stop_web.sh"
}

main "$@"
