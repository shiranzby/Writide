Option Explicit
Dim shell, fso, root, result
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
result = shell.Run("node """ & fso.BuildPath(root, "scripts\start-server.mjs") & """", 1, True)
If result <> 0 Then shell.Popup "Writide failed to start. Run start-writide.bat to see the error, or check writide.log.", 0, "Writide", 16
WScript.Quit result
