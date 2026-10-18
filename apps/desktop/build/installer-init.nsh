; Included by customHeader after electron-builder defines its default macros.
; Normalize only Node's paired quotes around the complete final /D= argument.
; Preserve NSIS's documented unquoted /D=rest syntax and all path bytes.
!macro GetDParameter OUT
  Push $R8
  Push $R9
  Push $R7
  Push $R6
  Push $R5
  Push $R4
  Push $R3
  ${StdUtils.GetAllParameters} $R8 "0"
  StrCpy $R9 ""
  StrLen $R7 $R8
  IntOp $R7 $R7 - 2
  StrCpy $R6 0
  ${Do}
    StrCpy $R5 $R8 3 $R6
    ${If} $R5 == "/D="
    ${OrIf} $R5 == "/d="
      IntOp $R4 $R6 + 3
      StrCpy $R9 $R8 "" $R4
      ${If} $R6 > 0
        IntOp $R4 $R6 - 1
        StrCpy $R5 $R8 1 $R4
        ${If} $R5 == '"'
          StrCpy $R3 "false"
          ${If} $R4 == 0
            StrCpy $R3 "true"
          ${Else}
            IntOp $R4 $R4 - 1
            StrCpy $R5 $R8 1 $R4
            ${If} $R5 == " "
            ${OrIf} $R5 == "$\t"
              StrCpy $R3 "true"
            ${EndIf}
          ${EndIf}
          StrCpy $R5 $R9 1 -1
          ${If} $R3 == "true"
          ${AndIf} $R5 == '"'
            StrCpy $R9 $R9 -1
          ${EndIf}
        ${EndIf}
      ${EndIf}
      ${Break}
    ${EndIf}
    IntOp $R6 $R6 + 1
  ${LoopUntil} $R6 > $R7
  StrCpy ${OUT} $R9
  Pop $R3
  Pop $R4
  Pop $R5
  Pop $R6
  Pop $R7
  Pop $R9
  Pop $R8
!macroend

!macro initMultiUser
  !ifdef BUILD_UNINSTALLER
    ; NSIS sets this to the uninstaller's own directory, including _?=.
    StrCpy $HexbotInstallDirectory $INSTDIR
  !else
    ; NsisUpdater supplies /D=current executable directory for every update.
    !insertmacro GetDParameter $HexbotInstallDirectory
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
  ${ElseIf} ${FileExists} "$INSTDIR\Hexbot.exe"
    !insertmacro hexbotRequireRegisteredBuild $INSTDIR
  ${EndIf}
!macroend
