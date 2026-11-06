; Al instalar encima de la versión de Electron (hasta la 0.2.8): se desinstala
; primero. Sus datos (%APPDATA%\insti-today) se conservan y esta versión los usa
; tal cual. La clave es la que electron-builder deriva del appId.
; Si abría con Windows, esta también; y se abre al terminar (la actualización
; desde Electron instala en silencio).
!define ELECTRON_ID "9b9a58a9-fe70-5b16-a920-ec4a2d037907"
Var Migrada

!macro NSIS_HOOK_PREINSTALL
  StrCpy $Migrada ""
  ReadRegStr $1 HKCU "Software\${ELECTRON_ID}" "InstallLocation"
  StrCmp $1 "" migrar_inicio
    ; _?= hace que el desinstalador trabaje en su sitio: sin él se copia a TEMP,
    ; ExecWait vuelve al momento y borraba el acceso directo nuevo.
    IfFileExists "$1\Uninstall Insti Today.exe" 0 +2
      ExecWait '"$1\Uninstall Insti Today.exe" /currentuser /S _?=$1'
    RMDir /r "$1"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${ELECTRON_ID}"
    DeleteRegKey HKCU "Software\${ELECTRON_ID}"
    StrCpy $Migrada "1"
  migrar_inicio:
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "mx.institoday.app"
  StrCmp $1 "" migrar_fin
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "mx.institoday.app"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Insti Today" '"$INSTDIR\insti-today.exe"'
    StrCpy $Migrada "1"
  migrar_fin:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  StrCmp $Migrada "1" 0 +3
    ; La instalación silenciosa deja un acceso en el escritorio; la de Electron no tenía.
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    Exec '"$INSTDIR\insti-today.exe"'
!macroend
