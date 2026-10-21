//go:build !windows

package store

import (
	"context"
	"errors"
)

type Secrets struct{}

func NewSecrets() *Secrets { return &Secrets{} }
func (s *Secrets) Get(context.Context, string) (string, error) {
	return "", errors.New("当前系统不支持 Windows 凭据存储")
}
func (s *Secrets) Put(context.Context, string, string) error {
	return errors.New("当前系统不支持 Windows 凭据存储")
}
func (s *Secrets) Delete(context.Context, string) error { return nil }
