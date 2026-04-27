@echo off
REM One-step local MySQL setup: Docker start -> schema bootstrap -> seed import.
REM
REM Usage:
REM   db\setup_local_db.bat
REM   db\setup_local_db.bat --append   (keep existing data, append seed on top)

setlocal
set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "SEED_FILE=%SCRIPT_DIR%seeds\full_seed_latest.sql.gz"
set "APPEND_FLAG="

:parse_args
if "%~1"=="--append" ( set "APPEND_FLAG=--append" & shift & goto parse_args )
if "%~1"=="-h" ( goto show_help )
if "%~1"=="--help" ( goto show_help )
if not "%~1"=="" ( echo Unknown option: %~1 & exit /b 1 )
goto main

:show_help
echo Usage: db\setup_local_db.bat [--append]
echo   --append   Keep existing data and append seed on top.
exit /b 0

:main
echo ================================================================
echo   EBRCS Local MySQL Setup
echo ================================================================
echo.

REM ── Step 1: Docker MySQL 기동 ────────────────────────────────────────────────
echo ^> Step 1/3: Starting Docker MySQL...
call "%SCRIPT_DIR%start_local_mysql.bat" || exit /b 1
echo.

REM ── Step 2: 스키마 bootstrap ─────────────────────────────────────────────────
echo ^> Step 2/3: Bootstrapping DB schema...
cd /d "%PROJECT_ROOT%\app"
call setup_db.bat || exit /b 1
cd /d "%PROJECT_ROOT%"
echo.

REM ── Step 3: 시드 데이터 복원 ─────────────────────────────────────────────────
echo ^> Step 3/3: Importing seed data...
if not exist "%SEED_FILE%" (
    echo [WARN] Seed file not found: %SEED_FILE%
    echo   DB schema is ready but contains no product/user data.
    echo   To import later: db\import_full_seed.bat --seed ^<path^>
    goto done
)

REM docker exec로 직접 import (mysql client 불필요)
echo Importing via docker exec...
if "%APPEND_FLAG%"=="" (
    REM truncate tables first
    docker exec ebrcs-local-mysql mysql -uebrcs_app -pebrcs_pass mydb -e "SET FOREIGN_KEY_CHECKS=0; TRUNCATE TABLE purchase_history; TRUNCATE TABLE users; TRUNCATE TABLE category_corner_map; TRUNCATE TABLE store_corners; TRUNCATE TABLE product_discounts; TRUNCATE TABLE product_prices; TRUNCATE TABLE products; SET FOREIGN_KEY_CHECKS=1;"
    if errorlevel 1 ( echo [ERROR] Failed to truncate tables. & exit /b 1 )
)

REM Check if python is available for parsing .env
where python >nul 2>&1
if not errorlevel 1 ( set "PYTHON_BIN=python" ) else (
    where python3 >nul 2>&1
    if not errorlevel 1 ( set "PYTHON_BIN=python3" ) else (
        echo [ERROR] python/python3 not found. & exit /b 1
    )
)

REM Decompress and pipe into docker exec
%PYTHON_BIN% -c "import gzip, sys; sys.stdout.buffer.write(gzip.open(sys.argv[1]).read())" "%SEED_FILE%" | docker exec -i ebrcs-local-mysql mysql -uebrcs_app -pebrcs_pass mydb
if errorlevel 1 ( echo [ERROR] Seed import failed. & exit /b 1 )

echo [OK] Full seed imported.
echo.
echo Row counts after import:
docker exec ebrcs-local-mysql mysql -uebrcs_app -pebrcs_pass mydb -e "SELECT 'products' AS tbl, COUNT(*) AS cnt FROM products UNION ALL SELECT 'product_prices', COUNT(*) FROM product_prices UNION ALL SELECT 'users', COUNT(*) FROM users UNION ALL SELECT 'purchase_history', COUNT(*) FROM purchase_history;"

:done
echo.
echo ================================================================
echo   Local MySQL setup complete!
echo.
echo   Next step:
echo     cd app ^&^& run_web.bat
echo ================================================================
exit /b 0
