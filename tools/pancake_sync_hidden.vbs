' Runs pancake_sync.bat without opening a console window (used by the "Hylme Pancake Sync" scheduled task)
Dim fso, here
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & here & "\pancake_sync.bat""", 0, True
