package domain

import (
	"strings"
	"testing"
)

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

func TestValidateSessionRejectsCommonInputMistakes(t *testing.T) {
	base := Session{Host: "example.com", Port: 22, Username: "root", AuthType: "password"}
	withHostPort := base
	withHostPort.Host = "example.com:2222"
	if err := ValidateSession(withHostPort); err == nil || !strings.Contains(err.Error(), "hostMustNotIncludePort") {
		t.Fatalf("host:port accepted or wrong code: %v", err)
	}
	for _, ip := range []string{"::1", "[fe80::1]", "2001:db8::2"} {
		ipv6 := base
		ipv6.Host = ip
		if err := ValidateSession(ipv6); err != nil {
			t.Errorf("rejected IPv6 host %q: %v", ip, err)
		}
	}
	long := base
	long.Name = strings.Repeat("名", MaxSessionNameLength)
	if err := ValidateSession(long); err != nil {
		t.Fatalf("rejected name at limit: %v", err)
	}
	long.Name += "x"
	if err := ValidateSession(long); err == nil || !strings.Contains(err.Error(), "sessionNameTooLong") {
		t.Fatalf("over-long name accepted or wrong code: %v", err)
	}
	key := base
	key.AuthType = "key"
	if err := ValidateSession(key); err == nil || !strings.Contains(err.Error(), "privateKeyPathRequired") {
		t.Fatalf("key auth without key path accepted or wrong code: %v", err)
	}
	key.UseSSHConfig = true
	if err := ValidateSession(key); err != nil {
		t.Fatalf("ssh config may supply the identity: %v", err)
	}
	key.UseSSHConfig = false
	key.PrivateKeyPath = "~/.ssh/id_ed25519"
	if err := ValidateSession(key); err != nil {
		t.Fatal(err)
	}
}
