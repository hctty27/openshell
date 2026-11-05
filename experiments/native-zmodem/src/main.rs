//! Non-shipping Windows compilation probe for an OS-independent ZMODEM state machine.
//! This executable does not transfer files or replace rz/sz.

#[allow(unused_imports)]
use zmodem2::{Action, FileInfo, Receiver, Sender};

fn main() {
    println!("OpenShell ZMODEM protocol API build probe");
    println!("OS: {}", std::env::consts::OS);
    println!("Architecture: {}", std::env::consts::ARCH);
}

#[cfg(test)]
mod tests {
    #[test]
    fn uses_native_windows_binary_target() {
        assert_eq!(std::env::consts::OS, "windows");
        assert_eq!(std::env::consts::ARCH, "x86_64");
    }

    #[test]
    fn does_not_depend_on_external_zmodem_executables() {
        let manifest = include_str!("../Cargo.toml");
        assert!(manifest.contains("zmodem2 = \"=0.7.3\""));
        assert!(!manifest.contains("lrzsz"));
        assert!(!manifest.contains("msys2-runtime"));
    }
}
