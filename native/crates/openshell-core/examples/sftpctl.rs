//! Development SFTP CLI using the same native saved sessions, verified host
//! keys, and Windows credential manager as the desktop client.
//!
//! cargo run -p openshell-core --example sftpctl -- list <id> [remote-dir]
//! cargo run -p openshell-core --example sftpctl -- upload <id> <local-file> <remote-file>
//! cargo run -p openshell-core --example sftpctl -- download <id> <remote-file> <local-file>

use std::{env, error::Error};

use openshell_core::{
    CredentialVault, HostIdentity, HostTrustStore, NativeSftp, SessionKeyStore,
    SessionStore, SshConnection,
    native_paths::native_database_path,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() < 2 {
        return Err("usage: list <id> [dir] | upload <id> <local> <remote> | download <id> <remote> <local>".into());
    }
    let database = native_database_path()?;
    let store = SessionStore::open(&database)?;
    let session = store.list()?.into_iter()
        .find(|session| session.id == args[1])
        .ok_or("unknown saved SSH session")?;
    let identity = HostIdentity::new(&session.host, session.port)?;
    let expected = HostTrustStore::open(&database)?
        .trusted_fingerprint(&identity)?
        .ok_or("unapproved SSH host fingerprint")?;
    let connection = match SessionKeyStore::open(&database)?.get(&session.id)? {
        Some(key) => SshConnection::connect_private_key(&session, &key, &expected).await?,
        None => {
            let password = CredentialVault::get(&session.id)?
                .ok_or("SSH password is missing from Windows Credential Manager")?;
            SshConnection::connect_password(&session, &password, &expected).await?
        }
    };
    let client = NativeSftp::open(connection).await?;
    match (args[0].as_str(), args.len()) {
        ("list", 2) | ("list", 3) => {
            let directory = args.get(2).map(String::as_str).unwrap_or(".");
            let absolute = client.session_path(directory).await?;
            println!("Remote directory: {absolute}");
            for entry in client.list(directory).await? {
                println!("{entry}");
            }
        }
        ("upload", 4) => {
            let bytes = client.upload(&args[2], &args[3]).await?;
            println!("Uploaded {bytes} bytes (no-overwrite)");
        }
        ("download", 4) => {
            let bytes = client.download(&args[2], &args[3]).await?;
            println!("Downloaded {bytes} bytes (no-overwrite)");
        }
        _ => return Err("invalid SFTP command or argument count".into()),
    }
    client.close().await?;
    Ok(())
}
