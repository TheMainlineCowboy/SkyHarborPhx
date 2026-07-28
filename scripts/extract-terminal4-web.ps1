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
Expand-Archive -Path $zip -DestinationPath $tools -Force

$mcx = Get-ChildItem -Path $tools -Filter 'ModelConverterX.exe' -Recurse | Select-Object -First 1
if (-not $mcx) { throw 'ModelConverterX.exe was not found after extraction' }
Write-Host "Using ModelConverterX: $($mcx.FullName)"

$helpLog = Join-Path $logs 'modelconverterx-help.txt'
& $mcx.FullName -help *>&1 | Tee-Object -FilePath $helpLog

$source = Join-Path $root 'scenery\term4.BGL'
if (-not (Test-Path $source)) { throw "Missing Terminal 4 source: $source" }

# Keep the source texture directory adjacent and visible to MCX while importing the BGL.
$textureDir = Join-Path $root 'texture'
if (-not (Test-Path $textureDir)) { throw "Missing source texture directory: $textureDir" }

$candidates = @('GLTF', 'GLTF2', 'GLTF_2', 'GLTF_2_0')
$converted = $false
foreach ($format in $candidates) {
  Write-Host "Trying ModelConverterX output format: $format"
  Get-ChildItem -Path $out -File -ErrorAction SilentlyContinue | Remove-Item -Force
  $target = Join-Path $out 'terminal4.gltf'
  $formatLog = Join-Path $logs ("convert-{0}.txt" -f $format)
  $global:LASTEXITCODE = 0
  & $mcx.FullName $source -out $target -format $format *>&1 | Tee-Object -FilePath $formatLog
  $exit = $LASTEXITCODE
  $outputs = @(Get-ChildItem -Path $out -File -Recurse -ErrorAction SilentlyContinue)
  $gltf = @($outputs | Where-Object { $_.Extension -in @('.gltf', '.glb') })
  Write-Host "Format $format exit=$exit outputs=$($outputs.Count) gltf=$($gltf.Count)"
  if ($gltf.Count -gt 0) {
    $converted = $true
    break
  }
}

if (-not $converted) {
  Write-Host 'ModelConverterX help excerpts:'
  Select-String -Path $helpLog -Pattern 'format|gltf|glb' -CaseSensitive:$false | ForEach-Object { Write-Host $_.Line }
  throw 'ModelConverterX did not create a glTF/GLB output for term4.BGL'
}

# Inventory the conversion so downstream RampReady work has deterministic evidence.
$files = Get-ChildItem -Path $out -File -Recurse | Sort-Object FullName
$manifest = [ordered]@{
  schemaVersion = 1
  source = 'scenery/term4.BGL'
  sourceBytes = (Get-Item $source).Length
  sourceSha256 = (Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant()
  converter = 'ModelConverterX 1.8'
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
