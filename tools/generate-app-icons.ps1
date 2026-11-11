# Recreate the generic member card assets without changing the application ID.
Add-Type -AssemblyName System.Drawing
$resourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../android/app/src/main/res'))
function New-RoundedRect($x, $y, $width, $height, $radius) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $radius * 2
    $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
    $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
    $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return ,$path
}
$colors = @{}
foreach ($pair in @(@('navy','#0F172A'), @('white','#FFFFFF'), @('indigo','#6366F1'), @('gold','#FBBF24'), @('gray','#94A3B8'))) {
    $colors[$pair[0]] = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($pair[1]))
}
try {
    $assets = Get-ChildItem -LiteralPath $resourceRoot -Recurse -File | Where-Object { $_.Name -in @('ic_launcher.png','ic_launcher_round.png','ic_launcher_foreground.png','splash.png') }
    foreach ($asset in $assets) {
        $original = [System.Drawing.Image]::FromFile($asset.FullName)
        $width = $original.Width; $height = $original.Height; $original.Dispose()
        $bitmap = New-Object System.Drawing.Bitmap $width, $height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $splash = $asset.Name -eq 'splash.png'
            $foreground = $asset.Name -eq 'ic_launcher_foreground.png'
            if ($splash) { $graphics.Clear([System.Drawing.Color]::White) }
            elseif ($foreground) { $graphics.Clear([System.Drawing.Color]::Transparent) }
            else { $graphics.Clear($colors.navy.Color) }
            $size = [Math]::Min($width,$height)
            if ($splash) { $size = $size * 0.32 }
            $graphics.TranslateTransform(($width-$size)/2, ($height-$size)/2)
            $graphics.ScaleTransform($size/108, $size/108)
            if ($splash) { $tile = New-RoundedRect 0 0 108 108 22; $graphics.FillPath($colors.navy,$tile); $tile.Dispose() }
            $card = New-RoundedRect 26 34 56 40 6
            $graphics.FillPath($colors.white, $card); $card.Dispose()
            $graphics.FillRectangle($colors.indigo,26,43,56,8)
            $graphics.FillRectangle($colors.gold,34,58,10,8)
            foreach ($x in @(51,61,71)) { $graphics.FillRectangle($colors.gray,$x,61,5,4) }
            $bitmap.Save($asset.FullName,[System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
    }
    Write-Output ('Updated ' + $assets.Count + ' member card assets')
} finally { foreach ($brush in $colors.Values) { $brush.Dispose() } }
