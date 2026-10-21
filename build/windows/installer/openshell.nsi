Unicode true
!include "MUI2.nsh"

!ifndef APP_VERSION
  !error "APP_VERSION is required"
!endif
!ifndef APP_BINARY
  !error "APP_BINARY is required"
!endif
!ifndef APP_OUTPUT
  !error "APP_OUTPUT is required"
!endif
!ifndef APP_ICON
  !error "APP_ICON is required"
!endif

Name "OpenShell"
OutFile "${APP_OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\OpenShell"
InstallDirRegKey HKCU "Software\OpenShell" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "OpenShell"
VIAddVersionKey "FileDescription" "OpenShell SSH Client Installer"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "CompanyName" "Cheng"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Install" SecMain
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File "${APP_BINARY}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\OpenShell"
  CreateShortcut "$SMPROGRAMS\OpenShell\OpenShell.lnk" "$INSTDIR\OpenShell.exe"
  CreateShortcut "$DESKTOP\OpenShell.lnk" "$INSTDIR\OpenShell.exe"
  WriteRegStr HKCU "Software\OpenShell" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenShell" "DisplayName" "OpenShell"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenShell" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenShell" "Publisher" "Cheng"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenShell" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenShell" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenShell" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenShell" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$INSTDIR\OpenShell.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\OpenShell\OpenShell.lnk"
  RMDir "$SMPROGRAMS\OpenShell"
  Delete "$DESKTOP\OpenShell.lnk"
  DeleteRegKey HKCU "Software\OpenShell"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenShell"
SectionEnd
