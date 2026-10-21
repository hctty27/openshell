//go:build windows

package store

import (
	"context"
	"errors"
	"github.com/hctty27/openshell/internal/branding"
	"github.com/zalando/go-keyring"
)

type Secrets struct{}

func NewSecrets() *Secrets { return &Secrets{} }
func (s *Secrets) Get(_ context.Context, ref string) (string, error) {
	return keyring.Get(branding.Name, ref)
}
func (s *Secrets) Put(_ context.Context, ref, value string) error {
	return keyring.Set(branding.Name, ref, value)
}
func (s *Secrets) Delete(_ context.Context, ref string) error {
	err := keyring.Delete(branding.Name, ref)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
