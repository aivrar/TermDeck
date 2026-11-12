conpty.dll and OpenConsole.exe (x64) from the NuGet package Microsoft.Windows.Console.ConPTY 1.25.261109001.
Source: https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY  (Windows Terminal project, MIT license).
They are copied beside termdeck.exe at build time. The app uses them instead of the console layer built into Windows,
which on Windows 10 mangles some typed symbols and redraws badly on resize. Delete them to fall back to the built-in one.
