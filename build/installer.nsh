; Custom NSIS hooks for vibeTerminal.
;
; electron-updater launches the downloaded installer with the "--updated" flag for
; every auto-update, and never for a first-time install (see electron-updater's
; NsisUpdater.doInstall, which always prepends "--updated"). electron-builder turns
; that flag into the ${isUpdated} LogicLib test.
;
; We use it to make updates apply invisibly (no installer window) while keeping the
; normal wizard for a fresh install. This also covers updates that originate from an
; older build whose main process did not yet pass the silent flag to quitAndInstall(),
; because the *new* installer silences itself based on its own command line.
!macro customInit
  ${if} ${isUpdated}
    SetSilent silent
  ${endif}
!macroend
