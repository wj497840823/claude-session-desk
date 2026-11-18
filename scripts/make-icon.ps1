# Generates build/icon.png, build/tray.png and build/splash.bmp.
# Requires Python 3 with Pillow:  pip install pillow
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
  Write-Error "python was not found. Install Python 3 and run: pip install pillow"
  exit 1
}
& $python.Source (Join-Path $PSScriptRoot "make-icon.py")
exit $LASTEXITCODE