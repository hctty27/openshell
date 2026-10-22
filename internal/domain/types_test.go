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

func TestValidateSessionTheme(t *testing.T) {
	base := Session{Host: "localhost", Port: 22, Username: "root", AuthType: "password"}
	for _, theme := range []string{"", "follow", "classic", "dark", "light"} {
		base.TerminalTheme = theme
		if err := ValidateSession(base); err != nil { t.Errorf("rejected valid palette %q: %v", theme, err) }
	}
	base.TerminalTheme = "unexpected"
	if err := ValidateSession(base); err == nil { t.Fatal("accepted invalid terminal palette") }
}
