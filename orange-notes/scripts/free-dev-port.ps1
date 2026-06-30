$ErrorActionPreference = "Stop"

$port = 1430
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue

foreach ($connection in $connections) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
  if (
    $process -and
    $process.Name -ieq "node.exe" -and
    $process.CommandLine -like "*vite*" -and
    $process.CommandLine -like "*$projectRoot*"
  ) {
    Stop-Process -Id $process.ProcessId -Force
  }
}
