@echo off
REM Cross-platform setup for Darex on Windows
REM Run once before start.bat to ensure all dependencies and configs are ready

setlocal enabledelayedexpansion
cd /d "%~dp0"

REM =========================================================================
REM HELPERS
REM =========================================================================

set "ROOT=%cd%"

for /f %%a in ('where docker 2^>nul') do set "HAS_DOCKER=1"
for /f %%a in ('where node 2^>nul') do set "HAS_NODE=1"
for /f %%a in ('where pnpm 2^>nul') do set "HAS_PNPM=1"

REM =========================================================================
REM REQUIREMENT CHECKS
REM =========================================================================

echo.
echo === Checking system requirements...
echo.

if not defined HAS_DOCKER (
  echo ERROR: Docker not found
  echo Download Docker Desktop: https://www.docker.com/products/docker-desktop
  exit /b 1
)
echo.    [OK] Docker installed

if not defined HAS_NODE (
  echo ERROR: Node.js not found
  echo Download from https://nodejs.org or install via package manager
  exit /b 1
)
echo.    [OK] Node.js installed

if not defined HAS_PNPM (
  echo ERROR: pnpm not found
  echo Run: npm install -g pnpm
  exit /b 1
)
echo.    [OK] pnpm installed

docker ps >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker daemon not running. Start Docker and retry.
  exit /b 1
)
echo.    [OK] Docker daemon running

REM =========================================================================
REM ENVIRONMENT SETUP
REM =========================================================================

echo.
echo === Setting up environment...
echo.

if not exist "%ROOT%\.env" (
  if exist "%ROOT%\.env.example" (
    copy "%ROOT%\.env.example" "%ROOT%\.env"
    echo Created .env from .env.example
    echo.    WARNING: Review .env and update secrets before using live integrations
  ) else (
    echo ERROR: No .env.example found
    exit /b 1
  )
)

REM Next.js only auto-loads env files from the app's own directory, never the
REM repo root -- without this, apps/dashboard boots with DB_PASSWORD unset and
REM every DB call (including the WhatsApp webhook) fails.
if not exist "%ROOT%\apps\dashboard\.env.local" (
  copy "%ROOT%\.env" "%ROOT%\apps\dashboard\.env.local"
  echo Copied .env -^> apps\dashboard\.env.local
)

REM =========================================================================
REM DEPENDENCIES
REM =========================================================================

echo.
echo === Installing Node dependencies...
echo.
call pnpm install
if errorlevel 1 exit /b 1

echo.
echo === Building shared types...
call pnpm --filter @darex/shared-types build
if errorlevel 1 exit /b 1

REM =========================================================================
REM DOCKER SETUP
REM =========================================================================

echo.
echo === Building Docker images...
call bash infra/scripts/compose-cmd.sh build --progress=plain
if errorlevel 1 exit /b 1

REM =========================================================================
REM DATABASE PREPARATION
REM =========================================================================

echo.
echo === Starting database container...
call bash infra/scripts/compose-cmd.sh up -d postgres
if errorlevel 1 exit /b 1

echo.
echo === Waiting for Postgres...
set "tries=0"
:wait_postgres
docker exec darex-postgres pg_isready -U darex -d darex >nul 2>&1
if errorlevel 1 (
  set /a tries+=1
  if !tries! geq 60 (
    echo ERROR: Postgres failed to start after 120 seconds
    exit /b 1
  )
  timeout /t 2 /nobreak >nul
  goto wait_postgres
)
echo.    [OK] Postgres ready

echo.
echo === Applying database migrations...
set "DB_HOST=localhost"
set "DB_PORT=5432"
set "DB_USER=darex"
set "DB_PASSWORD=darex_dev_secret"
set "DB_NAME=darex"
call node "%ROOT%\infra\db\migrate.js"
if errorlevel 1 exit /b 1

REM =========================================================================
REM MARK SETUP COMPLETE
REM =========================================================================

(
  REM Touch file
) > "%ROOT%\.setup-done"

echo.
echo === Setup complete!
echo.
echo Run start.bat to begin the application
echo.

exit /b 0
