<#
.SYNOPSIS
Stop only processes recorded by start-local.ps1, preserving PostgreSQL data.
.DESCRIPTION
PID, executable path and process creation time must all match before termination.
An existing PostgreSQL cluster reused by the launcher remains running.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$statePath = Join-Path $projectRoot '.local/processes.json'
if (-not (Test-Path -LiteralPath $statePath)) {
    Write-Host 'No recorded local runtime. Existing processes were left running.'
    return
}
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if ($state.projectRoot -ne $projectRoot) { throw 'The runtime state belongs to another project directory.' }

function Find-OwnedProcess($Record) {
    $process = Get-Process -Id $Record.id -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne $Record.startUtcTicks -or $process.Path -ne $Record.path) {
        Write-Warning "Skipped $($Record.name): PID $($Record.id) no longer identifies the recorded process."
        return $null
    }
    return $process
}

# Capture a restarted generator only if its parent is still the recorded engine
# and its executable is exactly this project's generator. Save its identity first.
$engineRecord = @($state.processes | Where-Object { $_.name -eq 'engine' }) | Select-Object -First 1
if ($engineRecord) {
    $engine = Find-OwnedProcess $engineRecord
    if ($engine) {
        $generatorPath = Join-Path $projectRoot 'data_generator/build/transaction_generator.exe'
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($engine.Id)" |
            Where-Object { $_.ExecutablePath -eq $generatorPath })
        foreach ($child in $children) {
            $process = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
            if ($process -and $process.StartTime -ge $engine.StartTime) {
                $identity = $process.StartTime.ToUniversalTime().Ticks.ToString()
                $alreadyRecorded = @($state.processes | Where-Object { $_.id -eq $process.Id -and $_.startUtcTicks -eq $identity }).Count -gt 0
                if (-not $alreadyRecorded) {
                    $state.processes += [pscustomobject]@{ name = 'generator'; id = $process.Id; path = $process.Path; startUtcTicks = $identity }
                }
            }
        }
        $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
    }
}

# Stop the reader before its child so its restart monitor cannot spawn another child.
foreach ($name in @('api', 'engine', 'generator')) {
    foreach ($record in @($state.processes | Where-Object { $_.name -eq $name })) {
        $process = Find-OwnedProcess $record
        if ($process) {
            Stop-Process -InputObject $process -Force
            Wait-Process -Id $record.id -Timeout 10 -ErrorAction SilentlyContinue
            Write-Host "Stopped $name (PID $($record.id))."
        }
    }
}
$state.processes = @()
if ($state.postgres.owned) {
    $expectedData = [IO.Path]::GetFullPath((Join-Path $projectRoot '.local/pgdata'))
    $recordedData = [IO.Path]::GetFullPath($state.postgres.dataDirectory)
    if ($recordedData -ne $expectedData) { throw 'Refusing to stop PostgreSQL outside this project runtime directory.' }
    $databaseRecord = [pscustomobject]@{
        name = 'postgres'; id = $state.postgres.id; path = $state.postgres.path; startUtcTicks = $state.postgres.startUtcTicks
    }
    $database = Find-OwnedProcess $databaseRecord
    if ($database) {
        $pidFile = Join-Path $recordedData 'postmaster.pid'
        if (-not (Test-Path -LiteralPath $pidFile) -or [int](Get-Content -LiteralPath $pidFile -TotalCount 1) -ne $database.Id) {
            throw 'PostgreSQL PID file does not match the recorded server. It was left running.'
        }
        & $state.postgres.pgCtl stop -D $recordedData -m fast -w -t 30
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not stop; runtime state was preserved for inspection.' }
        Write-Host 'Stopped the PostgreSQL cluster started by this launcher.'
    }
    $state.postgres.owned = $false
}
$state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
Write-Host 'Recorded local services stopped. Database files were preserved.'
