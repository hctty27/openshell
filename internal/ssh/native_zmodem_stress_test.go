package sshclient

import (
 "context"
 "crypto/rand"
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net"
 "os"
 "path"
 "path/filepath"
 "runtime"
 "runtime/trace"
 "strconv"
 "strings"
 "sync"
 "testing"
 "time"

 "github.com/hctty27/openshell/internal/domain"
 "github.com/pkg/sftp"
 "golang.org/x/crypto/ssh"
)

// This suite is explicitly opt-in, uses a loopback-only Docker SSH fixture,
// and never runs in standard PR CI or touches a production SSH server.
func TestNativeZmodemStressInteractivePTY(t *testing.T) {
 if os.Getenv("OPENSHELL_ZMODEM_STRESS") != "1" {
  t.Skip("opt-in Windows to Docker Linux SSH PTY stress suite")
 }
 if runtime.GOOS != "windows" {
  t.Skip("Windows-native stress evidence must run on Windows")
 }
 if os.Getenv("OPENSHELL_ZMODEM_CROSS_OS_PTY") != "1" {
  t.Fatal("stress requires the isolated cross-OS SSH lab")
 }
 host, _, err := net.SplitHostPort(os.Getenv("OPENSHELL_ZMODEM_LIVE_SSH_ADDR"))
 if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
  t.Fatal("stress requires an IP loopback-only Docker SSH target")
 }
 opts := readNativeStressOptions(t)
 report := &nativeStressReport{Version: 1, StartedAt: time.Now().UTC(), ClientOS: runtime.GOOS, Options: opts}
 t.Cleanup(func() {
  destination := os.Getenv("OPENSHELL_ZMODEM_STRESS_REPORT")
  if destination == "" { return }
  if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil { t.Errorf("create report directory: %v", err); return }
  report.mu.Lock()
  payload, err := json.MarshalIndent(report, "", "  ")
  report.mu.Unlock()
  if err != nil { t.Errorf("marshal stress report: %v", err); return }
  if err := os.WriteFile(destination, append(payload, '\n'), 0600); err != nil {
   t.Errorf("write stress report: %v", err)
  } else { t.Logf("native ZMODEM stress JSON: %s", destination) }
 })
 manager := NewManager(keys{}, nil)
 t.Cleanup(manager.Close)
 shouldRun := func(name string) bool { return opts.Profile == "all" || opts.Profile == name }
 if shouldRun("large") {
  t.Run("large", func(t *testing.T) {
   peer := openNativeStressPeer(t, manager, "large", 0)
   if err := runNativeStressPair(peer, report, "large", opts.LargeMiB*1024*1024, 0, true); err != nil { t.Fatal(err) }
  })
 }
 if shouldRun("repeat") {
  t.Run("repeat", func(t *testing.T) {
   peer := openNativeStressPeer(t, manager, "repeat", 0)
   for i := 0; i < opts.Rounds; i++ {
    if err := runNativeStressPair(peer, report, "repeat", 1024*1024, i, false); err != nil {
     t.Fatalf("round %d/%d: %v", i+1, opts.Rounds, err)
    }
   }
  })
 }
 if shouldRun("parallel") {
  t.Run("parallel", func(t *testing.T) {
   peers := make([]*nativeStressPeer, opts.Workers)
   for i := range peers { peers[i] = openNativeStressPeer(t, manager, fmt.Sprintf("parallel-%d", i), 0) }
   ready := make(chan struct{})
   failures := make(chan error, opts.Workers)
   var running sync.WaitGroup
   for i, peer := range peers {
    running.Add(1)
    go func(worker int, p *nativeStressPeer) {
     defer running.Done()
     <-ready
     if err := runNativeStressPair(p, report, "parallel", 4*1024*1024, worker, false); err != nil {
      failures <- fmt.Errorf("worker %d: %w", worker, err)
     }
    }(i, peer)
   }
   close(ready)
   running.Wait()
   close(failures)
   for err := range failures { t.Error(err) }
  })
 }
 if shouldRun("latency") {
  t.Run("latency", func(t *testing.T) {
   peer := openNativeStressPeer(t, manager, "latency", time.Duration(opts.LatencyMS)*time.Millisecond)
   if err := runNativeStressPair(peer, report, "latency", 1024*1024, 0, true); err != nil { t.Fatal(err) }
  })
 }
}

