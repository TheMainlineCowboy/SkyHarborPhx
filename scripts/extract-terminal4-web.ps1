$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tools = Join-Path $root '.tools\modelconverterx'
$out = Join-Path $root 'web-extract\terminal4'
$logs = Join-Path $root 'web-extract\logs'
$intermediate = Join-Path $root 'web-extract\intermediate'
New-Item -ItemType Directory -Force -Path $tools, $out, $logs, $intermediate | Out-Null

$zip = Join-Path $env:RUNNER_TEMP 'ModelConverterX_180.zip'
$download = 'https://www.scenerydesign.org/old-releases/stable/ModelConverterX_180.zip'
Write-Host "Downloading ModelConverterX 1.8 from $download"
Invoke-WebRequest -Uri $download -OutFile $zip -UseBasicParsing
Write-Host "Downloaded $((Get-Item $zip).Length) bytes"
Expand-Archive -Path $zip -DestinationPath $tools -Force

$mcx = Get-ChildItem -Path $tools -Filter 'ModelConverterX.exe' -Recurse | Select-Object -First 1
if (-not $mcx) { throw 'ModelConverterX.exe was not found after extraction' }
Write-Host "Using ModelConverterX: $($mcx.FullName)"

function Invoke-Mcx {
  param(
    [string[]] $Arguments,
    [string] $Name,
    [int] $TimeoutSeconds = 75
  )
  $stdout = Join-Path $logs "$Name.stdout.txt"
  $stderr = Join-Path $logs "$Name.stderr.txt"
  Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue
  Write-Host "MCX $Name args: $($Arguments -join ' ')"
  $process = Start-Process -FilePath $mcx.FullName -ArgumentList $Arguments -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $finished = $process.WaitForExit($TimeoutSeconds * 1000)
  if (-not $finished) {
    Write-Host "MCX $Name exceeded ${TimeoutSeconds}s; terminating process $($process.Id)"
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $stdout) { Get-Content $stdout | ForEach-Object { Write-Host "[MCX stdout] $_" } }
  if (Test-Path $stderr) { Get-Content $stderr | ForEach-Object { Write-Host "[MCX stderr] $_" } }
  return [pscustomobject]@{
    TimedOut = -not $finished
    ExitCode = if ($finished) { $process.ExitCode } else { 124 }
  }
}

$source = Join-Path $root 'scenery\term4.BGL'
if (-not (Test-Path $source)) { throw "Missing Terminal 4 source: $source" }

# The source package was flattened when uploaded. Recreate the expected texture folder only
# inside the runner so ModelConverterX can resolve the original material references.
$textureDir = Join-Path $root 'texture'
New-Item -ItemType Directory -Force -Path $textureDir | Out-Null
$rootTextures = @(Get-ChildItem -Path $root -File | Where-Object { $_.Extension -match '^\.(bmp|dds)$' })
foreach ($texture in $rootTextures) {
  Copy-Item $texture.FullName -Destination (Join-Path $textureDir $texture.Name) -Force
}
Write-Host "Staged $($rootTextures.Count) flattened root textures into $textureDir"

Get-ChildItem -Path $out -File -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem -Path $intermediate -File -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force

$directTarget = Join-Path $out 'terminal4.gltf'
$direct = Invoke-Mcx -Arguments @($source, '-out', $directTarget, '-format', 'GLTF') -Name 'direct-gltf' -TimeoutSeconds 75
$gltf = @(Get-ChildItem -Path $out -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in @('.gltf', '.glb') })
$conversionPath = 'mcx-direct-gltf'

if ($gltf.Count -lt 1) {
  Write-Host "Direct glTF did not finish successfully (exit=$($direct.ExitCode), timedOut=$($direct.TimedOut)). Falling back to OBJ."
  $obj = Join-Path $intermediate 'terminal4.obj'
  $objResult = Invoke-Mcx -Arguments @($source, '-out', $obj, '-format', 'OBJ') -Name 'obj-fallback' -TimeoutSeconds 75
  if (-not (Test-Path $obj) -or (Get-Item $obj).Length -lt 1024) {
    throw "ModelConverterX OBJ fallback did not produce usable geometry (exit=$($objResult.ExitCode), timedOut=$($objResult.TimedOut))"
  }

  Write-Host "OBJ fallback produced $((Get-Item $obj).Length) bytes; converting with obj2gltf"
  $npx = (Get-Command npx.cmd -ErrorAction Stop).Source
  $obj2gltfStdout = Join-Path $logs 'obj2gltf.stdout.txt'
  $obj2gltfStderr = Join-Path $logs 'obj2gltf.stderr.txt'
  $p = Start-Process -FilePath $npx -ArgumentList @('--yes','obj2gltf','-i',$obj,'-o',$directTarget) -PassThru -Wait -RedirectStandardOutput $obj2gltfStdout -RedirectStandardError $obj2gltfStderr
  if (Test-Path $obj2gltfStdout) { Get-Content $obj2gltfStdout | ForEach-Object { Write-Host "[obj2gltf] $_" } }
  if (Test-Path $obj2gltfStderr) { Get-Content $obj2gltfStderr | ForEach-Object { Write-Host "[obj2gltf err] $_" } }
  if ($p.ExitCode -ne 0) { throw "obj2gltf failed with exit code $($p.ExitCode)" }
  $gltf = @(Get-ChildItem -Path $out -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in @('.gltf', '.glb') })
  $conversionPath = 'mcx-obj-plus-obj2gltf'
}

if ($gltf.Count -lt 1) { throw 'No browser-readable Terminal 4 glTF/GLB was produced' }

$files = Get-ChildItem -Path $out -File -Recurse | Sort-Object FullName
$manifest = [ordered]@{
  schemaVersion = 1
  source = 'scenery/term4.BGL'
  sourceBytes = (Get-Item $source).Length
  sourceSha256 = (Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant()
  converter = 'ModelConverterX 1.8'
  conversionPath = $conversionPath
  stagedTextureCount = $rootTextures.Count
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

Write-Host "Terminal 4 extraction succeeded via $conversionPath"
Get-ChildItem -Path $out -File -Recurse | ForEach-Object { Write-Host ("{0}  {1} bytes" -f $_.FullName, $_.Length) }
