package main

import (

"github.com/hctty27/openshell/internal/apperror"
	"github.com/hctty27/openshell/internal/domain"
	sshclient "github.com/hctty27/openshell/internal/ssh"
)

// StartExperimentalNativeZmodem is intentionally not exposed in the UI.
// Set OPENSHELL_NATIVE_ZMODEM_EXPERIMENT=1 and provide an explicit
// OPENSHELL_NATIVE_ZMODEM_SIDECAR binary path to opt into local testing.
func (a *App) StartExperimentalNativeZmodem(request sshclient.NativeZmodemRequest) error {
	if a.nativeZmodem == nil { return apperror.New("zmodemExperimentDisabled", nil) }
	return a.nativeZmodem.Run(a.ctx, request)
}

func (a *App) CancelExperimentalNativeZmodem(ref domain.ConnectionRef) error {
	if a.nativeZmodem == nil || !a.nativeZmodem.Cancel(ref) {
		return apperror.New("zmodemNothingToCancel", nil)
	}
	return nil
}
