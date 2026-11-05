# Electron registers the per-user handler at app startup. Uninstall must leave
# another edition/channel's handler alone, just like the outer installer.
!macro customUnInstall
  # electron-updater runs NSIS uninstall during an upgrade, too.
  ${ifNot} ${isUpdated}
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    SetRegView 64
    ClearErrors
    ReadRegStr $0 HKCU "Software\Classes\hexbot\shell\open\command" ""
    ${ifNot} ${Errors}
      # Ownership matches the command exactly as this install wrote it: the
      # $INSTDIR spelling, quoted, with %1. Junction or 8.3 spellings written
      # by other installs are left alone, like the outer installer's refusal
      # to touch handlers it does not own.
      StrCpy $1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
      # OrdinalIgnoreCase matches the outer installer, including Unicode paths.
      # Full equality also rejects extra arguments, unquoted paths and %L.
      System::Call 'kernel32::CompareStringOrdinal(w r0, i -1, w r1, i -1, i 1) i .r2'
      StrCmp $2 2 0 hexbot_protocol_done # CSTR_EQUAL
      StrLen $2 $0
      # ReadRegStr accepts REG_EXPAND_SZ. Query the actual kind and byte length
      # so expansion, embedded NULs and truncated reads cannot confer ownership.
      System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "Software\Classes\hexbot\shell\open\command", i 0, i 0x103, *p .r3) i .r4'
      ${if} $4 == 0
        System::Call 'advapi32::RegQueryValueExW(p r3, w "", p 0, *i .r5, p 0, *i .r6) i .r4'
        ${if} $4 == 0
        ${andIf} $5 == 1 # REG_SZ only
          IntOp $7 $2 + 1
          IntOp $7 $7 * 2
          ${if} $6 == $7
            # Delete only the command's default value; retain named values,
            # children and protocol metadata, as the outer installer does.
            System::Call 'advapi32::RegDeleteValueW(p r3, w "") i .r4'
            ${if} $4 != 0
              DetailPrint "hexbot protocol cleanup left the handler behind (error $4)"
              SetErrors
            ${endif}
          ${endif}
        ${endif}
        System::Call 'advapi32::RegCloseKey(p r3)'
      ${endif}
    ${endif}
hexbot_protocol_done:
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
    ClearErrors
  ${endif}
!macroend
