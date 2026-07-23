# FFmpeg / ffprobe を src-tauri/binaries/ に配置するセットアップスクリプト
$ErrorActionPreference = 'Stop'
$dest = Join-Path $PSScriptRoot '..\src-tauri\binaries'

if ((Test-Path (Join-Path $dest 'ffmpeg.exe')) -and (Test-Path (Join-Path $dest 'ffprobe.exe'))) {
    Write-Host 'ffmpeg.exe / ffprobe.exe は配置済みです'
    exit 0
}

New-Item -ItemType Directory -Force $dest | Out-Null
$zip = Join-Path $env:TEMP 'ffmpeg-release-essentials.zip'
$extract = Join-Path $env:TEMP 'ffmpeg-extract'

Write-Host 'FFmpeg (gyan.dev release-essentials) をダウンロード中...'
Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip

Write-Host '展開中...'
if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
Expand-Archive $zip -DestinationPath $extract

$ffmpeg = Get-ChildItem $extract -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
Copy-Item $ffmpeg.FullName $dest
Copy-Item (Join-Path $ffmpeg.DirectoryName 'ffprobe.exe') $dest

Remove-Item $zip -Force
Remove-Item -Recurse -Force $extract
Write-Host "完了: $dest に ffmpeg.exe / ffprobe.exe を配置しました"