type nativeStressOptions struct {
 Profile string `json:"profile"`
 LargeMiB int `json:"largeMiB"`
 Rounds int `json:"rounds"`
 Workers int `json:"workers"`
 LatencyMS int `json:"latencyMs"`
 WireBatchBytes int `json:"wireBatchBytes"`
}

func readNativeStressOptions(t *testing.T) nativeStressOptions {
 t.Helper()
 opts := nativeStressOptions{Profile: os.Getenv("OPENSHELL_ZMODEM_STRESS_PROFILE")}
 if opts.Profile == "" { opts.Profile = "all" }
 switch opts.Profile {
 case "all", "large", "repeat", "parallel", "latency":
 default: t.Fatalf("invalid stress profile %q", opts.Profile)
 }
 number := func(name string, def, min, max int) int {
  raw := os.Getenv(name)
  if raw == "" { return def }
  value, err := strconv.Atoi(raw)
  if err != nil || value < min || value > max { t.Fatalf("invalid %s=%q (valid %d..%d)", name, raw, min, max) }
  return value
 }
 opts.LargeMiB = number("OPENSHELL_ZMODEM_STRESS_LARGE_MIB", 128, 1, 128)
 opts.Rounds = number("OPENSHELL_ZMODEM_STRESS_ROUNDS", 30, 1, 50)
 opts.Workers = number("OPENSHELL_ZMODEM_STRESS_WORKERS", 3, 1, 4)
 opts.LatencyMS = number("OPENSHELL_ZMODEM_STRESS_LATENCY_MS", 3, 0, 10)
 opts.WireBatchBytes = number("OPENSHELL_ZMODEM_WIRE_BATCH_BYTES", 0, 0, 32*1024)
 return opts
}

type nativeStressRecord struct {
 Profile string `json:"profile"`
 Attempt int `json:"attempt"`
 Protocol string `json:"protocol"`
 Direction string `json:"direction"`
 SizeBytes int64 `json:"sizeBytes"`
 DurationMS int64 `json:"durationMs"`
 MiBPerSecond float64 `json:"miBPerSecond"`
 ChecksumOK bool `json:"checksumOK"`
 Error string `json:"error,omitempty"`
 StagesMS map[string]int64 `json:"stagesMs,omitempty"`
 IO *nativeZmodemIOStats `json:"io,omitempty"`
}

type nativeStressSample struct {
 StagesMS map[string]int64
 IO *nativeZmodemIOStats
}

type nativeStressReport struct {
 mu sync.Mutex
 Version int `json:"version"`
 StartedAt time.Time `json:"startedAt"`
 ClientOS string `json:"clientOS"`
 Options nativeStressOptions `json:"options"`
 Results []nativeStressRecord `json:"results"`
}

func (r *nativeStressReport) add(profile, protocol, direction string, attempt int, size int64, elapsed time.Duration, err error, samples ...nativeStressSample) {
 record := nativeStressRecord{Profile: profile, Attempt: attempt, Protocol: protocol, Direction: direction,
  SizeBytes: size, DurationMS: elapsed.Milliseconds(), ChecksumOK: err == nil}
 if elapsed > 0 { record.MiBPerSecond = float64(size) / (1024*1024) / elapsed.Seconds() }
 if err != nil { record.Error = err.Error() }
 if len(samples) > 0 {
  sample := samples[0]
  if sample.StagesMS != nil {
   record.StagesMS = make(map[string]int64, len(sample.StagesMS))
   for key, value := range sample.StagesMS { record.StagesMS[key] = value }
  }
  if sample.IO != nil {
   stats := *sample.IO
   record.IO = &stats
  }
 }
 r.mu.Lock()
 r.Results = append(r.Results, record)
 r.mu.Unlock()
}

type nativeStressPeer struct {
 manager *Manager
 ref domain.ConnectionRef
 sftp *sftp.Client
 home string
 id string
 localDir string
 remoteFiles []string
}

func nativeStressCredential(t *testing.T, name string) string {
 t.Helper()
 value := os.Getenv(name)
 if value == "" { t.Fatalf("missing %s", name) }
 return value
}

