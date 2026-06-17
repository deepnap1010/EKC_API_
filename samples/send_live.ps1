# Simulate a machine streaming LIVE telemetry to the EKC API.
# Posts one reading every second (change -IntervalSeconds for every 5s, etc.).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\samples\send_live.ps1
#   powershell -ExecutionPolicy Bypass -File .\samples\send_live.ps1 -IntervalSeconds 5

param(
  [string]$Url = "http://localhost:8000/api/v1/ingest",
  [string]$MachineId = "EKC_CNC_MACHINING_01",
  [int]$IntervalSeconds = 1
)

Write-Host "Streaming live telemetry to $Url every $IntervalSeconds s. Press Ctrl+C to stop."

while ($true) {
  $body = @{
    machineId   = $MachineId
    machineName = "CNC Machine 01"
    machineType = "CNC Machining"
    department  = "Production Floor A"
    timestamp   = (Get-Date).ToUniversalTime().ToString("o")
    # eventId makes retransmits idempotent (safe to resend on a network blip).
    eventId     = "$MachineId-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    data = @{
      spindleSpeed = Get-Random -Minimum 1500 -Maximum 2200
      feedRate     = Get-Random -Minimum 150  -Maximum 260
      toolTemp     = Get-Random -Minimum 38   -Maximum 55
      coolantFlow  = Get-Random -Minimum 10   -Maximum 20
    }
  } | ConvertTo-Json -Depth 5

  try {
    $r = Invoke-RestMethod -Uri $Url -Method Post -ContentType "application/json" -Body $body
    Write-Host ("ok   id={0}  dup={1}" -f $r.id, $r.duplicate)
  } catch {
    Write-Host ("ERR  {0}" -f $_.Exception.Message) -ForegroundColor Red
  }

  Start-Sleep -Seconds $IntervalSeconds
}
