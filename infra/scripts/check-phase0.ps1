##############################################################################
# Phase 0 Exit Criteria Verification Script
# Checks all infra services are running and healthy.
# Run after: docker-compose -f infra/docker-compose.yml up -d
##############################################################################

Write-Host "`n=== Darex Phase 0 — Exit Criteria Check ===" -ForegroundColor Cyan
Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n"

$pass = 0
$fail = 0

# 1. Check containers are running
Write-Host "--- Container Status ---"
$containers = @(
    "darex-postgres",
    "darex-temporal",
    "darex-temporal-ui",
    "darex-redis",
    "darex-nango",
    "darex-langfuse-clickhouse",
    "darex-langfuse-minio",
    "darex-langfuse-server",
    "darex-langfuse-worker",
    "darex-litellm"
)
foreach ($c in $containers) {
    $state = (docker inspect --format='{{.State.Status}}' $c 2>$null).Trim()
    if ($state -eq "running") {
        Write-Host "  [PASS] $c is running" -ForegroundColor Green
        $pass++
    } else {
        Write-Host "  [FAIL] $c — state: $state" -ForegroundColor Red
        $fail++
    }
}

# 2. Check service healthchecks
Write-Host "`n--- Service Health ---"

# Postgres
try {
    $res = docker exec darex-postgres pg_isready -U darex -d darex 2>&1
    if ($res -match "accepting connections") {
        Write-Host "  [PASS] Postgres (pg_isready)" -ForegroundColor Green
        $pass++
    } else {
        Write-Host "  [FAIL] Postgres (pg_isready) — $res" -ForegroundColor Red
        $fail++
    }
} catch {
    Write-Host "  [FAIL] Postgres (pg_isready) — $_" -ForegroundColor Red
    $fail++
}

# Postgres pgvector extension
try {
    $res = docker exec darex-postgres psql -U darex -d darex -c "SELECT extname FROM pg_extension WHERE extname='vector';" 2>&1
    if ($res -match "vector") {
        Write-Host "  [PASS] pgvector extension enabled" -ForegroundColor Green
        $pass++
    } else {
        Write-Host "  [FAIL] pgvector extension enabled — $res" -ForegroundColor Red
        $fail++
    }
} catch {
    Write-Host "  [FAIL] pgvector extension enabled — $_" -ForegroundColor Red
    $fail++
}

# Temporal gRPC
try {
    $res = docker exec darex-temporal temporal operator namespace list --address temporal:7233 2>&1
    if ($res -match "default") {
        Write-Host "  [PASS] Temporal (namespace list)" -ForegroundColor Green
        $pass++
    } else {
        Write-Host "  [FAIL] Temporal (namespace list) — $res" -ForegroundColor Red
        $fail++
    }
} catch {
    Write-Host "  [FAIL] Temporal (namespace list) — $_" -ForegroundColor Red
    $fail++
}

# Redis
try {
    $res = docker exec darex-redis redis-cli ping 2>&1
    if ($res -match "PONG") {
        Write-Host "  [PASS] Redis (PING)" -ForegroundColor Green
        $pass++
    } else {
        Write-Host "  [FAIL] Redis (PING) — $res" -ForegroundColor Red
        $fail++
    }
} catch {
    Write-Host "  [FAIL] Redis (PING) — $_" -ForegroundColor Red
    $fail++
}

# Nango API
try {
    $res = (Invoke-WebRequest -Uri "http://localhost:3003/health" -UseBasicParsing -TimeoutSec 5 2>&1).StatusCode
    if ($res -eq 200) {
        Write-Host "  [PASS] Nango API (/health)" -ForegroundColor Green
        $pass++
    } else {
        Write-Host "  [FAIL] Nango API (/health) — status $res" -ForegroundColor Red
        $fail++
    }
} catch {
    Write-Host "  [FAIL] Nango API (/health) — $_" -ForegroundColor Red
    $fail++
}

# Langfuse API
try {
    $res = (Invoke-WebRequest -Uri "http://localhost:3002/api/public/health" -UseBasicParsing -TimeoutSec 10 2>&1).StatusCode
    if ($res -eq 200) {
        Write-Host "  [PASS] Langfuse API (/api/public/health)" -ForegroundColor Green
        $pass++
    } else {
        Write-Host "  [FAIL] Langfuse API (/api/public/health) — status $res" -ForegroundColor Red
        $fail++
    }
} catch {
    Write-Host "  [FAIL] Langfuse API (/api/public/health) — $_" -ForegroundColor Red
    $fail++
}

# LiteLLM
try {
    $res = (Invoke-WebRequest -Uri "http://localhost:4000/health" -UseBasicParsing -TimeoutSec 5 2>&1).StatusCode
    if ($res -eq 200) {
        Write-Host "  [PASS] LiteLLM (/health)" -ForegroundColor Green
        $pass++
    } else {
        Write-Host "  [FAIL] LiteLLM (/health) — status $res" -ForegroundColor Red
        $fail++
    }
} catch {
    Write-Host "  [FAIL] LiteLLM (/health) — $_" -ForegroundColor Red
    $fail++
}

# 3. Summary
Write-Host "`n--- Summary ---"
$total = $pass + $fail
if ($fail -eq 0) {
    Write-Host "  ALL CHECKS PASSED ($pass/$total) — Phase 0 exit criteria MET!" -ForegroundColor Green
    Write-Host "`n  Services available at:"
    Write-Host "    Temporal UI:  http://localhost:8233"
    Write-Host "    Langfuse:     http://localhost:3002  (admin@darex.dev / darex_admin_dev)"
    Write-Host "    Nango:        http://localhost:3003"
    Write-Host "    LiteLLM:      http://localhost:4000"
    Write-Host "    Postgres:     localhost:5432  (darex / darex_dev_secret)"
} else {
    Write-Host "  $fail/$total CHECKS FAILED — fix before proceeding to Phase 1" -ForegroundColor Red
}
