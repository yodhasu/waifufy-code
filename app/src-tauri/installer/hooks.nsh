; Hooks into Tauri's NSIS template (bundle > windows > nsis > installerHooks).
;
; The template only checks for ${MAINBINARYNAME}.exe, and it does so after these hooks run. While the app is
; open its sidecar dies with it (a job object, see src/lib.rs), so the template's own close is enough. What these
; hooks catch is a sidecar left over with no app around it: a node.exe or claude.exe under sidecar\ that would lock
; its files and stop the copy or the uninstall with an Abort/Retry/Ignore error. They never touch the sidecar of a
; running app, which belongs to the user's open chat until the template asks to close it.
;
; Processes are found through CIM because the installer is 32-bit, and a 32-bit PowerShell cannot read the
; image path of a 64-bit process through Get-Process.

!macro WC_END_ORPHANED_SIDECAR
  ; Passed through the environment so a quote in the install path cannot break the PowerShell line.
  System::Call 'kernel32::SetEnvironmentVariable(t "WC_INSTDIR", t "$INSTDIR")i'
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$dir = $$env:WC_INSTDIR; $$all = Get-CimInstance Win32_Process; if (-not ($$all | Where-Object ExecutablePath -eq (Join-Path $$dir '${MAINBINARYNAME}.exe'))) { $$all | Where-Object ExecutablePath -like (Join-Path $$dir 'sidecar\*') | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro WC_END_ORPHANED_SIDECAR
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro WC_END_ORPHANED_SIDECAR
!macroend

; "Delete the application data" also removes the app's own data folder (settings, profile and avatar, saves,
; thumbnails, logs), which is named after the app rather than the bundle identifier the template cleans up.
; Never during an update. Transcripts stay in ~\.claude, where Claude Code keeps them.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RmDir /r "$APPDATA\waifufy-code"
  ${EndIf}
!macroend
