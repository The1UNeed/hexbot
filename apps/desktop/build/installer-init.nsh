; Included by customHeader after electron-builder defines its default macro.
!macro initMultiUser
  !ifdef BUILD_UNINSTALLER
    ; NSIS sets this to the uninstaller's own directory, including _?=.
    StrCpy $HexbotInstallDirectory $INSTDIR
    ${IfNot} ${FileExists} "$INSTDIR\hexbot-install.ini"
      !insertmacro hexbotIdentityError
    ${EndIf}
  !else
    ; NsisUpdater supplies /D=current executable directory for every update.
    !insertmacro GetDParameter $HexbotInstallDirectory
    ${If} $HexbotInstallDirectory != ""
    ${AndIf} ${FileExists} "$HexbotInstallDirectory\Hexbot.exe"
    ${AndIfNot} ${FileExists} "$HexbotInstallDirectory\hexbot-install.ini"
      !insertmacro hexbotIdentityError
    ${EndIf}
  !endif
  !insertmacro hexbotReadIdentity $HexbotInstallDirectory
  ${If} $HexbotInstallDirectory != ""
    ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R0 != ""
    ${AndIf} $R0 != $HexbotInstallDirectory
      ; A marker must never redirect an update to a second installation.
      !insertmacro hexbotIdentityError
    ${EndIf}
  ${EndIf}
  !insertmacro setInstallModePerUser
  !ifdef BUILD_UNINSTALLER
    ; Do not let an absent registry entry redirect uninstall to a default path.
    StrCpy $INSTDIR $HexbotInstallDirectory
  !endif
  ; Initial installs without /D have now resolved their directory from NSIS.
  ${If} ${FileExists} "$INSTDIR\hexbot-install.ini"
    ReadINIStr $R0 "$INSTDIR\hexbot-install.ini" "installation" "appId"
    ${If} $R0 != $HexbotInstallId
      !insertmacro hexbotIdentityError
    ${EndIf}
  ${EndIf}
!macroend
