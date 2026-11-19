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
$taskClasses = Join-Path $taskProject 'server-plugin\build'
[IO.Directory]::CreateDirectory($taskClasses) | Out-Null
$taskAdventure = @(Get-ChildItem -LiteralPath (Join-Path $taskServer 'libraries\net\kyori') -Recurse -File -Filter '*.jar' | ForEach-Object { $_.FullName })
$taskClasspath = (@($taskApi, $taskGson) + $taskAdventure) -join ';'
& (Get-Command javac.exe -ErrorAction Stop).Source -encoding UTF-8 --release 17 -cp $taskClasspath -d $taskClasses (Join-Path $taskProject 'server-plugin\WorkbenchLive.java')
if ($LASTEXITCODE -ne 0) { throw 'Live plugin compilation failed.' }
Copy-Item -LiteralPath (Join-Path $taskProject 'server-plugin\plugin.yml') -Destination (Join-Path $taskClasses 'plugin.yml')
$taskJar = Join-Path $taskServer 'plugins\WorkbenchLive.jar'
if (Test-Path -LiteralPath $taskJar) { Copy-Item -LiteralPath $taskJar -Destination ($taskJar + '.previous') -Force }
$taskZip = Join-Path $taskProject 'server-plugin\WorkbenchLive.build.zip'
if (Test-Path -LiteralPath $taskZip) { Remove-Item -LiteralPath (Resolve-Path -LiteralPath $taskZip).Path -Force }
[IO.Compression.ZipFile]::CreateFromDirectory($taskClasses, $taskZip)
Copy-Item -LiteralPath $taskZip -Destination $taskJar -Force
Remove-Item -LiteralPath $taskZip
Write-Output ('Built persistent test-server plugin: ' + $taskJar)
