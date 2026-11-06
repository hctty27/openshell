package sshclient

import (
	"net"
	"os"
	"runtime"
	"strconv"
	"testing"
)

// Real Windows Rust sidecar <-> Linux lrzsz verification, deliberately
// excluded from PR CI. The 1-GiB test creates several GiB of temporary data.
func TestNativeZmodemGiBInteractivePTY(t *testing.T) {
	if os.Getenv("OPENSHELL_ZMODEM_GIB") != "1" {
		t.Skip("opt-in GiB native ZMODEM interoperability test")
	}
	if runtime.GOOS != "windows" || os.Getenv("OPENSHELL_ZMODEM_CROSS_OS_PTY") != "1" {
		t.Fatal("GiB transfer requires native Windows and isolated Docker Linux SSH")
	}
	host, _, err := net.SplitHostPort(os.Getenv("OPENSHELL_ZMODEM_LIVE_SSH_ADDR"))
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		t.Fatal("GiB transfer requires an IP loopback-only Docker SSH target")
	}
	sizeMiB := 1024
	if raw := os.Getenv("OPENSHELL_ZMODEM_GIB_SIZE_MIB"); raw != "" {
		sizeMiB, err = strconv.Atoi(raw)
		if err != nil || (sizeMiB != 256 && sizeMiB != 512 && sizeMiB != 1024) {
			t.Fatalf("unsupported GiB stress file size %q (use 256/512/1024 MiB)", raw)
		}
	}
	manager := NewManager(keys{}, nil)
	defer manager.Close()
	peer := openNativeStressPeer(t, manager, "gib", 0)
	report := &nativeStressReport{}
	if err := runNativeStressPair(peer, report, "gib", sizeMiB*1024*1024, 0, false); err != nil {
		t.Fatalf("%d MiB native transfer did not pass SHA-256 verification: %v", sizeMiB, err)
	}
	if len(report.Results) != 2 {
		t.Fatalf("expected one upload and one download, got %d", len(report.Results))
	}
	for _, row := range report.Results {
		if row.Protocol != "native" || !row.ChecksumOK || row.Error != "" || row.SizeBytes != int64(sizeMiB)*1024*1024 {
			t.Fatalf("invalid native file-integrity result: %+v", row)
		}
		t.Logf("PASS %s: %d MiB SHA-256 verified (%.2f MiB/s)", row.Direction, sizeMiB, row.MiBPerSecond)
	}
}
