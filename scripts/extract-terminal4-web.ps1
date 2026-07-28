$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tools = Join-Path $root '.tools\modelconverterx'
$out = Join-Path $root 'web-extract\terminal4'
$logs = Join-Path $root 'web-extract\logs'
$intermediate = Join-Path $root 'web-extract\intermediate'
New-Item -ItemType Directory -Force -Path $tools, $out, $logs, $intermediate | Out-Null

$zip = Join-Path $env:RUNNER_TEMP 'ModelConverterX_170.zip'
$download = 'https://www.scenerydesign.org/old-releases/stable/ModelConverterX_170.zip'
Write-Host "Downloading ModelConverterX 1.7 from $download"
Invoke-WebRequest -Uri $download -OutFile $zip -UseBasicParsing
Write-Host "Downloaded $((Get-Item $zip).Length) bytes"
Expand-Archive -Path $zip -DestinationPath $tools -Force

$mcx = Get-ChildItem -Path $tools -Filter 'ModelConverterX.exe' -Recurse | Select-Object -First 1
if (-not $mcx) { throw 'ModelConverterX.exe was not found after extraction' }
Write-Host "Using ModelConverterX: $($mcx.FullName)"
Write-Host "MCX file version: $($mcx.VersionInfo.FileVersion)"

function Invoke-BoundedProcess {
  param([string] $FilePath, [string[]] $Arguments, [string] $Name, [int] $TimeoutSeconds)
  $stdout = Join-Path $logs "$Name.stdout.txt"
  $stderr = Join-Path $logs "$Name.stderr.txt"
  Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue
  Write-Host "$Name args: $($Arguments -join ' ')"
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $finished = $process.WaitForExit($TimeoutSeconds * 1000)
  if (-not $finished) {
    Write-Host "$Name exceeded ${TimeoutSeconds}s; terminating full process tree $($process.Id)"
    & taskkill.exe /PID $process.Id /T /F 2>&1 | ForEach-Object { Write-Host "[taskkill] $_" }
    try { $process.WaitForExit(5000) | Out-Null } catch {}
  }
  if (Test-Path $stdout) { Get-Content $stdout | ForEach-Object { Write-Host "[$Name stdout] $_" } }
  if (Test-Path $stderr) { Get-Content $stderr | ForEach-Object { Write-Host "[$Name stderr] $_" } }
  return [pscustomobject]@{ TimedOut = -not $finished; ExitCode = if ($finished) { $process.ExitCode } else { 124 } }
}

$source = Join-Path $root 'scenery\term4.BGL'
if (-not (Test-Path $source)) { throw "Missing Terminal 4 source: $source" }

$textureDir = Join-Path $root 'texture'
New-Item -ItemType Directory -Force -Path $textureDir | Out-Null
$rootTextures = @(Get-ChildItem -Path $root -File | Where-Object { $_.Extension -match '^\.(bmp|dds)$' })
foreach ($texture in $rootTextures) { Copy-Item $texture.FullName -Destination (Join-Path $textureDir $texture.Name) -Force }
Write-Host "Staged $($rootTextures.Count) flattened root textures into $textureDir"

Get-ChildItem -Path $out -File -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem -Path $intermediate -File -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force

# MCX 1.7 performs only the proprietary BGL -> open OBJ extraction. Everything after this is ours.
$obj = Join-Path $intermediate 'terminal4.obj'
$objResult = Invoke-BoundedProcess -FilePath $mcx.FullName -Arguments @($source, '-out', $obj, '-format', 'OBJ') -Name 'mcx-obj' -TimeoutSeconds 75
if (-not (Test-Path $obj) -or (Get-Item $obj).Length -lt 1024) {
  throw "ModelConverterX did not produce usable OBJ geometry (exit=$($objResult.ExitCode), timedOut=$($objResult.TimedOut))"
}
Write-Host "MCX produced Terminal 4 OBJ: $((Get-Item $obj).Length) bytes"

$target = Join-Path $out 'terminal4.gltf'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$converter = Join-Path $root 'scripts\obj-to-gltf.mjs'
$convert = Invoke-BoundedProcess -FilePath $node -Arguments @($converter, $obj, $target) -Name 'obj-to-gltf' -TimeoutSeconds 90
if ($convert.ExitCode -ne 0 -or -not (Test-Path $target) -or (Get-Item $target).Length -lt 1024) {
  throw "Checked-in OBJ converter did not produce a usable glTF (exit=$($convert.ExitCode), timedOut=$($convert.TimedOut))"
}

$files = Get-ChildItem -Path $out -File -Recurse | Sort-Object FullName
$manifest = [ordered]@{
  schemaVersion = 1
  source = 'scenery/term4.BGL'
  sourceBytes = (Get-Item $source).Length
  sourceSha256 = (Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant()
  converter = 'ModelConverterX 1.7 -> OBJ -> RampReady obj-to-gltf'
  stagedTextureCount = $rootTextures.Count
  objBytes = (Get-Item $obj).Length
  generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  outputs = @($files | ForEach-Object {
    [ordered]@{
      path = $_.FullName.Substring($root.Length + 1).Replace('\\','/')
      bytes = $_.Length
      sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  })
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $out 'extraction-manifest.json') -Encoding UTF8

Write-Host 'Terminal 4 extraction succeeded via MCX 1.7 OBJ -> RampReady glTF converter'
Get-ChildItem -Path $out -File -Recurse | ForEach-Object { Write-Host ("{0}  {1} bytes" -f $_.FullName, $_.Length) }
