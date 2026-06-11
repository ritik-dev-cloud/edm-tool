Set WshShell = CreateObject("WScript.Shell")
WshShell.Run chr(34) & "C:\Vs_Code_Project\edm-tool\start-edm-server.bat" & chr(34), 0
Set WshShell = Nothing
