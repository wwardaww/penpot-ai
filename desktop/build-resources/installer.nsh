; Penforge NSIS additions: on uninstall, ask whether to delete the user data
; (database, uploaded assets, logs). The default keeps it.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Also delete your Penforge data (designs database, assets and logs in $APPDATA\Penforge)? Your projects folder is never deleted." /SD IDNO IDNO keepData
      RMDir /r "$APPDATA\Penforge"
    keepData:
  ${endIf}
!macroend
