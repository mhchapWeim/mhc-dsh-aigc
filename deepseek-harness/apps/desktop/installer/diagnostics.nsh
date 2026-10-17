!define /ifndef DSH_INSTALLER_DIAGNOSTICS_URL ""
!define DSH_INSTALLER_DIAGNOSTICS_ENABLED
!define /ifndef DSH_INSTALLER_DIAGNOSTICS_VERSION "development"

Function InstallerReportFailure
  System::Store /NOUNLOAD "S"
  System::Call '$PLUGINSDIR\window-frame.dll::InstallerReportFailure(w "${DSH_INSTALLER_DIAGNOSTICS_URL}", w "${DSH_INSTALLER_DIAGNOSTICS_VERSION}", w "$InstallerFailureStage", i $InstallerFailureCode, w "$InstallerError", w "$InstallerPath", w "$InstallerFailureOutput") i.r0 ?c'
  System::Store "L"
FunctionEnd
