<#
.SYNOPSIS
  Smoke test of the Penforge desktop app on Windows.

.DESCRIPTION
  Optionally installs the NSIS installer silently (per user), then starts the app
  with --smoke on a fresh data folder: it boots PostgreSQL, the backend (with its
  migrations), media-processor and the daemon, checks the gateway, the local
  login and an authenticated RPC, and shuts everything down. The script samples
  the memory of the app's processes while it runs and checks afterwards that no
  postgres/java/node process of the app is left.

.EXAMPLE
  ./scripts/smoke.ps1 -App release/win-unpacked/Penforge.exe
  ./scripts/smoke.ps1 -Installer release/Penforge-Setup-0.1.0.exe
#>
param(
    [string]$App,
    [string]$Installer,
    [string]$DataDir,
    [int]$TimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'

if ($Installer) {
    $size = (Get-Item $Installer).Length
    Write-Host ("installer: {0} ({1:N1} MB)" -f $Installer, ($size / 1MB))
    $p = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
    if ($p.ExitCode -ne 0) { throw "installer exited with $($p.ExitCode)" }
    $App = Join-Path $env:LOCALAPPDATA 'Programs\Penforge\Penforge.exe'
}
if (-not $App -or -not (Test-Path $App)) { throw "app not found: $App" }
$App = (Resolve-Path $App).Path
$AppDir = Split-Path $App -Parent

$fresh = -not $DataDir
if ($fresh) {
    $DataDir = Join-Path ([IO.Path]::GetTempPath()) ("penforge-smoke-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
}
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$out = Join-Path $DataDir 'smoke-stdout.txt'
$err = Join-Path $DataDir 'smoke-stderr.txt'

function Get-AppProcesses {
    # every process whose executable lives in the install folder (Penforge.exe,
    # its Node children, java.exe, postgres.exe)
    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($AppDir, [StringComparison]::OrdinalIgnoreCase) }
}

$env:PENFORGE_DESKTOP_DATA = $DataDir
$started = Get-Date
$proc = Start-Process -FilePath $App -ArgumentList '--smoke' -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
$peak = 0
$peakDetail = ''
while (-not $proc.HasExited) {
    if (((Get-Date) - $started).TotalSeconds -gt $TimeoutSeconds) {
        Get-AppProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        throw "smoke run timed out after $TimeoutSeconds s"
    }
    $procs = @(Get-AppProcesses)
    $total = ($procs | Measure-Object -Property WorkingSetSize -Sum).Sum
    if ($total -gt $peak) {
        $peak = $total
        $peakDetail = ($procs | Group-Object Name | ForEach-Object {
            '{0}={1:N0}MB' -f $_.Name, (($_.Group | Measure-Object WorkingSetSize -Sum).Sum / 1MB)
        }) -join ' '
    }
    Start-Sleep -Milliseconds 1000
}
$proc.WaitForExit()
$elapsed = ((Get-Date) - $started).TotalSeconds
Start-Sleep -Seconds 2
$left = @(Get-AppProcesses)

Write-Host (Get-Content $out -Raw)
Write-Host ("exit code: {0}, total {1:N0} s" -f $proc.ExitCode, $elapsed)
Write-Host ("peak memory of the app's processes: {0:N0} MB ({1})" -f ($peak / 1MB), $peakDetail)
if ($left.Count -gt 0) {
    Write-Host ("LEFTOVER PROCESSES: " + (($left | ForEach-Object { "$($_.Name)#$($_.ProcessId)" }) -join ', '))
}
Write-Host "logs: $(Join-Path $DataDir 'logs')"

$ok = ($proc.ExitCode -eq 0) -and ($left.Count -eq 0)
if ($fresh -and $ok) {
    Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue
}
if (-not $ok) { exit 1 }
