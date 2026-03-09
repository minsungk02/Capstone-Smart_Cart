#!/usr/bin/env bash
# One-step local MySQL setup: Docker start → schema bootstrap → seed import.
#
# Usage:
#   ./db/setup_local_db.sh
#   ./db/setup_local_db.sh --append   # skip truncate, append seed on top

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SEED_FILE="$SCRIPT_DIR/seeds/full_seed_latest.sql.gz"
IMPORT_ARGS=()

while [ "$#" -gt 0 ]; do
    case "$1" in
        --append) IMPORT_ARGS+=("--append"); shift ;;
        -h|--help)
            echo "Usage: ./db/setup_local_db.sh [--append]"
            echo "  --append   Keep existing data and append seed on top."
            exit 0 ;;
        *) echo "❌ Unknown option: $1"; exit 1 ;;
    esac
done

echo "================================================================"
echo "  EBRCS Local MySQL Setup"
echo "================================================================"
echo ""

# ── Step 1: Docker MySQL 기동 ─────────────────────────────────────────────────
echo "▶ Step 1/3: Starting Docker MySQL..."
"$SCRIPT_DIR/start_local_mysql.sh"
echo ""

# ── Step 2: 스키마 bootstrap ──────────────────────────────────────────────────
echo "▶ Step 2/3: Bootstrapping DB schema..."
cd "$PROJECT_ROOT/app"
./setup_db.sh
cd "$PROJECT_ROOT"
echo ""

# ── Step 3: 시드 데이터 복원 ──────────────────────────────────────────────────
echo "▶ Step 3/3: Importing seed data..."
if [ ! -f "$SEED_FILE" ]; then
    echo "⚠️  Seed file not found: $SEED_FILE"
    echo "   DB schema is ready but contains no product/user data."
    echo "   To import later: ./db/import_full_seed.sh --seed <path>"
    exit 0
fi

"$SCRIPT_DIR/import_full_seed.sh" --seed "$SEED_FILE" "${IMPORT_ARGS[@]}"
echo ""

echo "================================================================"
echo "  ✅ Local MySQL setup complete!"
echo ""
echo "  Next step:"
echo "    cd app && ./run_web.sh"
echo "================================================================"
