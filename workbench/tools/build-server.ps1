param([string]$OutputPath)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$PSDefaultParameterValues['*:Encoding'] = 'utf8NoBOM'
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 required.' }
$taskProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskServer = [IO.Path]::GetFullPath((Join-Path $taskProject '..\test-server'))
$taskApi = Join-Path $taskServer 'libraries\io\papermc\paper\paper-api\1.20.1-R0.1-SNAPSHOT\paper-api-1.20.1-R0.1-SNAPSHOT.jar'
$taskGson = Join-Path $taskServer 'libraries\com\google\code\gson\gson\2.10\gson-2.10.jar'
$taskClasses = Join-Path $taskProject ('native-build/server-plugin/classes-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($taskClasses) | Out-Null
$taskAdventure = @(Get-ChildItem -LiteralPath (Join-Path $taskServer 'libraries\net\kyori') -Recurse -File -Filter '*.jar' | ForEach-Object { $_.FullName })
$taskClasspath = (@($taskApi, $taskGson) + $taskAdventure) -join ';'
$sources = @('TerraWeave.java','PaperBlockEntityCodec.java') | ForEach-Object { Join-Path $taskProject ('server-plugin\' + $_) }
& (Get-Command javac.exe -ErrorAction Stop).Source -encoding UTF-8 --release 17 -cp $taskClasspath -d $taskClasses $sources
if ($LASTEXITCODE -ne 0) { throw 'Live plugin compilation failed.' }
Copy-Item -LiteralPath (Join-Path $taskProject 'server-plugin\plugin.yml') -Destination (Join-Path $taskClasses 'plugin.yml')
$manifest = Join-Path $taskClasses 'META-INF'
[IO.Directory]::CreateDirectory($manifest) | Out-Null
[IO.File]::WriteAllText((Join-Path $manifest 'MANIFEST.MF'), "Manifest-Version: 1.0`r`npaperweight-mappings-namespace: mojang`r`n`r`n", [Text.UTF8Encoding]::new($false))
if (!$OutputPath) { $OutputPath = Join-Path $taskProject 'packages/TerraWeave.jar' }
$taskJar = [IO.Path]::GetFullPath($OutputPath)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($taskJar)) | Out-Null
$pending = $taskJar + '.' + [guid]::NewGuid().ToString('N') + '.pending'
[IO.Compression.ZipFile]::CreateFromDirectory($taskClasses, $pending)
[IO.File]::Move($pending, $taskJar, $true)
Write-Output $taskJar
