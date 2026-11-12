// Pins the app's window onto every Windows virtual desktop ("Task View"),
// not only the one it was opened on — the always-on-top pin in the panel
// keeps it above other windows, but says nothing about which desktop it
// lives on; Windows puts a window on exactly one, and switching desktops
// (Ctrl+Win+Left/Right) hides it like any other, pin or no pin.
//
// Electron has no API for this on Windows (setVisibleOnAllWorkspaces is a
// documented no-op there — darwin/linux only), so this goes through the
// same undocumented COM interface Windows' own "Show this window on all
// desktops" (right-click a taskbar icon, on Windows 11) uses internally:
// IVirtualDesktopPinnedApps.PinView, given the IApplicationView that
// IApplicationViewCollection.GetViewForHwnd resolves for this window's
// handle. Both interfaces are unversioned Windows shell internals, not a
// published API — Microsoft can change or remove them in a later Windows
// build without notice, which is why every call here is best-effort: a
// failure is logged and otherwise ignored, never surfaced to the person
// using the app, and the window works exactly as before (pinned to the one
// desktop it was opened on) if it does fail.

const { execFile } = require("node:child_process");

// The C# this runs only needs IApplicationView as an opaque COM pointer —
// it is received from GetViewForHwnd and handed straight to PinView, never
// called into directly, so its own method layout (which Windows has in fact
// changed between versions) does not have to be known here at all.
const SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IServiceProvider10
{
    [return: MarshalAs(UnmanagedType.IUnknown)]
    object QueryService(ref Guid service, ref Guid riid);
}

[ComImport, Guid("1841C6D7-4F9D-42C0-AF41-8747538F10E5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationViewCollection
{
    int GetViews(out IntPtr array);
    int GetViewsByZOrder(out IntPtr array);
    int GetViewsByAppUserModelId(string id, out IntPtr array);
    int GetViewForHwnd(IntPtr hwnd, [MarshalAs(UnmanagedType.IUnknown)] out object view);
    int GetViewForApplication(object app, [MarshalAs(UnmanagedType.IUnknown)] out object view);
    int GetViewForAppUserModelId(string id, [MarshalAs(UnmanagedType.IUnknown)] out object view);
    int GetViewInFocus(out IntPtr view);
    int Unknown1(out IntPtr view);
    void RefreshCollection();
    int RegisterForApplicationViewChanges(IntPtr listener, out int cookie);
    int UnregisterForApplicationViewChanges(int cookie);
}

[ComImport, Guid("4ce81583-1e4c-4632-a621-07a53543148f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVirtualDesktopPinnedApps
{
    bool IsAppIdPinned(string appId);
    void PinAppID(string appId);
    void UnpinAppID(string appId);
    [return: MarshalAs(UnmanagedType.Bool)]
    bool IsViewPinned([MarshalAs(UnmanagedType.IUnknown)] object view);
    void PinView([MarshalAs(UnmanagedType.IUnknown)] object view);
    void UnpinView([MarshalAs(UnmanagedType.IUnknown)] object view);
}

public static class VirtualDesktopPin
{
    // Confirmed against MScholtes/PSVirtualDesktop (MIT), the actively
    // maintained reference for these — both because its own GUIDs are kept
    // current across Windows releases, and because it is where "pinned apps
    // comes from QueryService, not CoCreateInstance" (below) came from: the
    // first version of this file called the CLSID directly and failed with
    // REGDB_E_CLASSNOTREG on a current Windows 11 build (26200) — it is a
    // service the shell hands out, not a class Windows registers for
    // ordinary creation.
    private static readonly Guid CLSID_ImmersiveShell = new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F239");
    private static readonly Guid CLSID_VirtualDesktopPinnedApps = new Guid("B5A399E7-1C87-46B8-88E9-FC5747B171BD");
    private static readonly Guid IID_IApplicationViewCollection = new Guid("1841C6D7-4F9D-42C0-AF41-8747538F10E5");
    private static readonly Guid IID_IVirtualDesktopPinnedApps = new Guid("4CE81583-1E4C-4632-A621-07A53543148F");

    public static void Pin(IntPtr hwnd)
    {
        var shell = (IServiceProvider10)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_ImmersiveShell));

        var viewCollectionIid = IID_IApplicationViewCollection;
        var collection = (IApplicationViewCollection)shell.QueryService(ref viewCollectionIid, ref viewCollectionIid);

        object view;
        int hr = collection.GetViewForHwnd(hwnd, out view);
        if (hr != 0 || view == null)
        {
            throw new InvalidOperationException("GetViewForHwnd failed (hr=0x" + hr.ToString("X8") + ") — the window may not have painted its first frame yet");
        }

        var pinnedAppsClsid = CLSID_VirtualDesktopPinnedApps;
        var pinnedAppsIid = IID_IVirtualDesktopPinnedApps;
        var pinnedApps = (IVirtualDesktopPinnedApps)shell.QueryService(ref pinnedAppsClsid, ref pinnedAppsIid);
        pinnedApps.PinView(view);
    }
}
"@ -ErrorAction Stop

try {
  [VirtualDesktopPin]::Pin([IntPtr][int64]$env:HWND)
  Write-Output "RESULT:pinned"
} catch {
  Write-Output ("RESULT:failed: " + $_.Exception.Message)
}
`;

// hwnd: the window's native handle, as win.getNativeWindowHandle() returns
// it (a Buffer holding the raw HWND, little-endian, 4 or 8 bytes by arch).
function hwndToDecimalString(handle) {
  const value = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  return value.toString();
}

// Resolves once the window is pinned, or rejects with why — callers treat
// this as best-effort (see the file comment) rather than let it fail the
// window's own startup.
function pinToAllVirtualDesktops(win) {
  return new Promise((resolve, reject) => {
    const hwnd = hwndToDecimalString(win.getNativeWindowHandle());
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      { windowsHide: true, timeout: 15000, env: { ...process.env, HWND: hwnd } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(err.message));
        const m = /RESULT:(pinned|failed: .*)/.exec(stdout);
        if (!m) return reject(new Error(stderr?.trim() || stdout.trim() || "no result from the pin script"));
        if (m[1] !== "pinned") return reject(new Error(m[1]));
        resolve();
      }
    );
  });
}

module.exports = { pinToAllVirtualDesktops };
