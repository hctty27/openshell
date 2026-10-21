//go:build !windows

package store

import (
	"context"
	"github.com/hctty27/openshell/internal/apperror"
)

type Secrets struct{}

func NewSecrets() *Secrets { return &Secrets{} }
func (s *Secrets) Get(context.Context, string) (string, error) {
	return "", apperror.New("windowsCredentialStorageIsUnavailableOnThisSystem", nil)
}
func (s *Secrets) Put(context.Context, string, string) error {
	return apperror.New("windowsCredentialStorageIsUnavailableOnThisSystem", nil)
}
func (s *Secrets) Delete(context.Context, string) error { return nil }
