<#
.SYNOPSIS
  DVM を「ちゃんと終わらせる」。ウィンドウ位置・サイズが保存される唯一の止め方。

.DESCRIPTION
  tauri-plugin-window-state が .window-state.json を書くのは RunEvent::Exit のときだけで、
  Moved / Resized / CloseRequested はメモリ上のキャッシュを更新するだけ。
  そのため Stop-Process -Force で殺すと、最大化しようが動かそうが**丸ごと巻き戻る**。
  (定期保存で直そうとするとデッドロックする。docs/DESIGN.md「ウィンドウ位置とサイズの記憶」節)

  ここでは × ボタンと同じ WM_CLOSE を送って、終了ハンドラを通らせる。
  dvm.exe が落ちれば cargo run も終わり、`tauri dev` の vite も畳まれる。

.PARAMETER TimeoutSec
  WM_CLOSE を送ってから諦めるまでの秒数(既定 20)。
  超えたら強制終了に切り替える —— 止まらないよりはマシなので。

.PARAMETER Force
  最初から強制終了する。ハングしていて WM_CLOSE が効かないときだけ使う。
#>
param(
    [int]$TimeoutSec = 20,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$stateFile = Join-Path $env:APPDATA 'jp.demo2.dvm\.window-state.json'
$before = if (Test-Path $stateFile) { (Get-Item $stateFile).LastWriteTime } else { $null }

$dvm = @(Get-Process dvm -ErrorAction SilentlyContinue)

if ($dvm.Count -eq 0) {
    Write-Host 'dvm は動いていません'
} elseif ($Force) {
    Write-Host '強制終了します(ウィンドウ位置は保存されません)'
    $dvm | Stop-Process -Force -ErrorAction SilentlyContinue
} else {
    # CloseMainWindow() は × ボタンと同じ WM_CLOSE。Stop-Process と違って終了ハンドラを通る
    foreach ($p in $dvm) {
        if ($p.MainWindowHandle -ne 0) {
            [void]$p.CloseMainWindow()
        } else {
            # 窓を持たない dvm(起動途中など)は閉じようがない
            $p | Stop-Process -Force -ErrorAction SilentlyContinue
        }
    }

    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        if (-not (Get-Process dvm -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 300
    }

    if (Get-Process dvm -ErrorAction SilentlyContinue) {
        Write-Warning "${TimeoutSec}秒で閉じませんでした。強制終了します(ウィンドウ位置は保存されません)"
        Get-Process dvm -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "dvm を閉じました($([math]::Round($sw.Elapsed.TotalSeconds,1)) 秒)"
    }
}

# dvm が落ちれば cargo も終わるが、ビルド中だと残る。vite は 1420 を持つ node で特定する
# (他プロジェクトの node を巻き込まないため、プロセス名では探さない)
Start-Sleep -Milliseconds 500
Get-Process cargo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$vite = Get-NetTCPConnection -State Listen -LocalPort 1420 -ErrorAction SilentlyContinue
if ($vite) {
    $vite.OwningProcess | Select-Object -Unique | ForEach-Object {
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
    }
}

# 保存されたかを必ず見せる。「閉じたつもりで保存されていない」を黙らせないため
if (Test-Path $stateFile) {
    $after = (Get-Item $stateFile).LastWriteTime
    if ($null -eq $before -or $after -gt $before) {
        $s = (Get-Content $stateFile -Raw | ConvertFrom-Json).main
        Write-Host "ウィンドウ状態を保存しました: $($s.width)x$($s.height) at $($s.x),$($s.y) maximized=$($s.maximized)"
    } else {
        Write-Warning 'ウィンドウ状態は更新されませんでした(強制終了したか、窓を出す前に終わった)'
    }
}
