$ErrorActionPreference = 'Stop'
$apiRoot = $PSScriptRoot
$jdbcVersion = '42.7.13'
$jdbcHash = '6E0E4CC2D8CAE902084F8A2B18728B073A6FD9D1F87C9D8BFF8F298C18185B93'
$apiLibraries = Join-Path $apiRoot 'lib'
$apiClasses = Join-Path $apiRoot 'build/classes'
New-Item -ItemType Directory -Force -Path $apiLibraries, $apiClasses | Out-Null
$jdbcJar = Join-Path $apiLibraries "postgresql-$jdbcVersion.jar"
if (-not (Test-Path -LiteralPath $jdbcJar)) {
    Invoke-WebRequest -Uri "https://jdbc.postgresql.org/download/postgresql-$jdbcVersion.jar" -OutFile $jdbcJar
}
if ((Get-FileHash -LiteralPath $jdbcJar -Algorithm SHA256).Hash -ne $jdbcHash) {
    throw 'JDBC driver checksum mismatch. Remove the downloaded JAR and retry.'
}
$javaSources = Get-ChildItem -LiteralPath (Join-Path $apiRoot 'src/opentrace') -Filter '*.java'
& javac --release 21 -d $apiClasses $javaSources.FullName
if ($LASTEXITCODE -ne 0) { throw 'Java compilation failed.' }
Write-Host 'Java API compiled. Start it with:'
Write-Host "java -cp `"$apiClasses;$jdbcJar`" opentrace.Main"
