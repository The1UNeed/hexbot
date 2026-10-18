; An update changes the payload track, not the original Windows installation.
; electron-builder 26.16.1 calls customInit/customUnInit after initMultiUser, so
; select the identity before that macro reads any install or uninstall keys.
!include "LogicLib.nsh"
!include "FileFunc.nsh"

Var HexbotInstallId
Var HexbotInstallDirectory
Var HexbotShortcutName

!define HEXBOT_BUILD_ID "${APP_GUID}"
!define HEXBOT_BUILD_SHORTCUT "${SHORTCUT_NAME}"
!undef APP_ID
!define APP_ID "$HexbotInstallId"
!undef SHORTCUT_NAME
!define SHORTCUT_NAME "$HexbotShortcutName"
!undef UNINSTALL_DISPLAY_NAME
!define UNINSTALL_DISPLAY_NAME "$HexbotShortcutName"
!define INSTALL_REGISTRY_KEY "Software\$HexbotInstallId"
!define UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\$HexbotInstallId"
!ifdef APP_INSTALLER_STORE_FILE
  !undef APP_INSTALLER_STORE_FILE
  !define APP_INSTALLER_STORE_FILE "$HexbotInstallId-updater\installer.exe"
!endif

!macro hexbotIdentityError
  MessageBox MB_OK|MB_ICONSTOP "Cannot identify this Hexbot installation. Run the Hexbot Installer to repair it." /SD IDOK
  SetErrorLevel 2
  Quit
!macroend

!macro hexbotReadIdentity DIRECTORY
  StrCpy $HexbotInstallId "${HEXBOT_BUILD_ID}"
  ${If} "${DIRECTORY}" != ""
  ${AndIf} ${FileExists} "${DIRECTORY}\hexbot-install.ini"
    ClearErrors
    ReadINIStr $HexbotInstallId "${DIRECTORY}\hexbot-install.ini" "installation" "appId"
    ${If} ${Errors}
      !insertmacro hexbotIdentityError
    ${EndIf}
  ${EndIf}
  ; Release tracks may replace each other within one edition. Dev stays separate.
  ${If} "${HEXBOT_BUILD_ID}" == "app.hexbot.desktop"
  ${OrIf} "${HEXBOT_BUILD_ID}" == "app.hexbot.desktop.nightly"
    ${If} $HexbotInstallId != "app.hexbot.desktop"
    ${AndIf} $HexbotInstallId != "app.hexbot.desktop.nightly"
      !insertmacro hexbotIdentityError
    ${EndIf}
  ${ElseIf} "${HEXBOT_BUILD_ID}" == "app.hexbot.client"
  ${OrIf} "${HEXBOT_BUILD_ID}" == "app.hexbot.client.nightly"
    ${If} $HexbotInstallId != "app.hexbot.client"
    ${AndIf} $HexbotInstallId != "app.hexbot.client.nightly"
      !insertmacro hexbotIdentityError
    ${EndIf}
  ${ElseIf} $HexbotInstallId != "${HEXBOT_BUILD_ID}"
    !insertmacro hexbotIdentityError
  ${EndIf}
  StrCpy $HexbotShortcutName "${HEXBOT_BUILD_SHORTCUT}"
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" ShortcutName
  ${If} $R0 != ""
    StrCpy $HexbotShortcutName $R0
  ${EndIf}
!macroend

; Recover an interrupted first install only when both registry records still
; identify this build's exact directory and uninstaller. Never infer another track.
!macro hexbotRequireRegisteredBuild DIRECTORY
  ReadRegStr $R0 HKCU "Software\${HEXBOT_BUILD_ID}" InstallLocation
  ${If} $R0 != "${DIRECTORY}"
    !insertmacro hexbotIdentityError
  ${EndIf}
  ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${HEXBOT_BUILD_ID}" UninstallString
  StrCpy $R2 '"${DIRECTORY}\Uninstall Hexbot.exe"'
  StrLen $R3 $R2
  StrCpy $R1 $R1 $R3
  ${If} $R1 != $R2
    !insertmacro hexbotIdentityError
  ${EndIf}
!macroend

