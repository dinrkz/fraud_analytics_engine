<#
.SYNOPSIS
Build and start the optional Windows runtime without installing system software.
.DESCRIPTION
Requires Python 3.10+ with pip, PostgreSQL 14+ tools, a C++17 compiler, and JDK 21+.
Docker Compose is the primary deployment path. Existing unrelated listeners are never stopped.
The default database password is for this loopback-only demonstration. Override DB_PASSWORD
before first initialization to choose another password. Logs and process identities live in .local.
#>
[CmdletBinding()]
param(
    [string]$PythonPath,
    [string]$PgBin,
    [string]$GppPath,
    [string]$JavaPath,
    [ValidateRange(0, 1000000000)][double]$Rate = 20,
    [ValidateRange(2, 1000000)][int]$Users = 1000,
    [ValidateRange(0, 1)][double]$FraudRate = 0.08
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$localRoot = Join-Path $projectRoot '.local'
$dataDirectory = Join-Path $localRoot 'pgdata'
$statePath = Join-Path $localRoot 'processes.json'
$logDirectory = Join-Path $localRoot 'logs'

function Find-Tool([string]$ExplicitPath, [string]$CommandName, [string[]]$Candidates) {
    if ($ExplicitPath) {
        if (Test-Path -LiteralPath $ExplicitPath -PathType Leaf) {
            return (Resolve-Path -LiteralPath $ExplicitPath).Path
        }
        $specified = Get-Command $ExplicitPath -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($specified) { return $specified.Source }
        throw "Tool not found: $ExplicitPath"
    }
    $found = Get-Command $CommandName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found -and $found.Source -notmatch '\\WindowsApps\\') { return $found.Source }
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    throw "$CommandName was not found. Supply its path as a script parameter, or use Docker Compose."
}

function Get-RecordedProcess($Record) {
    $process = Get-Process -Id $Record.id -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $Record.startUtcTicks -and
        $process.Path -eq $Record.path) { return $process }
    return $null
}

function Assert-PortFree([int]$Port) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() }
    catch { throw "Port $Port is already occupied. Existing processes were left running. Use scripts/stop-local.ps1 for a recorded OpenTrace run, or choose Docker Compose." }
    finally { $listener.Stop() }
}

function Save-State {
    $script:runtimeState | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Record-Process([string]$Name, $Process) {
    $Process.Refresh()
    if ($Process.HasExited) { throw "$Name exited during startup. Inspect $logDirectory." }
    $record = [ordered]@{
        name = $Name
        id = $Process.Id
        path = $Process.Path
        startUtcTicks = $Process.StartTime.ToUniversalTime().Ticks.ToString()
    }
    $script:runtimeState.processes += $record
    Save-State
}

function Wait-Ready([string]$Url, $Process, [string]$Name) {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "$Name exited. Inspect $logDirectory." }
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    throw "$Name did not become ready at $Url. Inspect $logDirectory."
}

$previous = $null
if (Test-Path -LiteralPath $statePath) {
    $previous = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($previous.projectRoot -ne $projectRoot) { throw 'The runtime state belongs to a different project directory.' }
    $active = @($previous.processes | Where-Object { Get-RecordedProcess $_ })
    if (@($active | Where-Object { $_.name -eq 'engine' }).Count -eq 1 -and
        @($active | Where-Object { $_.name -eq 'api' }).Count -eq 1) {
        Write-Host 'Recorded OpenTrace processes are already running: http://localhost:8080'
        return
    }
    if ($active.Count -gt 0) { throw 'Part of a previous OpenTrace run is still active. Run scripts/stop-local.ps1 before restarting.' }
}
Assert-PortFree 8000
Assert-PortFree 8080

$programFilesRoot = [Environment]::GetFolderPath('ProgramFiles')
$postgresCandidates = @()
$postgresInstallations = Join-Path $programFilesRoot 'PostgreSQL'
if (Test-Path -LiteralPath $postgresInstallations) {
    $postgresCandidates = @(Get-ChildItem -LiteralPath $postgresInstallations -Directory |
        Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'bin/pg_ctl.exe' })
}
$pgCtl = Find-Tool $(if ($PgBin) { Join-Path $PgBin 'pg_ctl.exe' }) 'pg_ctl' $postgresCandidates
$PgBin = Split-Path -Parent $pgCtl
$psql = Join-Path $PgBin 'psql.exe'
$initdb = Join-Path $PgBin 'initdb.exe'
foreach ($required in @($psql, $initdb)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "PostgreSQL installation is incomplete: $required" }
}
$pythonCandidates = @($postgresCandidates | ForEach-Object {
    Join-Path (Split-Path -Parent (Split-Path -Parent $_)) 'pgAdmin 4/python/python.exe'
})
$PythonPath = Find-Tool $PythonPath 'python' $pythonCandidates
$compilerCandidates = @()
$jetbrainsRoot = Join-Path $programFilesRoot 'JetBrains'
if (Test-Path -LiteralPath $jetbrainsRoot) {
    $compilerCandidates = @(Get-ChildItem -LiteralPath $jetbrainsRoot -Directory -Filter 'CLion*' |
        Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'bin/mingw/bin/g++.exe' })
}
$GppPath = Find-Tool $GppPath 'g++' $compilerCandidates
$JavaPath = Find-Tool $JavaPath 'java' @()
$javaBin = Split-Path -Parent $JavaPath
if (-not (Test-Path -LiteralPath (Join-Path $javaBin 'javac.exe'))) {
    throw 'JavaPath must belong to a JDK with javac, not a JRE. JDK 21 or newer is required.'
}
Write-Host "Python: $PythonPath"
Write-Host "PostgreSQL tools: $PgBin"
Write-Host "C++ compiler: $GppPath"
Write-Host "Java: $JavaPath"

