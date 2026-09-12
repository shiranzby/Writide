Option Explicit

Dim shell, fso, root, url, command, i, http
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://127.0.0.1:5173"
shell.CurrentDirectory = root

If Not fso.FolderExists(fso.BuildPath(root, "Workspace")) Then
  fso.CreateFolder(fso.BuildPath(root, "Workspace"))
End If

If Not fso.FolderExists(fso.BuildPath(root, "node_modules")) Then
  shell.Run "cmd.exe /d /c npm install", 0, True
End If

If Not IsReady(url) Then
  command = "cmd.exe /d /c npm run start 1>writide.log 2>&1"
  shell.Run command, 0, False
End If

For i = 1 To 40
  If IsReady(url) Then
    shell.Run url, 1, False
    WScript.Quit 0
  End If
  WScript.Sleep 500
Next

shell.Popup "Writide failed to start. Check writide.log.", 8, "Writide", 16
WScript.Quit 1

Function IsReady(targetUrl)
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", targetUrl, False
  http.setRequestHeader "Cache-Control", "no-cache"
  http.Send
  IsReady = (Err.Number = 0 And http.Status = 200)
  Err.Clear
  On Error GoTo 0
End Function
