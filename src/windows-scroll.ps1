$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LongshotScroll {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out RECT rect);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern uint SendInput(uint count,INPUT[] inputs,int size);
  static IntPtr target;
  static POINT center, original;
  static RECT bounds;
  static bool active;
  static IntPtr Root(POINT point) { return GetAncestor(WindowFromPoint(point),2); }
  public static string Begin(int x,int y,int left,int top,int right,int bottom) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    if (!GetCursorPos(out original)) throw new Exception("Cannot read cursor position");
    center = new POINT { X=x,Y=y }; target=Root(center);
    if (target==IntPtr.Zero || !GetWindowRect(target,out bounds)) throw new Exception("Cannot locate target window");
    foreach (POINT point in new POINT[] { new POINT {X=left,Y=top},new POINT {X=right,Y=top},new POINT {X=left,Y=bottom},new POINT {X=right,Y=bottom} })
      if (Root(point)!=target) throw new Exception("Selection spans multiple windows; select one scrollable area");
    SetForegroundWindow(target);
    System.Threading.Thread.Sleep(120);
    if (GetForegroundWindow()!=target) throw new Exception("Cannot focus target window; use manual mode");
    if (!SetCursorPos(x,y)) throw new Exception("Cannot position cursor");
    active=true; return "ready";
  }
  public static string Check() {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    if (!active) throw new Exception("Invalid scroll state");
    foreach (int key in new int[] {0x10,0x11,0x12,0x5B,0x5C,0x01,0x02,0x04})
      if ((GetAsyncKeyState(key) & 0x8000)!=0) throw new Exception("User input detected; automatic scrolling stopped");
    POINT cursor; RECT current;
    if (!GetCursorPos(out cursor) || Math.Abs(cursor.X-center.X)>12 || Math.Abs(cursor.Y-center.Y)>12) throw new Exception("Mouse moved; automatic scrolling stopped");
    if (!IsWindow(target) || GetForegroundWindow()!=target || Root(center)!=target) throw new Exception("Target window changed; automatic scrolling stopped");
    if (!GetWindowRect(target,out current) || current.Left!=bounds.Left || current.Top!=bounds.Top || current.Right!=bounds.Right || current.Bottom!=bounds.Bottom) throw new Exception("Target window moved or resized; automatic scrolling stopped");
    return "valid";
  }
  public static string Step(int ticks) {
    if (ticks<1 || ticks>3) throw new Exception("Invalid scroll amount");
    Check();
    INPUT input=new INPUT(); input.type=0; input.data.mouse.mouseData=unchecked((uint)(-120*ticks)); input.data.mouse.dwFlags=0x0800;
    if (SendInput(1,new INPUT[]{input},Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("Windows rejected mouse wheel input; use manual mode");
    return "scrolled";
  }
  public static string End() {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    POINT cursor;
    if (active && GetCursorPos(out cursor) && Math.Abs(cursor.X-center.X)<=12 && Math.Abs(cursor.Y-center.Y)<=12) SetCursorPos(original.X,original.Y);
    active=false; return "stopped";
  }
}
'@
while ($null -ne ($line = [Console]::ReadLine())) {
  $command = $null
  try {
    $command = $line | ConvertFrom-Json
    switch ($command.action) {
      'begin' { $result=[LongshotScroll]::Begin([int]$command.x,[int]$command.y,[int]$command.left,[int]$command.top,[int]$command.right,[int]$command.bottom) }
      'check' { $result=[LongshotScroll]::Check() }
      'step' { $result=[LongshotScroll]::Step([int]$command.ticks) }
      'end' { $result=[LongshotScroll]::End() }
      default { throw 'Unknown command' }
    }
    @{id=$command.id;ok=$true;result=$result} | ConvertTo-Json -Compress | Write-Output
  } catch {
    @{id=$command.id;ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress | Write-Output
  }
}
