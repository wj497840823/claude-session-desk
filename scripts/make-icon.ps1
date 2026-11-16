Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $projectRoot "build"
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

$size = 256
$bitmap = New-Object System.Drawing.Bitmap -ArgumentList $size, $size
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

$background = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(37, 99, 235))
$graphics.FillRectangle($background, 0, 0, $size, $size)

$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$graphics.FillRectangle($white, 48, 66, 160, 104)

$points = [System.Drawing.Point[]]@(
  [System.Drawing.Point]::new(80, 170),
  [System.Drawing.Point]::new(80, 208),
  [System.Drawing.Point]::new(126, 170)
)
$graphics.FillPolygon($white, $points)

$dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(37, 99, 235))
$graphics.FillEllipse($dot, 84, 104, 20, 20)
$graphics.FillEllipse($dot, 118, 104, 20, 20)
$graphics.FillEllipse($dot, 152, 104, 20, 20)

$output = Join-Path $buildDir "icon.png"
$bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)

$graphics.Dispose()
$bitmap.Dispose()
$background.Dispose()
$white.Dispose()
$dot.Dispose()

Write-Output $output