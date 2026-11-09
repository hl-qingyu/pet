Option Explicit
Dim fso, sh, root, exe, args
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = root & "\dist\win-unpacked\DragonDesk.exe"
args = " " & Chr(34) & "--config=" & root & "\config.json" & Chr(34)
If Not fso.FileExists(exe) Then
  exe = root & "\node_modules\electron\dist\electron.exe"
  args = " " & Chr(34) & root & Chr(34) & args
End If
If fso.FileExists(exe) Then
  sh.CurrentDirectory = root
  sh.Run Chr(34) & exe & Chr(34) & args, 1, False
Else
  MsgBox "Run npm install and npm run build:win first.", 48, "DragonDesk"
End If