!macro customHeader
  !macroundef initMultiUser
  !macroundef GetDParameter
  !addincludedir "${BUILD_RESOURCES_DIR}"
  !include "installer-init.nsh"
!macroend

!macro customInstall
  ClearErrors
  WriteINIStr "$INSTDIR\hexbot-install.ini" "installation" "appId" "$HexbotInstallId"
  ${If} ${Errors}
    !insertmacro hexbotIdentityError
  ${EndIf}
  ; Keep differential-update files separate for coexisting initial installs.
  ; Preserve the signed build's publisherName and every other updater setting.
  ClearErrors
  FileOpen $R0 "$INSTDIR\resources\app-update.yml" r
  ${If} ${Errors}
    !insertmacro hexbotIdentityError
  ${EndIf}
  FileOpen $R1 "$PLUGINSDIR\hexbot-app-update.yml" w
  ${If} ${Errors}
    FileClose $R0
    !insertmacro hexbotIdentityError
  ${EndIf}
  StrCpy $R7 0
  ${Do}
    FileSeek $R0 0 CUR $R4
    ClearErrors
    FileRead $R0 $R2
    ${If} ${Errors}
      ${ExitDo}
    ${EndIf}
    FileSeek $R0 0 CUR $R5
    StrCpy $R3 $R2 21
    ${If} $R3 == "updaterCacheDirName: "
      FileWrite $R1 "updaterCacheDirName: $HexbotInstallId-updater$\r$\n"
      IntOp $R7 $R7 + 1
    ${Else}
      ; Copy untouched bytes, including UTF-8 publisher names, without any
      ; conversion through the Windows ANSI code page used by FileRead.
      FileSeek $R0 $R4 SET
      ${DoWhile} $R4 < $R5
        FileReadByte $R0 $R6
        FileWriteByte $R1 $R6
        IntOp $R4 $R4 + 1
      ${Loop}
    ${EndIf}
  ${Loop}
  FileClose $R0
  FileClose $R1
  ${If} $R7 != 1
    !insertmacro hexbotIdentityError
  ${EndIf}
  ClearErrors
  CopyFiles /SILENT "$PLUGINSDIR\hexbot-app-update.yml" "$INSTDIR\resources\app-update.yml"
  ${If} ${Errors}
    !insertmacro hexbotIdentityError
  ${EndIf}
!macroend

; The stock helper matches directory prefixes and can kill a separate Nightly
; install or a native daemon with the same basename. Wait for this exact app's
; processes instead, and refuse to continue when process inspection fails.
!macro customCheckAppRunning
  Push $0
  Push $1
  System::Call 'kernel32::SetEnvironmentVariableW(w "HEXBOT_INSTALL_APP_EXECUTABLE", w "$INSTDIR\${APP_EXECUTABLE_FILENAME}")i.r0'
  ${If} $0 == 0
    !insertmacro hexbotIdentityError
  ${EndIf}
  ; An updater launched by PowerShell 7 can inherit its incompatible module
  ; search path. Load only the stock Windows PowerShell modules for inspection.
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "$$ErrorActionPreference='Stop';$$env:PSModulePath=$$PSHOME+'\Modules';Import-Module ($$PSHOME+'\Modules\CimCmdlets\CimCmdlets.psd1') -ErrorAction Stop;$$end=[DateTime]::UtcNow.AddSeconds(15);do{$$running=@(Get-CimInstance Win32_Process -Filter 'Name=''Hexbot.exe''' | Where-Object{[string]::Equals($$_.ExecutablePath,$$env:HEXBOT_INSTALL_APP_EXECUTABLE,[StringComparison]::OrdinalIgnoreCase)});if(!$$running.Count){exit 0};Start-Sleep -Milliseconds 200}while([DateTime]::UtcNow -lt $$end);exit 2"`
  Pop $0
  Pop $1
  System::Call 'kernel32::SetEnvironmentVariableW(w "HEXBOT_INSTALL_APP_EXECUTABLE", p 0)'
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Close Hexbot and try again. The installer could not verify that this app has exited." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  Pop $1
  Pop $0
!macroend
