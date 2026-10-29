//! Standalone DirectWrite preflight for GUI launch failures on Windows.
//! Run "openshell-native.exe --diagnose" from PowerShell; this path does NOT
//! create a GPUI window or connect to an SSH host.
//! All output is machine capability information, never credentials.

use std::{fmt::Write as _, fs, path::PathBuf};

pub fn report_path() -> PathBuf {
    std::env::temp_dir().join("openshell-native-directwrite-diagnostic.txt")
}

pub fn run() -> String {
    let mut report = String::from(
        "OpenShell Native 2.0 Windows startup diagnostic\n\
         GPUI window NOT started; no SSH connection attempted.\n",
    );
    let _ = writeln!(report, "Target OS: {}", std::env::consts::OS);
    let _ = writeln!(report, "Architecture: {}", std::env::consts::ARCH);

    #[cfg(windows)]
    probe_directwrite(&mut report);
    #[cfg(not(windows))]
    report.push_str("DirectWrite is only supported on Windows.\n");

    let path = report_path();
    match fs::write(&path, &report) {
        Ok(()) => {
            let _ = writeln!(report, "Report saved to: {}", path.display());
        }
        Err(err) => {
            let _ = writeln!(report, "Cannot write diagnostic file: {err}");
        }
    }
    report
}

#[cfg(windows)]
fn probe_directwrite(report: &mut String) {
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, DWRITE_FACTORY_TYPE_SHARED, IDWriteFactory5,
    };
    let factory: IDWriteFactory5 = match unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) } {
        Ok(factory) => {
            report.push_str("DirectWrite IDWriteFactory5: OK\n");
            factory
        }
        Err(err) => {
            let _ = writeln!(
                report, "DirectWrite IDWriteFactory5: FAILED ({err}, HRESULT={:#010X})",
                err.code().0 as u32,
            );
            return;
        }
    };

    // The following steps mirror GPUI's DirectWriteTextSystem initialization.
    let loader = match unsafe { factory.CreateInMemoryFontFileLoader() } {
        Ok(loader) => {
            report.push_str("CreateInMemoryFontFileLoader: OK\n");
            loader
        }
        Err(err) => {
            let _ = writeln!(report, "CreateInMemoryFontFileLoader: FAILED ({err})");
            return;
        }
    };
    if let Err(err) = unsafe { factory.RegisterFontFileLoader(&loader) } {
        let _ = writeln!(report, "RegisterFontFileLoader: FAILED ({err})");
        return;
    }
    report.push_str("RegisterFontFileLoader: OK\n");

    let checks = (|| -> windows::core::Result<()> {
        let builder = unsafe { factory.CreateFontSetBuilder()? };
        report.push_str("CreateFontSetBuilder: OK\n");

        let mut collection = None;
        unsafe { factory.GetSystemFontCollection(false, &mut collection, true)?; }
        let collection = collection.ok_or_else(|| {
            windows::core::Error::from_hresult(windows::core::HRESULT(0x80004005u32 as i32))
        })?;
        let _ = writeln!(report, "System font collection: OK ({} families)", unsafe {
            collection.GetFontFamilyCount()
        });

        let custom_set = unsafe { builder.CreateFontSet()? };
        report.push_str("CreateFontSet: OK\n");
        let _custom_collection = unsafe {
            factory.CreateFontCollectionFromFontSet(&custom_set)?
        };
        report.push_str("CreateFontCollectionFromFontSet: OK\n");
        Ok(())
    })();

    if let Err(err) = checks {
        let _ = writeln!(
            report, "DirectWrite initialization probe: FAILED ({err}, HRESULT={:#010X})",
            err.code().0 as u32,
        );
    }
    if let Err(err) = unsafe { factory.UnregisterFontFileLoader(&loader) } {
        let _ = writeln!(report, "UnregisterFontFileLoader: FAILED ({err})");
    }

    if checks.is_ok() {
        report.push_str(
            "DirectWrite factory/font APIs: ALL PASSED\n\
             GPUI can still fail later while creating its Direct3D text shaders.\n\
             Check GPU drivers, DirectX 11 feature levels and the full GPUI failure log.\n",
        );
    }
}
