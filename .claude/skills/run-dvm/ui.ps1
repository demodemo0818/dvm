# DVM のウィンドウを操作するヘルパー(スクリーンショット・クリック・スクロール・キー送信)。
# 座標はすべて**ウィンドウ左上からの相対座標**で指定する(スクリーンショットの座標がそのまま使える)。
#
# 注意: 必ず Windows PowerShell 5.1(`powershell`)から -File で呼ぶこと。
# System.Drawing / System.Windows.Forms が確実に載っているのが 5.1 側のため。
# このファイルは日本語コメントを含むので **BOM 付き UTF-8** で保存する
# (BOM が無いと 5.1 が CP932 として読み、「。」が改行を食って param() ごと壊す)。
param(
  [Parameter(Mandatory)][ValidateSet('shot', 'click', 'scroll', 'key')][string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$Delta = 0,
  [string]$Out = 'shot.png',
  [string]$Keys = '',
  [string]$Title = 'DVM'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, int d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

# DPI スケーリング環境で座標がずれないようにする(これが無いと 150% 表示でクリックが外れる)
[void][W]::SetProcessDPIAware()
$h = [W]::Find($Title)
if ($h -eq [IntPtr]::Zero) { throw "window '$Title' not found" }
$r = New-Object W+RECT
[void][W]::GetWindowRect($h, [ref]$r)
[void][W]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 300

switch ($Action) {
  'shot' {
    $w = $r.Right - $r.Left
    $ht = $r.Bottom - $r.Top
    $bmp = New-Object System.Drawing.Bitmap $w, $ht
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output "rect=$($r.Left),$($r.Top),$($r.Right),$($r.Bottom) size=${w}x${ht} -> $Out"
  }
  'click' {
    [void][W]::SetCursorPos($r.Left + $X, $r.Top + $Y)
    Start-Sleep -Milliseconds 150
    [W]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
    [W]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
    Write-Output "clicked at window($X,$Y) = screen($($r.Left + $X),$($r.Top + $Y))"
  }
  'scroll' {
    [void][W]::SetCursorPos($r.Left + $X, $r.Top + $Y)
    Start-Sleep -Milliseconds 150
    [W]::mouse_event(0x0800, 0, 0, $Delta, [IntPtr]::Zero)  # WHEEL(1 ノッチ = 120。下方向は負)
    Write-Output "scrolled $Delta at window($X,$Y)"
  }
  'key' {
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    Write-Output "sent keys: $Keys"
  }
}
