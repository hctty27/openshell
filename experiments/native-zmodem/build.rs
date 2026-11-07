use std::env;

fn windows_version(version: &str) -> Result<u64, Box<dyn std::error::Error>> {
    let parts: Vec<u16> = version
        .split('.')
        .map(str::parse::<u16>)
        .collect::<Result<_, _>>()?;
    if parts.len() != 3 && parts.len() != 4 {
        return Err("OPENSHELL_APP_VERSION must be a major.minor.patch version".into());
    }

    Ok(((parts[0] as u64) << 48)
        | ((parts[1] as u64) << 32)
        | ((parts[2] as u64) << 16)
        | (parts.get(3).copied().unwrap_or(0) as u64))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-env-changed=OPENSHELL_APP_VERSION");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return Ok(());
    }

    let version = env::var("OPENSHELL_APP_VERSION").unwrap_or_else(|_| "0.0.0".to_owned());
    let number = windows_version(&version)?;
    let mut resource = winres::WindowsResource::new();
    resource
        .set("ProductName", "OpenShell")
        .set("ProductVersion", &version)
        .set("FileVersion", &version)
        .set("FileDescription", "OpenShell native ZMODEM sidecar")
        .set("CompanyName", "Cheng")
        .set("OriginalFilename", "zmodem-sidecar.exe")
        .set_version_info(winres::VersionInfo::FILEVERSION, number)
        .set_version_info(winres::VersionInfo::PRODUCTVERSION, number);
    resource.compile()?;
    Ok(())
}
