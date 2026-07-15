Option Explicit

Dim fileSystem
Dim shell
Dim scriptDirectory
Dim backendScript
Dim command

Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
backendScript = fileSystem.BuildPath(scriptDirectory, "start-mobile-codex.ps1")
command = "powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File """ & backendScript & """"

WScript.Quit shell.Run(command, 0, True)