func openNativeStressPeer(t *testing.T, manager *Manager, label string, delay time.Duration) *nativeStressPeer {
 t.Helper()
 address := nativeStressCredential(t, "OPENSHELL_ZMODEM_LIVE_SSH_ADDR")
 username := nativeStressCredential(t, "OPENSHELL_ZMODEM_LIVE_SSH_USER")
 pem, err := os.ReadFile(nativeStressCredential(t, "OPENSHELL_ZMODEM_LIVE_SSH_KEY"))
 if err != nil { t.Fatal(err) }
 signer, err := ssh.ParsePrivateKey(pem)
 if err != nil { t.Fatal(err) }
 hostPEM, err := os.ReadFile(nativeStressCredential(t, "OPENSHELL_ZMODEM_LIVE_SSH_HOSTKEY"))
 if err != nil { t.Fatal(err) }
 hostKey, _, _, _, err := ssh.ParseAuthorizedKey(hostPEM)
 if err != nil { t.Fatal(err) }
 tcp, err := net.DialTimeout("tcp", address, 10*time.Second)
 if err != nil { t.Fatal(err) }
 var wire net.Conn = tcp
 if delay > 0 { wire = &nativeCrossOSDelayedConn{Conn: tcp, delay: delay} }
 conn, chans, requests, err := ssh.NewClientConn(wire, address, &ssh.ClientConfig{
  User: username, Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)},
  HostKeyCallback: ssh.FixedHostKey(hostKey), Timeout: 10*time.Second,
 })
 if err != nil { _ = tcp.Close(); t.Fatal(err) }
 client := ssh.NewClient(conn, chans, requests)
 sftpClient, err := sftp.NewClient(client)
 if err != nil { _ = client.Close(); t.Fatal(err) }
 sh, err := client.NewSession()
 if err != nil { _ = sftpClient.Close(); _ = client.Close(); t.Fatal(err) }
 output, err := sh.Output("uname -s; printf '%s' \"$HOME\"")
 _ = sh.Close()
 if err != nil { _ = sftpClient.Close(); _ = client.Close(); t.Fatal(err) }
 parts := strings.SplitN(strings.TrimSpace(string(output)), "\n", 2)
 if len(parts) != 2 || parts[0] != "Linux" || !strings.HasPrefix(parts[1], "/") {
  _ = sftpClient.Close(); _ = client.Close()
  t.Fatalf("only isolated Linux SSH fixtures supported: %q", output)
 }
 var random [8]byte
 if _, err := rand.Read(random[:]); err != nil { t.Fatal(err) }
 id := hex.EncodeToString(random[:])
 peer := &nativeStressPeer{
  manager: manager,
  ref: domain.ConnectionRef{TabID: "stress-"+label+"-"+id, SessionID: "native-stress", Generation: 1},
  sftp: sftpClient, home: strings.TrimSpace(parts[1]), id: id, localDir: t.TempDir(),
 }
 manager.mu.Lock()
 manager.connections[peer.ref.TabID] = &connection{ref: peer.ref, client: client, history: NewHistory(128*1024)}
 manager.generations[peer.ref.TabID] = peer.ref.Generation
 manager.mu.Unlock()
 if err := manager.OpenTerminal(peer.ref, 80, 24); err != nil { t.Fatal(err) }
 t.Cleanup(func() {
  for _, name := range peer.remoteFiles { _ = peer.sftp.Remove(name) }
  _ = peer.sftp.Close()
  // OpenShell Manager owns the SSH client until its outer Cleanup runs.
 })
 return peer
}

func makeNativeStressFile(filename string, size int64) ([32]byte, error) {
 var zero [32]byte
 f, err := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
 if err != nil { return zero, err }
 h := sha256.New()
 block := make([]byte, 64*1024)
 for i := range block { block[i] = byte((i*197+31)%251) }
 remaining := size
 for remaining > 0 {
  n := int64(len(block))
  if remaining < n { n = remaining }
  piece := block[:int(n)]
  if _, err := f.Write(piece); err != nil { _ = f.Close(); return zero, err }
  _, _ = h.Write(piece)
  remaining -= n
 }
 if err := f.Close(); err != nil { return zero, err }
 copy(zero[:], h.Sum(nil))
 return zero, nil
}

func nativeStressCompareFile(filename string, expected [32]byte) error {
 file, err := os.Open(filename)
 if err != nil { return err }
 actual, digestErr := nativeCrossOSDigest(file)
 closeErr := file.Close()
 if digestErr != nil { return digestErr }
 if closeErr != nil { return closeErr }
 if actual != expected { return errors.New("local SHA-256 mismatch") }
 return nil
}

