$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tools = Join-Path $root '.tools\modelconverterx'
$out = Join-Path $root 'web-extract\terminal4'
$logs = Join-Path $root 'web-extract\logs'
New-Item -ItemType Directory -Force -Path $tools, $out, $logs | Out-Null

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
    [int] $TimeoutSeconds = 90
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
    Stdout = $stdout
    Stderr = $stderr
  }
}

$help = Invoke-Mcx -Arguments @('-help') -Name 'help' -TimeoutSeconds 30
Write-Host "MCX help exit=$($help.ExitCode) timedOut=$($help.TimedOut)"

$source = Join-Path $root 'scenery\term4.BGL'
if (-not (Test-Path $source)) { throw "Missing Terminal 4 source: $source" }

# The original scenery package was uploaded to GitHub with its texture directory flattened
# into the repository root. Recreate the expected sibling `texture` directory only in CI so
# ModelConverterX can resolve as many source materials as are actually present.
$textureDir = Join-Path $root 'texture'
New-Item -ItemType Directory -Force -Path $textureDir | Out-Null
$rootTextures = @(Get-ChildItem -Path $root -File | Where-Object { $_.Extension -match '^\.(bmp|dds)$' })
foreach ($texture in $rootTextures) {
  Copy-Item $texture.FullName -Destination (Join-Path $textureDir $texture.Name) -Force
}
Write-Host "Staged $($rootTextures.Count) flattened root textures into $textureDir"

$candidates = @('GLTF', 'GLTF2', 'GLTF_2', 'GLTF_2_0')
$converted = $false
foreach ($format in $candidates) {
  Write-Host "Trying ModelConverterX output format: $format"
  Get-ChildItem -Path $out -File -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force
  $target = Join-Path $out 'terminal4.gltf'
  $result = Invoke-Mcx -Arguments @($source, '-out', $target, '-format', $format) -Name ("convert-{0}" -f $format) -TimeoutSeconds 120
  $outputs = @(Get-ChildItem -Path $out -File -Recurse -ErrorAction SilentlyContinue)
  $gltf = @($outputs | Where-Object { $_.Extension -in @('.gltf', '.glb') })
  Write-Host "Format $format exit=$($result.ExitCode) timedOut=$($result.TimedOut) outputs=$($outputs.Count) gltf=$($gltf.Count)"
  if ($gltf.Count -gt 0) {
    $converted = $true
    break
  }
}

if (-not $converted) {
  Write-Host 'ModelConverterX help/log excerpts:'
  Get-ChildItem $logs -File | ForEach-Object {
    Write-Host "--- $($_.Name) ---"
    Select-String -Path $_.FullName -Pattern 'format|gltf|glb|error|exception|texture|bgl' -CaseSensitive:$false | Select-Object -First 80 | ForEach-Object { Write-Host $_.Line }
  }
  throw 'ModelConverterX did not create a glTF/GLB output for term4.BGL'
}

$files = Get-ChildItem -Path $out -File -Recurse | Sort-Object FullName
$manifest = [ordered]@{
  schemaVersion = 1
  source = 'scenery/term4.BGL'
  sourceBytes = (Get-Item $source).Length
  sourceSha256 = (Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant()
  converter = 'ModelConverterX 1.8'
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

Write-Host 'Terminal 4 extraction outputs:'
Get-ChildItem -Path $out -File -Recurse | ForEach-Object { Write-Host ("{0}  {1} bytes" -f $_.FullName, $_.Length) }
