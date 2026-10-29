//! Development-only CLI for creating native SSH sessions and explicitly
//! approving host-key fingerprints. No secrets appear in command arguments.
//!
//! Usage: cargo run -p openshell-core --example sessionctl -- <command>
//!
//! Commands:
//!   list
//!   add <id> <display-name> <host> <port> <username>
//!   trust <id> <independently-verified-SHA256-fingerprint>
//!   password <id>                   (interactive, no terminal echo)
//!   delete <id>
//!   key <id> <unencrypted-private-key-file>
//!   key-clear <id>
//!   import-legacy <absolute-path-to-Wails-state.db> (metadata only)
//!
//! This is not the production session manager UI.

use std::{env, error::Error, io::{self, Write}, path::PathBuf, process, time::{SystemTime, UNIX_EPOCH}};

use openshell_core::{
    CredentialVault, HostIdentity, HostTrustStore, Session, SessionStore, SessionKeyStore,
    import_legacy_sessions,
    native_paths::{ensure_native_data_directory, native_database_path},
};
use zeroize::Zeroizing;

fn session_by_id(store: &SessionStore, id: &str) -> Result<Session, Box<dyn Error>> {
    store.list()?.into_iter()
        .find(|session| session.id == id)
        .ok_or_else(|| format!("no saved session with ID {id:?}").into())
}

fn command() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        return Err("expected: list|add|trust|password|key|key-clear|delete|import-legacy (use -- separator in cargo run)".into());
    }
    ensure_native_data_directory()?;
    let database = native_database_path()?;
    let sessions = SessionStore::open(&database)?;
    let trusted = HostTrustStore::open(&database)?;

    match args[0].as_str() {
        "list" if args.len() == 1 => {
            for session in sessions.list()? {
                let identity = HostIdentity::new(&session.host, session.port)?;
                let fingerprint = trusted.trusted_fingerprint(&identity)?;
                println!(
                    "{} | {} | {}@{}:{} | host key {}",
                    session.id, session.name, session.username,
                    session.host, session.port,
                    if fingerprint.is_some() { "trusted" } else { "unapproved" },
                );
            }
        }
        "add" if args.len() == 6 => {
            let session = Session {
                id: args[1].clone(),
                name: args[2].clone(),
                host: args[3].clone(),
                port: args[4].parse()?,
                username: args[5].clone(),
            };
            session.validate()?;
            HostIdentity::new(&session.host, session.port)?;
            sessions.save(&session)?;
            println!("Saved session metadata: {} (no password stored in SQLite)", session.id);
        }
        "trust" if args.len() == 3 => {
            let session = session_by_id(&sessions, &args[1])?;
            let identity = HostIdentity::new(&session.host, session.port)?;
            let fingerprint = &args[2];
            println!("Host: {}:{}", identity.host, identity.port);
            println!("SHA256 host-key fingerprint: {fingerprint}");
            println!("Independently verify against the host administrator or local server host key.");
            if let Some(old) = trusted.trusted_fingerprint(&identity)? {
                println!("Previously trusted fingerprint: {old}");
                if old != *fingerprint {
                    println!("WARNING: this is a host-key change; verify out-of-band!");
                }
            }
            print!("After independent verification, type TRUST to approve this exact key: ");
            io::stdout().flush()?;
            let mut confirmation = String::new();
            io::stdin().read_line(&mut confirmation)?;
            if confirmation.trim_end() != "TRUST" {
                return Err("not approved; stored fingerprint unchanged".into());
            }
            trusted.record_user_approved(&identity, fingerprint)?;
            println!("Fingerprint approved for {}:{}", identity.host, identity.port);
        }
        "password" if args.len() == 2 => {
            let session = session_by_id(&sessions, &args[1])?;
            let password = Zeroizing::new(rpassword::prompt_password(
                format!("Password for {}@{} (hidden): ", session.username, session.host)
            )?);
            if password.is_empty() { return Err("empty passwords are not accepted".into()); }
            CredentialVault::put(&session.id, &password)?;
            println!("Password stored in Windows Credential Manager.");
        }
        "import-legacy" if args.len() == 2 => {
            let source = PathBuf::from(&args[1]);
            let backup_dir = ensure_native_data_directory()?.join("migration-backups");
            std::fs::create_dir_all(&backup_dir)?;
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
            let backup = backup_dir.join(format!("legacy-{stamp}-{}.db", process::id()));
            let report = import_legacy_sessions(&source, &backup, &sessions)?;
            println!(
                "Legacy metadata import: {} added, {} existing, {} invalid.",
                report.imported, report.existing, report.invalid,
            );
            println!("Read-only source preserved; SQLite snapshot: {}", report.backup_path.display());
            println!("Passwords, key paths, agent configuration, groups and API tokens were NOT imported.");
            println!("Set credentials and independently approve host keys in the native client.");
        }
        "key" if args.len() == 3 => {
            let session = session_by_id(&sessions, &args[1])?;
            let keys = SessionKeyStore::open(&database)?;
            let path = keys.set(&session.id, &args[2])?;
            println!("Private-key login enabled for {} using {}", session.id, path.display());
            println!("Only the file path is saved. The key contents stay on disk.");
            println!("Encrypted private keys and SSH Agent authentication are not supported yet.");
        }
        "key-clear" if args.len() == 2 => {
            let session = session_by_id(&sessions, &args[1])?;
            SessionKeyStore::open(&database)?.clear(&session.id)?;
            println!("Private-key preference removed; the next login uses the Windows credential password.");
        }
        "delete" if args.len() == 2 => {
            // Remove the credential *before* deleting its metadata, so failure
            // cannot orphan a secret through normal CLI operation.
            CredentialVault::delete(&args[1])?;
            SessionKeyStore::open(&database)?.clear(&args[1])?;
            if sessions.delete(&args[1])? {
                println!("Removed session metadata and its native credential entry.");
            } else {
                println!("No session with that ID.");
            }
            // Host-key trust is host:port scoped and intentionally NOT cleared
            // by deleting an individual account.
        }
        _ => {
            return Err("usage: list | add <id> <name> <host> <port> <user> | trust <id> <SHA256:...> | password <id> | key <id> <private-key-path> | key-clear <id> | delete <id> | import-legacy <path-to-state.db>".into());
        }
    }
    Ok(())
}

fn main() {
    if let Err(error) = command() {
        // Never include a password or secret in error paths.
        eprintln!("OpenShell native session setup error: {error}");
        process::exit(1);
    }
}
