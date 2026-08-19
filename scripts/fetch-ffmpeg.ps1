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

# 取得元は gyan.dev の release-essentials(GPLv3。同梱物の扱いは THIRD-PARTY-NOTICES.md)。
# ただし **gyan.dev は GitHub Actions のようなデータセンター IP に 503 を返すことがある**
# ので、同じビルドが置いてある GitHub Releases(GyanD/codexffmpeg = gyan.dev のビルド
# スクリプトのリポジトリ)をフォールバックにする。どちらから取っても中身は同じ。
function Get-FfmpegZip {
    param([string]$OutFile)

    try {
        Write-Host 'FFmpeg (gyan.dev release-essentials) をダウンロード中...'
        Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $OutFile
        return
    }
    catch {
        Write-Host "gyan.dev から取れませんでした($($_.Exception.Message))"
        Write-Host 'GitHub Releases (GyanD/codexffmpeg) を試します...'
    }

    $headers = @{ 'User-Agent' = 'dvm-setup' }
    # CI では GITHUB_TOKEN を使う(未認証だと API のレート制限が 60 回/時と厳しい)
    if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }

    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/GyanD/codexffmpeg/releases/latest' -Headers $headers
    $asset = $rel.assets | Where-Object { $_.name -like '*essentials_build.zip' } | Select-Object -First 1
    if (-not $asset) {
        throw 'GyanD/codexffmpeg の最新リリースに essentials_build.zip が見つかりません'
    }

    Write-Host "$($asset.name) をダウンロード中..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $OutFile -Headers $headers
}

Get-FfmpegZip -OutFile $zip

Write-Host '展開中...'
if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
Expand-Archive $zip -DestinationPath $extract

$ffmpeg = Get-ChildItem $extract -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
Copy-Item $ffmpeg.FullName $dest
Copy-Item (Join-Path $ffmpeg.DirectoryName 'ffprobe.exe') $dest

Remove-Item $zip -Force
Remove-Item -Recurse -Force $extract
Write-Host "完了: $dest に ffmpeg.exe / ffprobe.exe を配置しました"