func nativeStressCompareSFTP(client *sftp.Client, filename string, expected [32]byte) error {
 file, err := client.Open(filename)
 if err != nil { return err }
 actual, digestErr := nativeCrossOSDigest(file)
 closeErr := file.Close()
 if digestErr != nil { return digestErr }
 if closeErr != nil { return closeErr }
 if actual != expected { return errors.New("remote SHA-256 mismatch") }
 return nil
}

func runNativeStressPair(peer *nativeStressPeer, report *nativeStressReport, profile string, size int, round int, sftpBaseline bool) error {
 name := fmt.Sprintf("openshell-stress-%s-%02d.bin", peer.id, round)
 source := filepath.Join(peer.localDir, name)
 expected, err := makeNativeStressFile(source, int64(size))
 if err != nil { return err }
 sidecar := os.Getenv("OPENSHELL_ZMODEM_LIVE_SIDECAR")
 if sidecar == "" { return errors.New("missing sidecar executable") }

 remoteUpload := path.Join(peer.home, name)
 peer.remoteFiles = append(peer.remoteFiles, remoteUpload)
 started := time.Now()
 ctx, cancel := context.WithTimeout(context.Background(), 88*time.Second)
 uploadStages := make(map[string]int64, 4)
 uploadMeter := &nativeZmodemIOMeter{}
 ctx = withNativeZmodemIOMeter(ctx, uploadMeter)
 ctx = withNativeZmodemStageObserver(ctx, func(name string, elapsed time.Duration) {
  uploadStages[name] = elapsed.Milliseconds()
 })
 trace.WithRegion(ctx, "native-zmodem:upload", func() {
  err = peer.manager.runNativeTerminalExperiment(ctx, peer.ref, sidecar, "upload", source, "")
 })
 cancel()
 elapsed := time.Since(started)
 if err == nil { err = nativeStressCompareSFTP(peer.sftp, remoteUpload, expected) }
 uploadSnapshot := uploadMeter.snapshot()
 report.add(profile, "native", "upload", round, int64(size), elapsed, err,
  nativeStressSample{StagesMS: uploadStages, IO: &uploadSnapshot})
 if err != nil { return fmt.Errorf("native upload: %w", err) }

 remoteSource := path.Join(peer.home, "source-"+name)
 peer.remoteFiles = append(peer.remoteFiles, remoteSource)
 remote, err := peer.sftp.Create(remoteSource)
 if err != nil { return err }
 local, err := os.Open(source)
 if err != nil { _ = remote.Close(); return err }
 _, copyErr := io.Copy(remote, local)
 closeLocalErr := local.Close()
 closeRemoteErr := remote.Close()
 if copyErr != nil { return copyErr }
 if closeLocalErr != nil { return closeLocalErr }
 if closeRemoteErr != nil { return closeRemoteErr }

 destination := filepath.Join(peer.localDir, "down-"+name)
 if err := os.Mkdir(destination, 0700); err != nil { return err }
 started = time.Now()
 ctx, cancel = context.WithTimeout(context.Background(), 88*time.Second)
 downloadStages := make(map[string]int64, 4)
 downloadMeter := &nativeZmodemIOMeter{}
 ctx = withNativeZmodemIOMeter(ctx, downloadMeter)
 ctx = withNativeZmodemStageObserver(ctx, func(name string, elapsed time.Duration) {
  downloadStages[name] = elapsed.Milliseconds()
 })
 trace.WithRegion(ctx, "native-zmodem:download", func() {
  err = peer.manager.runNativeTerminalExperiment(ctx, peer.ref, sidecar, "download", destination, remoteSource)
 })
 cancel()
 elapsed = time.Since(started)
 if err == nil { err = nativeStressCompareFile(filepath.Join(destination, "source-"+name), expected) }
 downloadSnapshot := downloadMeter.snapshot()
 report.add(profile, "native", "download", round, int64(size), elapsed, err,
  nativeStressSample{StagesMS: downloadStages, IO: &downloadSnapshot})
 if err != nil { return fmt.Errorf("native download: %w", err) }

 if !sftpBaseline { return nil }
 baselineRemote := path.Join(peer.home, "sftp-"+name)
 peer.remoteFiles = append(peer.remoteFiles, baselineRemote)
 started = time.Now()
 upload, err := peer.sftp.Create(baselineRemote)
 if err != nil { report.add(profile, "sftp", "upload", round, int64(size), time.Since(started), err); return err }
 local, err = os.Open(source)
 if err != nil { _ = upload.Close(); return err }
 _, copyErr = io.Copy(upload, local)
 closeLocalErr = local.Close()
 closeRemoteErr = upload.Close()
 if copyErr != nil { err = copyErr } else if closeLocalErr != nil { err = closeLocalErr } else { err = closeRemoteErr }
 elapsed = time.Since(started)
 if err == nil { err = nativeStressCompareSFTP(peer.sftp, baselineRemote, expected) }
 report.add(profile, "sftp", "upload", round, int64(size), elapsed, err)
 if err != nil { return fmt.Errorf("SFTP upload baseline: %w", err) }

 started = time.Now()
 download, err := peer.sftp.Open(baselineRemote)
 if err != nil { report.add(profile, "sftp", "download", round, int64(size), time.Since(started), err); return err }
 target, err := os.CreateTemp(peer.localDir, "sftp-download-")
 if err != nil { _ = download.Close(); return err }
 _, copyErr = io.Copy(target, download)
 closeLocalErr = target.Close()
 closeRemoteErr = download.Close()
 if copyErr != nil { err = copyErr } else if closeLocalErr != nil { err = closeLocalErr } else { err = closeRemoteErr }
 elapsed = time.Since(started)
 if err == nil { err = nativeStressCompareFile(target.Name(), expected) }
 report.add(profile, "sftp", "download", round, int64(size), elapsed, err)
 if err != nil { return fmt.Errorf("SFTP download baseline: %w", err) }
 return nil
}