$environmentNames = @('PATH', 'PGPASSWORD', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
    'AUTO_GENERATE', 'GENERATOR_PATH', 'GENERATOR_RATE', 'GENERATOR_USERS', 'FRAUD_RATE',
    'ROOT_PATH', 'ENGINE_HOST', 'ENGINE_PORT', 'ENGINE_URL', 'API_HOST', 'API_PORT', 'STATIC_DIR')
$savedEnvironment = @{}
foreach ($name in $environmentNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$runtimeState = [ordered]@{
    version = 1
    projectRoot = $projectRoot
    processes = @()
    postgres = [ordered]@{ owned = $false; dataDirectory = $dataDirectory; pgCtl = $pgCtl; id = 0; startUtcTicks = ''; path = '' }
}
if ($previous -and $previous.postgres.owned -and $previous.postgres.dataDirectory -eq $dataDirectory) {
    if (Get-RecordedProcess $previous.postgres) { $runtimeState.postgres = $previous.postgres }
}
try {
    New-Item -ItemType Directory -Force -Path $localRoot, $logDirectory, (Join-Path $projectRoot 'data_generator/build') | Out-Null
    $env:PATH = "$javaBin;$(Split-Path -Parent $GppPath);$PgBin;$env:PATH"
    $generator = Join-Path $projectRoot 'data_generator/build/transaction_generator.exe'
    & $GppPath -std=c++17 -O2 -Wall -Wextra -Wpedantic -o $generator (Join-Path $projectRoot 'data_generator/src/main.cpp')
    if ($LASTEXITCODE -ne 0) { throw 'C++ generator compilation failed.' }
    try {
        & $generator --help | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Generator returned a nonzero status.' }
    } catch {
        throw "The compiled generator cannot execute. Windows application control may block it (WinError 4551). Use Docker Compose or an administrator-approved compiler/runtime; do not disable or bypass policy. Details: $($_.Exception.Message)"
    }

    & $PythonPath -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 or newer is required.' }
    & $PythonPath -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('venv') else 1)"
    $hasVenv = $LASTEXITCODE -eq 0
    if ($hasVenv) {
        $venvPython = Join-Path $projectRoot '.venv/Scripts/python.exe'
        if (-not (Test-Path -LiteralPath $venvPython)) {
            & $PythonPath -m venv (Join-Path $projectRoot '.venv')
            if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment creation failed.' }
        }
        $enginePython = $venvPython
        & $enginePython -m pip install -r (Join-Path $projectRoot 'analytics_engine/requirements.txt')
    } else {
        $enginePython = $PythonPath
        & $enginePython -m pip install --upgrade --target (Join-Path $localRoot 'python-packages') -r (Join-Path $projectRoot 'analytics_engine/requirements.txt')
    }
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Python must have pip and network access; no system components were installed.' }
    & (Join-Path $projectRoot 'backend_api/build.ps1')

    $env:DB_HOST = '127.0.0.1'
    $env:DB_PORT = '55432'
    $env:DB_NAME = 'opentrace'
    $env:DB_USER = 'opentrace'
    if (-not $env:DB_PASSWORD) { $env:DB_PASSWORD = 'opentrace_local' }
    $env:PGPASSWORD = $env:DB_PASSWORD
    if (-not (Test-Path -LiteralPath (Join-Path $dataDirectory 'PG_VERSION'))) {
        if ((Test-Path -LiteralPath $dataDirectory) -and @(Get-ChildItem -LiteralPath $dataDirectory -Force).Count -gt 0) {
            throw "Refusing to initialize a nonempty directory without PG_VERSION: $dataDirectory"
        }
        $passwordFile = Join-Path $localRoot ('.pg-password-' + [Guid]::NewGuid().ToString('N'))
        try {
            [IO.File]::WriteAllText($passwordFile, $env:DB_PASSWORD + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
            & $initdb -D $dataDirectory -U opentrace --auth-host=scram-sha-256 --auth-local=scram-sha-256 --encoding=UTF8 --pwfile=$passwordFile
            if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL initialization failed.' }
        } finally {
            if (Test-Path -LiteralPath $passwordFile) { Remove-Item -LiteralPath $passwordFile -Force }
        }
    }
    & $pgCtl status -D $dataDirectory *> $null
    $databaseAlreadyRunning = $LASTEXITCODE -eq 0
    if (-not $databaseAlreadyRunning) {
        Assert-PortFree 55432
        & $pgCtl start -D $dataDirectory -l (Join-Path $logDirectory 'postgres.log') -o '-h 127.0.0.1 -p 55432' -w -t 30
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL startup failed.' }
        $databaseProcessId = [int](Get-Content -LiteralPath (Join-Path $dataDirectory 'postmaster.pid') -TotalCount 1)
        $databaseProcess = Get-Process -Id $databaseProcessId
        $runtimeState.postgres.owned = $true
        $runtimeState.postgres.id = $databaseProcessId
        $runtimeState.postgres.path = $databaseProcess.Path
        $runtimeState.postgres.startUtcTicks = $databaseProcess.StartTime.ToUniversalTime().Ticks.ToString()
        Save-State
    }
    $dbExists = & $psql -h 127.0.0.1 -p 55432 -U opentrace -d postgres -w -t -A -c "SELECT 1 FROM pg_database WHERE datname='opentrace'"
    if ($LASTEXITCODE -ne 0) { throw 'Cannot authenticate to the local PostgreSQL cluster. Check DB_PASSWORD for this existing cluster.' }
    if (($dbExists -join '').Trim() -ne '1') {
        & $psql -h 127.0.0.1 -p 55432 -U opentrace -d postgres -w -v ON_ERROR_STOP=1 -c 'CREATE DATABASE opentrace'
        if ($LASTEXITCODE -ne 0) { throw 'Database creation failed.' }
    }
    & $psql -h 127.0.0.1 -p 55432 -U opentrace -d opentrace -w -v ON_ERROR_STOP=1 -f (Join-Path $projectRoot 'db/init/001_schema.sql')
    if ($LASTEXITCODE -ne 0) { throw 'Runtime schema initialization failed. Use a fresh OpenTrace database, not the original v1 export.' }

    $env:AUTO_GENERATE = 'true'
    $env:GENERATOR_PATH = $generator
    $env:GENERATOR_RATE = $Rate.ToString([Globalization.CultureInfo]::InvariantCulture)
    $env:GENERATOR_USERS = $Users.ToString([Globalization.CultureInfo]::InvariantCulture)
    $env:FRAUD_RATE = $FraudRate.ToString([Globalization.CultureInfo]::InvariantCulture)
    $env:ROOT_PATH = '/engine'
    $env:ENGINE_HOST = '127.0.0.1'
    $env:ENGINE_PORT = '8000'
    $env:ENGINE_URL = 'http://127.0.0.1:8000'
    $env:API_PORT = '8080'
    $env:API_HOST = '127.0.0.1'
    $env:STATIC_DIR = Join-Path $projectRoot 'frontend_dashboard'
    $engineScript = Join-Path $PSScriptRoot 'run_engine.py'
    $engineProcess = Start-Process -FilePath $enginePython -ArgumentList @('"' + $engineScript + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory 'engine.stdout.log') -RedirectStandardError (Join-Path $logDirectory 'engine.stderr.log')
    Record-Process 'engine' $engineProcess
    Wait-Ready 'http://127.0.0.1:8000/healthz' $engineProcess 'Analytics engine'
    $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($engineProcess.Id)" |
        Where-Object { $_.ExecutablePath -eq $generator } | Select-Object -First 1
    if ($child) { Record-Process 'generator' (Get-Process -Id $child.ProcessId) }
    $jdbcJar = Join-Path $projectRoot 'backend_api/lib/postgresql-42.7.13.jar'
    $classPath = (Join-Path $projectRoot 'backend_api/build/classes') + ';' + $jdbcJar
    $apiProcess = Start-Process -FilePath $JavaPath -ArgumentList @('-cp', ('"' + $classPath + '"'), 'opentrace.Main') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory 'api.stdout.log') -RedirectStandardError (Join-Path $logDirectory 'api.stderr.log')
    Record-Process 'api' $apiProcess
    Wait-Ready 'http://127.0.0.1:8080/healthz' $apiProcess 'Java API'
    Write-Host 'OpenTrace is running: http://localhost:8080'
    Write-Host 'Swagger: http://localhost:8080/engine/docs'
    Write-Host "Logs: $logDirectory"
    Write-Host 'Stop with scripts/stop-local.ps1. Database files are preserved.'
} catch {
    if (@($runtimeState.processes).Count -gt 0 -or $runtimeState.postgres.owned) {
        Write-Warning 'A partial runtime is recorded in .local/processes.json. Use scripts/stop-local.ps1 to stop only its owned processes.'
    }
    throw
} finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
