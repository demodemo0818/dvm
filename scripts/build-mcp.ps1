# MCP サーバー(dvm-mcp.exe)をビルドして src-tauri/binaries/ に配置するスクリプト。
# tauri.conf.json の bundle.resources がこの場所を見て配布物に同梱するため、
# npm run tauri build の前に必ず走る(beforeBuildCommand から呼ばれる)。
#
# 鶏と卵に注意: tauri のビルドスクリプトは bundle.resources のファイルが実在しないと
# ビルドを止める(glob にしても空マッチは同じく拒否される)。dvm-mcp 自身のビルドも
# dvm_lib 経由でその検査を通るので、**先に空のプレースホルダを置いてから** cargo を走らせる。
param([ValidateSet('debug', 'release')][string]$Config = 'release')

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$manifest = Join-Path $root 'src-tauri\Cargo.toml'
$dest = Join-Path $root 'src-tauri\binaries'
$out = Join-Path $dest 'dvm-mcp.exe'

New-Item -ItemType Directory -Force $dest | Out-Null
# 中身が空のものは前回の失敗で残ったプレースホルダなので、作り直し扱いにする
$placed = $false
if (-not (Test-Path $out) -or (Get-Item $out).Length -eq 0) {
    New-Item -ItemType File -Force $out | Out-Null
    $placed = $true
}

Write-Host "dvm-mcp を $Config でビルドしています..."
$cargoArgs = @('build', '--bin', 'dvm-mcp', '--manifest-path', $manifest)
if ($Config -eq 'release') { $cargoArgs += '--release' }
& cargo @cargoArgs
if ($LASTEXITCODE -ne 0) {
    # 空ファイルを残すと「同梱したつもりで中身が無い」状態になるので消しておく
    if ($placed) { Remove-Item $out -Force }
    throw 'cargo build --bin dvm-mcp に失敗しました'
}

Copy-Item (Join-Path $root "src-tauri\target\$Config\dvm-mcp.exe") $out -Force
Write-Host "完了: $out"
