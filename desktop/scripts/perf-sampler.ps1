# Samples system-wide load every few seconds into a CSV, for the build timing
# report of scripts/desktop-build.mjs (--measure). Uses the WMI performance
# classes: their names are not translated (typeperf/Get-Counter counter names
# are, e.g. on a Turkish Windows). Stops when -StopFile exists.
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [Parameter(Mandatory = $true)][string]$StopFile,
    [int]$IntervalMs = 2000
)
$ErrorActionPreference = "SilentlyContinue"
"epoch_ms,cpu_pct,committed_mb,available_mb,disk_write_bps,disk_read_bps,net_rx_bps,wsl_ws_mb" | Out-File -FilePath $Out -Encoding ascii
while (-not (Test-Path $StopFile)) {
    $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $p = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
    $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
    $d = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
    $n = (Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Measure-Object BytesReceivedPersec -Sum).Sum
    $v = (Get-Process vmmem* | Measure-Object WorkingSet64 -Sum).Sum
    "{0},{1},{2},{3},{4},{5},{6},{7}" -f $t, $p.PercentProcessorTime, [math]::Round($m.CommittedBytes / 1MB),
        $m.AvailableMBytes, $d.DiskWriteBytesPersec, $d.DiskReadBytesPersec, $n, [math]::Round($v / 1MB) |
        Out-File -FilePath $Out -Append -Encoding ascii
    Start-Sleep -Milliseconds $IntervalMs
}
