# SSH advanced connectivity (phase 2)

These features extend the existing SSH transport. They are configured per saved session, and are **not** a replacement for host-key verification.

## OpenSSH host aliases

Enable **Use ~/.ssh/config** in the session editor and enter the `Host` alias in the Host field.

Supported config directives: `Host` patterns (including negation), `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, and local `Include` globs (maximum depth 8). Files are evaluated in order; the first matching value wins, as in OpenSSH. Existing session values are not overwritten in storage. SSH configuration is read again on reconnect.

Not supported: `ProxyCommand`, conditional `Match` blocks, `CertificateFile`, certificate authentication, `CanonicalizeHostname`, and all other OpenSSH directives. Unsupported directives are ignored; neither `ProxyCommand` nor `Match exec` is executed by OpenShell. Do not assume arbitrary OpenSSH config semantics are faithfully reproduced.

## SSH Agent

Select **SSH Agent** as the authentication method. OpenShell asks the existing agent for signers; the agent performs signing without exposing private key bytes.

- Windows: OpenSSH Authentication Agent service, normally `\\.\pipe\openssh-ssh-agent` (or `SSH_AUTH_SOCK`, when defined).
- Linux/macOS: `SSH_AUTH_SOCK` Unix socket.
- The service must already be running and have an applicable identity loaded; OpenShell does not unlock/load keys for you.
- A connection through ProxyJump uses the same selected authentication method for all hops.

## ProxyJump

In the session editor, enter `user@bastion:2222` or `jump1,jump2`. A maximum of three hops is supported, with bracketed IPv6 syntax for non-default ports.

- Every hop has its **own host-key trust challenge**. Accept only fingerprints you have verified independently.
- When OpenSSH config is enabled, jump host aliases resolve `HostName`, `User` and `Port` unless overridden explicitly by the jump specification.
- No private-key material is forwarded to the intermediate SSH servers, and no `ProxyCommand` is executed.
- The selected password/private key/agent is reused for every SSH hop; separate passwords or different per-hop identity files are not yet supported.
- Closing/replacing a terminal disconnects its hop transports.

## Local port forwarding

Configure one or more entries in the session editor:

| Local listen | Remote destination |
|---|---|
| `127.0.0.1:8080` | `127.0.0.1:80` |
| `::1:5433` | `database.internal:5432` |

Forwards are bound when the SSH connection is established; a bind error fails that connection and leaves no stale listeners. No more than **8** forwards are accepted. The bind address must be loopback (`127.0.0.1`, `::1` or `localhost`); exposing listeners on public interfaces is intentionally disallowed.

The destination is opened by the **remote SSH server** through an SSH `direct-tcpip` channel. Remote policy (`AllowTcpForwarding` and `PermitOpen`) still applies. Disconnecting the tab, replacing its connection, or a transport failure closes all its port listeners and live sockets.

Remote (-R), dynamic SOCKS (-D), Unix socket, agent forwarding (-A), and tunnel-on-demand are not included in this iteration.

## Acceptance checklist

- [ ] Windows 10/11: password, private key and OpenSSH Agent logins.
- [ ] Host alias with Include, User, Port, IdentityFile, ProxyJump; reconnect re-reads config.
- [ ] Single-hop and multi-hop connections; first-use and changed-key challenge on **every** hop.
- [ ] Agent unavailable, empty agent and wrong key fail with actionable error.
- [ ] Local forwarding to a reachable service, invalid destination, occupied local port.
- [ ] Concurrent tabs, local forward same port collision, tab reconnect and shutdown cleanup.
- [ ] 30-minute disconnect/reconnect stress under network interruptions.
- [ ] `go test -race ./...`, `go vet ./...`, frontend tests, Windows smoke workflow.

CI cannot replace the Windows named-pipe agent and real bastion SSH environment tests.
