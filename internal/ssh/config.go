package sshclient

import (
 "bufio"
 "errors"
 "fmt"
 "os"
 "path/filepath"
 "strconv"
 "strings"
)

// SSHConfig holds the OpenSSH directives currently understood by OpenShell.
// Unknown directives are deliberately ignored rather than being treated as shell commands.
type SSHConfig struct {
 HostName string
 User string
 Port int
 IdentityFile string
 ProxyJump string
}

// ReadOpenSSHConfig resolves a host alias using ~/.ssh/config. Values follow
// OpenSSH's first-matching-value-wins rule. It does not execute Match exec or ProxyCommand.
func ReadOpenSSHConfig(alias string) (SSHConfig, error) {
 home, err := os.UserHomeDir()
 if err != nil { return SSHConfig{}, err }
 return readOpenSSHConfig(filepath.Join(home, ".ssh", "config"), alias)
}

func readOpenSSHConfig(path, alias string) (SSHConfig, error) {
 lines, err := expandConfigFile(path, 0, map[string]bool{})
 if errors.Is(err, os.ErrNotExist) { return SSHConfig{}, nil }
 if err != nil { return SSHConfig{}, err }
 var cfg SSHConfig
 matches := true // Directives before the first Host apply to all hosts.
 used := map[string]bool{}
 for _, line := range lines {
  key, value := configDirective(line)
  switch strings.ToLower(key) {
  case "host":
   matches = matchHostPatterns(strings.Fields(value), alias)
   continue
  case "match":
   // Do not apply conditional Match blocks we cannot evaluate safely.
   matches = false
   continue
  }
  if !matches { continue }
  k := strings.ToLower(key)
  if used[k] { continue }
  switch k {
  case "hostname":
   cfg.HostName = expandHostTokens(value, alias)
  case "user":
   cfg.User = value
  case "port":
   port, e := strconv.Atoi(value)
   if e != nil || port < 1 || port > 65535 { return cfg, fmt.Errorf("invalid SSH config port %q", value) }
   cfg.Port = port
  case "identityfile":
   cfg.IdentityFile = value
  case "proxyjump":
   cfg.ProxyJump = value
  default:
   continue
  }
  used[k] = true
 }
 return cfg, nil
}

func configDirective(line string) (string, string) {
 line = strings.TrimSpace(line)
 if line == "" || strings.HasPrefix(line, "#") { return "", "" }
 pos := strings.IndexAny(line, " \t=")
 if pos < 0 { return line, "" }
 key := line[:pos]
 value := strings.TrimSpace(strings.TrimLeft(line[pos:], " \t="))
 // Support common quoted values and comments, but never interpolate commands.
 if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
  value = value[1:len(value)-1]
 } else if i := strings.Index(value, " #"); i >= 0 {
  value = strings.TrimSpace(value[:i])
 }
 return key, value
}

func expandConfigFile(path string, depth int, active map[string]bool) ([]string, error) {
 // OpenSSH resolves relative Include patterns against the user's ~/.ssh
 // directory, including when an included config contains another Include.
 baseDir, err := filepath.Abs(filepath.Dir(path))
 if err != nil { return nil, err }
 return expandConfigFileWithBase(path, baseDir, depth, active)
}

func expandConfigFileWithBase(path, baseDir string, depth int, active map[string]bool) ([]string, error) {
 if depth >= 8 { return nil, fmt.Errorf("SSH config Include nesting exceeds 8 levels") }
 abs, err := filepath.Abs(path)
 if err != nil { return nil, err }
 if active[abs] { return nil, fmt.Errorf("SSH config Include cycle at %s", abs) }
 f, err := os.Open(abs)
 if err != nil { return nil, err }
 defer f.Close()
 active[abs] = true
 defer delete(active, abs)
 scanner := bufio.NewScanner(f)
 scanner.Buffer(make([]byte, 4096), 1024*1024)
 var lines []string
 for scanner.Scan() {
  line := scanner.Text()
  key, value := configDirective(line)
  if !strings.EqualFold(key, "Include") {
   lines = append(lines, line)
   continue
  }
  // Include is expanded in place, preserving Host section scope.
  for _, pattern := range strings.Fields(value) {
   pattern = expandUserPath(pattern)
   if !filepath.IsAbs(pattern) { pattern = filepath.Join(baseDir, pattern) }
   paths, err := filepath.Glob(pattern)
   if err != nil { return nil, err }
   for _, include := range paths {
    child, err := expandConfigFileWithBase(include, baseDir, depth+1, active)
    if err != nil { return nil, err }
    lines = append(lines, child...)
   }
  }
 }
 if err := scanner.Err(); err != nil { return nil, err }
 return lines, nil
}

func matchHostPatterns(patterns []string, alias string) bool {
 positive := false
 for _, pattern := range patterns {
  negative := strings.HasPrefix(pattern, "!")
  pattern = strings.TrimPrefix(pattern, "!")
  matched, err := filepath.Match(strings.ToLower(pattern), strings.ToLower(alias))
  if err != nil { continue }
  if matched && negative { return false }
  if matched { positive = true }
 }
 return positive
}

func expandUserPath(path string) string {
 if path != "~" && !strings.HasPrefix(path, "~/") && !strings.HasPrefix(path, "~\\") { return path }
 home, err := os.UserHomeDir()
 if err != nil { return path }
 if path == "~" { return home }
 return filepath.Join(home, path[2:])
}

func expandHostTokens(value, alias string) string {
 return strings.NewReplacer("%%", "%", "%h", alias).Replace(value)
}

// OpenSSH allows connection tokens in IdentityFile and ProxyJump. Expand
// them after HostName/User/Port have been resolved, not while parsing.
func expandConnectionTokens(value, originalHost, remoteHost, remoteUser string, port int) string {
 home, err := os.UserHomeDir()
 if err != nil { home = "" }
 return strings.NewReplacer(
  "%%", "%",
  "%n", originalHost,
  "%h", remoteHost,
  "%r", remoteUser,
  "%p", strconv.Itoa(port),
  "%d", home,
 ).Replace(value)
}

// ApplySSHConfig keeps saved sessions unchanged and resolves only at dial time.
func ApplySSHConfig(sHost, sUser string, sPort int, privateKeyPath, jump string, cfg SSHConfig) (string, string, int, string, string) {
 originalHost := sHost
 if cfg.HostName != "" { sHost = cfg.HostName }
 if cfg.User != "" { sUser = cfg.User }
 if cfg.Port != 0 { sPort = cfg.Port }
 if privateKeyPath == "" && cfg.IdentityFile != "" {
  privateKeyPath = expandUserPath(expandConnectionTokens(cfg.IdentityFile, originalHost, sHost, sUser, sPort))
 }
 if jump == "" && cfg.ProxyJump != "" {
  jump = expandConnectionTokens(cfg.ProxyJump, originalHost, sHost, sUser, sPort)
 }
 return sHost, sUser, sPort, privateKeyPath, jump
}
