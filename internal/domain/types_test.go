package domain

import "testing"

func TestValidateSession(t *testing.T) {
	for _, s := range []Session{{Host: "", Port: 22, Username: "root"}, {Host: "localhost", Port: 0, Username: "root"}, {Host: "localhost", Port: 65536, Username: "root"}, {Host: "host", Port: 22}} {
		if ValidateSession(s) == nil {
			t.Errorf("accepted invalid session: %+v", s)
		}
	}
	if err := ValidateSession(Session{Host: "::1", Port: 22, Username: "root", AuthType: "password"}); err != nil {
		t.Fatal(err)
	}
}
