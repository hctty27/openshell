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
//!
//! This is not the production session manager UI.

use std::{env, error::Error, io::{self, Write}, process};

use openshell_core::{
    CredentialVault, HostIdentity, HostTrustStore, Session, SessionStore,
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
        return Err("expected: list|add|trust|password|delete (use -- separator in cargo run)".into());
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
        "delete" if args.len() == 2 => {
            // Remove the credential *before* deleting its metadata, so failure
            // cannot orphan a secret through normal CLI operation.
            CredentialVault::delete(&args[1])?;
            if sessions.delete(&args[1])? {
                println!("Removed session metadata and its native credential entry.");
            } else {
                println!("No session with that ID.");
            }
            // Host-key trust is host:port scoped and intentionally NOT cleared
            // by deleting an individual account.
        }
        _ => {
            return Err("usage: list | add <id> <name> <host> <port> <user> | trust <id> <SHA256:...> | password <id> | delete <id>".into());
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
