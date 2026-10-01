@echo off
REM Darex local start — boot compose, migrate, probe, then leave stack up
REM Windows batch version of start.sh
REM Usage:
REM   start.bat              full compose + migrate + health checks
REM   start.bat --dev        infra without dashboard, then dev server
REM   start.bat --no-build   skip image rebuild
REM   start.bat --seed       also run db:seed
REM   start.bat --checks     probes only
REM   start.bat --down       stop compose

setlocal enabledelayedexpansion
cd /d "%~dp0"

set "ROOT=%cd%"
set "DO_BUILD=1"
set "DO_DEV=0"
set "DO_SEED=0"
set "DO_CHECKS_ONLY=0"
set "DO_DOWN=0"
set "SKIP_INSTALL=0"

REM Parse arguments
for %%A in (%*) do (
  if "%%A"=="--dev" set "DO_DEV=1"
  if "%%A"=="--no-build" set "DO_BUILD=0"
  if "%%A"=="--seed" set "DO_SEED=1"
  if "%%A"=="--checks" set "DO_CHECKS_ONLY=1"
  if "%%A"=="--down" set "DO_DOWN=1"
  if "%%A"=="--skip-install" set "SKIP_INSTALL=1"
  if "%%A"=="/h" goto :show_help
  if "%%A"=="--help" goto :show_help
)

REM Check if setup is complete
if not exist "%ROOT%\.setup-done" (
  echo.
  echo Setup not complete. Running setup.bat first...
  echo.
  call "%ROOT%\setup.bat"
  if errorlevel 1 exit /b 1
)

REM Helpers
for /f "delims=" %%a in ('forfiles /s /m .env /c "cmd /c if @isdir==FALSE echo %%~fa" 2^>nul ^| findstr "\.env$"') do set "ENV_PATH=%%a"

if exist "%ROOT%\.env" (
  for /f "delims==" %%a in ('type "%ROOT%\.env" ^| findstr /v "^REM" ^| findstr /v "^#"') do (
    for /f "tokens=1,2 delims==" %%b in ("%%a") do (
      if not "%%c"=="" set "%%b=%%c"
    )
  )
)

if "%DO_DOWN%"=="1" (
  echo.
  echo === Stopping compose (volumes kept)...
  call bash infra/scripts/compose-cmd.sh down
  exit /b 0
)

if "%DO_CHECKS_ONLY%"=="1" (
  call :run_checks
  call :print_urls
  exit /b 0
)

for /f %%a in ('where pnpm 2^>nul') do set "HAS_PNPM=1"
if not defined HAS_PNPM (
  echo ERROR: pnpm not found. Run: npm install -g pnpm
  exit /b 1
)

if "%SKIP_INSTALL%"=="0" (
  echo.
  echo === Installing dependencies...
  call pnpm install
  if errorlevel 1 exit /b 1
)

echo.
echo === Building shared types...
call pnpm --filter @darex/shared-types build
if errorlevel 1 exit /b 1

echo.
echo === Starting compose stack...
if "%DO_BUILD%"=="1" (
  if "%DO_DEV%"=="1" (
    call bash infra/scripts/compose-cmd.sh up -d --build --scale dashboard=0
  ) else (
    call bash infra/scripts/compose-cmd.sh up -d --build
  )
) else (
  if "%DO_DEV%"=="1" (
    call bash infra/scripts/compose-cmd.sh up -d --scale dashboard=0
  ) else (
    call bash infra/scripts/compose-cmd.sh up -d
  )
)
if errorlevel 1 exit /b 1

echo.
echo === Waiting for Postgres...
set "tries=0"
:wait_postgres
docker exec darex-postgres pg_isready -U darex -d darex >nul 2>&1
if errorlevel 1 (
  set /a tries+=1
  if !tries! geq 60 (
    echo ERROR: Postgres timeout
    exit /b 1
  )
  timeout /t 2 /nobreak >nul
  goto wait_postgres
)
echo.    [OK] Postgres ready

echo.
echo === Applying migrations...
set "DB_HOST=localhost"
set "DB_PORT=5432"
set "DB_USER=darex"
set "DB_PASSWORD=darex_dev_secret"
set "DB_NAME=darex"
call node "%ROOT%\infra\db\migrate.js"
if errorlevel 1 exit /b 1

if "%DO_SEED%"=="1" (
  echo.
  echo === Seeding database...
  call node "%ROOT%\infra\db\seed.js"
)

if "%DO_DEV%"=="0" (
  echo.
  echo === Waiting for dashboard health...
  set "tries=0"
  :wait_dashboard
  timeout /t 2 /nobreak >nul
  curl -s "http://localhost:3000/api/health" >nul 2>&1
  if errorlevel 1 (
    set /a tries+=1
    if !tries! lss 90 (
      goto wait_dashboard
    )
  )
)

call :run_checks
call :print_urls

if "%DO_DEV%"=="1" (
  echo.
  echo === Starting host dashboard (pnpm dev)...
  call pnpm --filter @darex/dashboard dev
)

exit /b 0

REM =========================================================================
REM FUNCTIONS
REM =========================================================================

:run_checks
  echo.
  echo === Running health probes...
  node "%ROOT%\infra\scripts\check-phase0.js" >nul 2>&1
  if exist "%ROOT%\infra\scripts\check-auth-nango.js" (
    node "%ROOT%\infra\scripts\check-auth-nango.js" >nul 2>&1
  )
  curl -s "http://localhost:3000/api/health" >nul 2>&1
  if errorlevel 1 (
    echo.    [WAIT] dashboard /api/health not up yet
  ) else (
    echo.    [PASS] dashboard /api/health
  )
  exit /b 0

:print_urls
  echo.
  echo ----------------------------------------------------------
  echo Darex is up (local). Open:
  echo.
  echo   Dashboard     http://localhost:3000
  echo   Nango OAuth   http://localhost:3003
  echo   Langfuse      http://localhost:3002
  echo   Temporal UI   http://localhost:8233
  echo   LiteLLM       http://localhost:4000
  echo   Inbox health  http://localhost:3004/health
  echo   atomic-agent  http://127.0.0.1:8787
  echo   MCP bridge    http://127.0.0.1:8790/sse
  echo.
  echo First UI path: /register ^> /connectors ^> /ask-ai
  echo.
  echo Still operator:
  echo   - NANGO_SECRET_KEY must be Nango's UUID
  echo   - Real OAuth client IDs in Nango UI
  echo   - Rotate META_ACCESS_TOKEN if WhatsApp outbound 401s
  echo   - JINA_API_KEY for web_search / web_extract
  echo.
  echo Logs:  pnpm infra:logs
  echo Stop:  start.bat --down
  echo ----------------------------------------------------------
  exit /b 0

:show_help
  echo Darex local start script
  echo.
  echo Usage:
  echo   start.bat              full compose + migrate + health checks
  echo   start.bat --dev        infra without dashboard, then dev server
  echo   start.bat --no-build   skip image rebuild
  echo   start.bat --seed       also run db:seed
  echo   start.bat --checks     probes only
  echo   start.bat --down       stop compose
  exit /b 0