func TestNativeZmodemStressFixturesDeterministic(t *testing.T) {
 file := filepath.Join(t.TempDir(), "fixture.bin")
 expected, err := makeNativeStressFile(file, 1024*1024+37)
 if err != nil { t.Fatal(err) }
 if err := nativeStressCompareFile(file, expected); err != nil { t.Fatal(err) }
 info, err := os.Stat(file)
 if err != nil || info.Size() != 1024*1024+37 { t.Fatalf("unexpected file size: %v %v", info, err) }
 if _, err := makeNativeStressFile(file, 123); !errors.Is(err, os.ErrExist) {
  t.Fatalf("stress generator overwrote an existing file: %v", err)
 }
}

func TestNativeZmodemStressMetricsConcurrent(t *testing.T) {
 report := &nativeStressReport{}
 var group sync.WaitGroup
 for i := 0; i < 5; i++ {
  group.Add(1)
  go func(attempt int) {
   defer group.Done()
   report.add("parallel", "native", "upload", attempt, 1024*1024, time.Second, nil)
  }(i)
 }
 group.Wait()
 if len(report.Results) != 5 { t.Fatalf("lost metrics: %d", len(report.Results)) }
 seen := map[int]bool{}
 for _, item := range report.Results {
  if !item.ChecksumOK || item.MiBPerSecond != 1 || seen[item.Attempt] {
   t.Fatalf("invalid metric: %+v", item)
  }
  seen[item.Attempt] = true
 }
}

func TestNativeZmodemStageObserverOptIn(t *testing.T) {
    ctx := context.Background()
    observeNativeZmodemStage(ctx, "prepare", time.Now().Add(-time.Millisecond))
    var recordedName string
    var recorded time.Duration
    ctx = withNativeZmodemStageObserver(ctx, func(name string, elapsed time.Duration) {
        recordedName, recorded = name, elapsed
    })
    observeNativeZmodemStage(ctx, "prepare", time.Now().Add(-time.Millisecond))
    if recordedName != "prepare" || recorded < time.Millisecond {
        t.Fatalf("missing opt-in stage marker: %s %s", recordedName, recorded)
    }
    report := &nativeStressReport{}
    stages := map[string]int64{"protocol": 123}
    report.add("latency", "native", "upload", 0, 1024, time.Second, nil, nativeStressSample{StagesMS: stages})
    stages["protocol"] = 999
    if got := report.Results[0].StagesMS["protocol"]; got != 123 {
        t.Fatalf("stage snapshots must be immutable after recording: %d", got)
    }
}
