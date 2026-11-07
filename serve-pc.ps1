param(
  [string]$Root = "",
  [int]$Port = 8731
)

# Fallback for machines without Python. Same job as `python -m http.server`: static files with the
# MIME types the page needs (.mjs must be text/javascript or the module script is refused, .wasm
# must be application/wasm or WebAssembly.instantiateStreaming fails).

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrEmpty($Root)) {
  $Root = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "dist"
}
$Root = (Resolve-Path -LiteralPath $Root).Path
$RootPrefix = $Root + [System.IO.Path]::DirectorySeparatorChar

$types = @{
  ".html" = "text/html; charset=utf-8"
  ".htm"  = "text/html; charset=utf-8"
  ".js"   = "text/javascript"
  ".mjs"  = "text/javascript"
  ".css"  = "text/css"
  ".json" = "application/json"
  ".map"  = "application/json"
  ".wasm" = "application/wasm"
  ".task" = "application/octet-stream"
  ".onnx" = "application/octet-stream"
  ".tflite" = "application/octet-stream"
  ".bin"  = "application/octet-stream"
  ".data" = "application/octet-stream"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".gif"  = "image/gif"
  ".svg"  = "image/svg+xml"
  ".ico"  = "image/x-icon"
  ".txt"  = "text/plain; charset=utf-8"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "FocusChangeAI PC server: http://localhost:$Port/  root=$Root"
Write-Host "Dong cua so nay de dung server."

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
      $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart("/")
      if ([string]::IsNullOrEmpty($rel)) { $rel = "index.html" }
      $full = [System.IO.Path]::GetFullPath((Join-Path $Root $rel))
      $isDir = $full.EndsWith([System.IO.Path]::DirectorySeparatorChar)
      if ($isDir) { $full += "index.html" }
      $outside = -not $full.StartsWith($RootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
      if ($outside -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $res.StatusCode = 404
        $body = [System.Text.Encoding]::UTF8.GetBytes("404")
      } else {
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        if ($types.ContainsKey($ext)) { $res.ContentType = $types[$ext] } else { $res.ContentType = "application/octet-stream" }
        $res.Headers.Add("Cache-Control", "no-store")
        $body = [System.IO.File]::ReadAllBytes($full)
        $res.ContentLength64 = $body.Length
      }
      $res.OutputStream.Write($body, 0, $body.Length)
    } catch {
      try { $res.StatusCode = 500 } catch {}
    } finally {
      $res.Close()
    }
  }
} finally {
  if ($listener.IsListening) { $listener.Stop() }
  $listener.Close()
}
