//go:build !windows

package main

import "errors"

func newLocalPTY(_ string, _, _ int) (localPTY, error) {
    return nil, errors.New("local shell requires Windows ConPTY")
}
