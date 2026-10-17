<# Render every native installer brand bitmap from the shared BHSS mascot icon. #>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $output | Out-Null
$icon = [Drawing.Image]::FromFile((Join-Path $PSScriptRoot '../resources/icon-windows.png'))
try {
    # Embed PNG frames in an ICO so Explorer, NSIS and the application use the same artwork.
    $frames = @()
    foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
        $frame = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [Drawing.Graphics]::FromImage($frame)
        $stream = [IO.MemoryStream]::new()
        try {
            $graphics.Clear([Drawing.Color]::Transparent)
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.DrawImage($icon, 0, 0, $size, $size)
            $frame.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
            $frames += [pscustomobject]@{ Size = $size; Bytes = $stream.ToArray() }
        } finally { $stream.Dispose(); $graphics.Dispose(); $frame.Dispose() }
    }
    $icoStream = [IO.File]::Create((Join-Path $output 'wanzai.ico'))
    $writer = [IO.BinaryWriter]::new($icoStream)
    try {
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
        $offset = 6 + 16 * $frames.Count
        foreach ($frame in $frames) {
            $dimension = if ($frame.Size -eq 256) { 0 } else { $frame.Size }
            $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
            $writer.Write([byte]0); $writer.Write([byte]0)
            $writer.Write([uint16]1); $writer.Write([uint16]32)
            $writer.Write([uint32]$frame.Bytes.Length); $writer.Write([uint32]$offset)
            $offset += $frame.Bytes.Length
        }
        foreach ($frame in $frames) { $writer.Write([byte[]]$frame.Bytes) }
    } finally { $writer.Dispose() }
    foreach ($asset in @('brand', 'brand-2x', 'brand-dark', 'brand-dark-2x', 'uninstaller-sidebar')) {
        $sidebar = $asset -eq 'uninstaller-sidebar'
        $dark = $asset -like '*dark*'
        $scale = if ($asset -like '*-2x') { 2 } else { 1 }
        $width = if ($sidebar) { 164 } else { 600 * $scale }
        $height = if ($sidebar) { 314 } else { 196 * $scale }
        if ($sidebar) { $background = [Drawing.Color]::FromArgb(242, 243, 246) }
        elseif ($dark) { $background = [Drawing.Color]::FromArgb(21, 21, 23) }
        else { $background = [Drawing.Color]::White }
        $foreground = if ($dark) { [Drawing.Color]::White } else { [Drawing.Color]::FromArgb(15, 17, 21) }
        $bitmap = [Drawing.Bitmap]::new($width, $height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
        try {
            $graphics = [Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.Clear($background)
                $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
                $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
                if ($sidebar) {
                    $iconBounds = [Drawing.Rectangle]::new(12, 80, 140, 140)
                    $textBounds = [Drawing.RectangleF]::new(0, 229, 164, 36)
                    $fontSize = 16
                } else {
                    $iconBounds = [Drawing.Rectangle]::new(220 * $scale, 0, 160 * $scale, 160 * $scale)
                    $textBounds = [Drawing.RectangleF]::new(0, 151 * $scale, 600 * $scale, 40 * $scale)
                    $fontSize = 31 * $scale
                }
                # The icon itself contains transparent square padding, so square placement never distorts the portrait SVG.
                $graphics.DrawImage($icon, $iconBounds)
                $font = [Drawing.Font]::new('Microsoft YaHei UI', [single]$fontSize,
                    [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
                $brush = [Drawing.SolidBrush]::new($foreground)
                $format = [Drawing.StringFormat]::new()
                try {
                    $format.Alignment = [Drawing.StringAlignment]::Center
                    $format.LineAlignment = [Drawing.StringAlignment]::Center
                    $brandName = -join [char[]](0x5f2f, 0x5d3d, 0x5de5, 0x4f5c, 0x4f19, 0x4f34)
                    $graphics.DrawString($brandName, $font, $brush, $textBounds, $format)
                } finally {
                    $format.Dispose()
                    $brush.Dispose()
                    $font.Dispose()
                }
            } finally { $graphics.Dispose() }
            $bitmap.Save((Join-Path $output "$asset.bmp"), [Drawing.Imaging.ImageFormat]::Bmp)
        } finally { $bitmap.Dispose() }
    }
} finally { $icon.Dispose() }
