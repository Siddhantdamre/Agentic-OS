# RECLAIM THE DOCKER DISK — RIGHT-CLICK THIS FILE AND "RUN WITH POWERSHELL AS ADMINISTRATOR".
#
# Docker's virtual disk grows and never shrinks by itself. On this machine it
# reached 96 GB while C: had 0.4 GB free out of 455 GB — which is why the Docker
# daemon stopped responding entirely ("context deadline exceeded" on ping) and
# why builds and agent turns had been failing in ways that looked like code bugs.
#
# Pruning inside Docker frees space INSIDE the virtual disk but does not return
# it to Windows. Only compacting does, and compacting needs Administrator. That
# is the single step this script exists for.
#
# NOTHING IS DELETED HERE. No volumes, no database, no images. It stops Docker,
# hands the unused blocks back to Windows, and starts Docker again. Your
# postgres data survives — it lives in a Docker volume, which compaction does
# not touch.
#
# Takes 5-20 minutes depending on disk size. Do not interrupt it once "compact
# vdisk" starts.

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host ""
  Write-Host "  NOT RUNNING AS ADMINISTRATOR." -ForegroundColor Red
  Write-Host "  Close this, right-click the file, and choose"
  Write-Host "  'Run with PowerShell' from an elevated prompt — or open PowerShell"
  Write-Host "  as Administrator and run:"
  Write-Host ""
  Write-Host "      powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  Write-Host ""
  exit 1
}

$vhd = "$env:LOCALAPPDATA\Docker\wsl\disk\docker_data.vhdx"
if (-not (Test-Path $vhd)) {
  # Older Docker Desktop layouts keep it under a docker-desktop-data distro.
  $alt = "$env:LOCALAPPDATA\Docker\wsl\data\ext4.vhdx"
  if (Test-Path $alt) { $vhd = $alt } else {
    Write-Host "  Could not find Docker's virtual disk. Looked in:" -ForegroundColor Red
    Write-Host "    $vhd"
    Write-Host "    $alt"
    exit 1
  }
}

function FreeGB { [math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace/1GB, 2) }
function DiskGB { [math]::Round((Get-Item $vhd).Length/1GB, 2) }

Write-Host ""
Write-Host "  disk file : $vhd"
Write-Host ("  size now  : {0} GB" -f (DiskGB))
Write-Host ("  C: free   : {0} GB" -f (FreeGB))
Write-Host ""

# ── 1. Free space inside the disk first, so there is something to reclaim ────
#
# Build cache and unused images only. `volume prune` is deliberately NOT here:
# that is where the database lives.
Write-Host "  [1/4] pruning build cache and unused images (no volumes)..." -ForegroundColor Cyan
try {
  docker builder prune -a -f    2>&1 | Select-Object -Last 1
  docker image prune -a -f      2>&1 | Select-Object -Last 1
  docker container prune -f     2>&1 | Select-Object -Last 1
} catch {
  Write-Host "        docker was not responding; continuing to the compaction step anyway."
}

# ── 2. Stop Docker and the WSL VM that holds the disk open ───────────────────
Write-Host "  [2/4] stopping Docker Desktop and WSL..." -ForegroundColor Cyan
Get-Process "Docker Desktop","com.docker.backend","com.docker.build" -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 6
wsl --shutdown | Out-Null
Start-Sleep -Seconds 10

# ── 3. Hand the unused blocks back to Windows ────────────────────────────────
#
# attach readonly first: it lets diskpart see the filesystem without any risk
# of writing to it.
Write-Host "  [3/4] compacting — this is the slow part, do not interrupt..." -ForegroundColor Cyan
$script = @"
select vdisk file="$vhd"
attach vdisk readonly
compact vdisk
detach vdisk
exit
"@
$tmp = Join-Path $env:TEMP "darex-compact-vdisk.txt"
$script | Set-Content $tmp -Encoding Ascii
diskpart /s $tmp | Select-Object -Last 8
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

$sizeAfter = DiskGB
Write-Host ""
Write-Host ("  disk file : {0} GB  (was reported above)" -f $sizeAfter) -ForegroundColor Green
Write-Host ("  C: free   : {0} GB" -f (FreeGB)) -ForegroundColor Green

# ── 4. Bring Docker back ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "  [4/4] starting Docker Desktop..." -ForegroundColor Cyan
$exe = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
if (-not (Test-Path $exe)) { $exe = "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe" }
if (Test-Path $exe) {
  Start-Process $exe
  Write-Host "        started. The daemon takes a minute or two to accept commands."
} else {
  Write-Host "        Docker Desktop.exe not found — start it from the Start menu."
}

Write-Host ""
Write-Host "  Then bring the stack back up:" -ForegroundColor Yellow
Write-Host "      cd infra"
Write-Host "      docker compose up -d"
Write-Host ""
Write-Host "  Your data is untouched. Verify with:" -ForegroundColor Yellow
Write-Host "      docker compose exec -T postgres psql -U darex -d darex -c 'select count(*) from orgs;'"
Write-Host ""
