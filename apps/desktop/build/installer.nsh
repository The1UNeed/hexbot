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

!macro customHeader
  !macroundef initMultiUser
  !include "${BUILD_RESOURCES_DIR}/installer-init.nsh"
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
