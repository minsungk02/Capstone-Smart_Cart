@echo off
REM Start local MySQL via Docker and print DATABASE_URL example.
REM Usage: db\start_local_mysql.bat

setlocal

set "SCRIPT_DIR=%~dp0"
set "COMPOSE_FILE=%SCRIPT_DIR%docker-compose.mysql.yml"

if "%MYSQL_PORT%"=="" set "MYSQL_PORT=3307"
if "%MYSQL_DATABASE%"=="" set "MYSQL_DATABASE=mydb"
if "%MYSQL_USER%"=="" set "MYSQL_USER=ebrcs_app"
if "%MYSQL_PASSWORD%"=="" set "MYSQL_PASSWORD=ebrcs_pass"
if "%MYSQL_ROOT_PASSWORD%"=="" set "MYSQL_ROOT_PASSWORD=root1234"

REM Check docker
where docker >nul 2>&1
if errorlevel 1 (
    echo [ERROR] docker not found. Install Docker Desktop first.
    exit /b 1
)

REM Detect docker compose vs docker-compose
docker compose version >nul 2>&1
if not errorlevel 1 (
    set "COMPOSE_CMD=docker compose"
) else (
    where docker-compose >nul 2>&1
    if not errorlevel 1 (
        set "COMPOSE_CMD=docker-compose"
    ) else (
        echo [ERROR] docker compose / docker-compose not found.
        exit /b 1
    )
)

echo Starting local MySQL container...
%COMPOSE_CMD% -f "%COMPOSE_FILE%" up -d
if errorlevel 1 ( echo [ERROR] Failed to start container. & exit /b 1 )

echo Waiting for MySQL readiness...
set /a RETRY=0
:wait_loop
set /a RETRY+=1
if %RETRY% GTR 60 (
    echo [ERROR] MySQL container did not become ready in time.
    echo Check logs: %COMPOSE_CMD% -f "%COMPOSE_FILE%" logs mysql
    exit /b 1
)
%COMPOSE_CMD% -f "%COMPOSE_FILE%" exec -T mysql mysqladmin ping -h 127.0.0.1 -uroot -p%MYSQL_ROOT_PASSWORD% --silent >nul 2>&1
if errorlevel 1 (
    timeout /t 2 /nobreak >nul
    goto wait_loop
)

echo [OK] Local MySQL is ready.
echo.
echo Use this in .env:
echo DATABASE_URL=mysql+pymysql://%MYSQL_USER%:%MYSQL_PASSWORD%@127.0.0.1:%MYSQL_PORT%/%MYSQL_DATABASE%
exit /b 0
