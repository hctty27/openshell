package sshclient

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

type nativeNetemQdiscStats struct {
	Raw string `json:"raw"`
	SentBytes uint64 `json:"sentBytes"`
	SentPackets uint64 `json:"sentPackets"`
	DroppedPackets uint64 `json:"droppedPackets"`
	Overlimits uint64 `json:"overlimits"`
	Requeues uint64 `json:"requeues"`
	CountersAvailable bool `json:"countersAvailable"`
	ObservedDrops bool `json:"observedDrops"`
}

var nativeNetemCountersPattern = regexp.MustCompile(`Sent\s+(\d+)\s+bytes\s+(\d+)\s+pkt\s+\(dropped\s+(\d+),\s+overlimits\s+(\d+)\s+requeues\s+(\d+)\)`)
var nativeNetemFixtureNamePattern = regexp.MustCompile(`^openshell-zmodem-lab-[a-f0-9]{12}$`)

func parseNativeNetemQdiscStats(raw string) (nativeNetemQdiscStats, error) {
	stats := nativeNetemQdiscStats{Raw: strings.TrimSpace(raw)}
	match := nativeNetemCountersPattern.FindStringSubmatch(raw)
	if len(match) != 6 {
		return stats, fmt.Errorf("tc -s qdisc counters unavailable")
	}
	values := [5]uint64{}
	for i := range values {
		value, err := strconv.ParseUint(match[i+1], 10, 64)
		if err != nil {
			return stats, fmt.Errorf("invalid tc qdisc counter: %w", err)
		}
		values[i] = value
	}
	stats.SentBytes = values[0]
	stats.SentPackets = values[1]
	stats.DroppedPackets = values[2]
	stats.Overlimits = values[3]
	stats.Requeues = values[4]
	stats.CountersAvailable = true
	stats.ObservedDrops = stats.DroppedPackets > 0
	return stats, nil
}

func readNativeNetemQdiscStats(container string) (nativeNetemQdiscStats, error) {
	if !nativeNetemFixtureNamePattern.MatchString(container) {
		return nativeNetemQdiscStats{}, fmt.Errorf("invalid isolated netem container identifier")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "exec", container, "tc", "-s", "qdisc", "show", "dev", "eth0").CombinedOutput()
	if err != nil {
		return nativeNetemQdiscStats{}, fmt.Errorf("reading Docker netem qdisc counters failed: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	stats, err := parseNativeNetemQdiscStats(string(out))
	if err != nil {
		return stats, fmt.Errorf("Docker netem qdisc counters invalid: %w (%s)", err, stats.Raw)
	}
	return stats, nil
}

func TestNativeNetemQdiscCountersParse(t *testing.T) {
	raw := "qdisc netem 8002: root refcnt 13 limit 1000 delay 20ms 8ms loss 0.1%\n Sent 75926119 bytes 89538 pkt (dropped 917, overlimits 0 requeues 3)\n backlog 0b 0p requeues 3\n"
	stats, err := parseNativeNetemQdiscStats(raw)
	if err != nil { t.Fatal(err) }
	if !stats.CountersAvailable || !stats.ObservedDrops || stats.SentBytes != 75926119 ||
		stats.SentPackets != 89538 || stats.DroppedPackets != 917 || stats.Requeues != 3 {
		t.Fatalf("invalid qdisc counters: %+v", stats)
	}
	noLoss, err := parseNativeNetemQdiscStats("qdisc netem 8001: root\n Sent 100 bytes 2 pkt (dropped 0, overlimits 0 requeues 0)")
	if err != nil || noLoss.ObservedDrops {
		t.Fatalf("zero actual drops must not be considered observed loss: %+v, %v", noLoss, err)
	}
	if _, err := parseNativeNetemQdiscStats("qdisc netem 8002: root loss 0.1%"); err == nil {
		t.Fatal("configured loss must not be mistaken for observed dropped packets")
	}
	if nativeNetemFixtureNamePattern.MatchString("production-server") ||
		!nativeNetemFixtureNamePattern.MatchString("openshell-zmodem-lab-001122aabbcc") {
		t.Fatal("Docker fixture name validation is incorrect")
	}
}

func TestNativeNetemQdiscParseInvalidCounters(t *testing.T) {
	_, err := parseNativeNetemQdiscStats("qdisc netem\n Sent 0 bytes 999999999999999999999999999999999 pkt (dropped 1, overlimits 0 requeues 0)")
	if err == nil { t.Fatal("overflow must fail") }
}
