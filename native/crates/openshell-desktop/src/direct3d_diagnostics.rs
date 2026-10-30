//! Read-only DXGI/Direct3D11 preflight for Windows machines where GPUI's
//! DirectWrite font APIs pass but the GPU-backed text system does not start.
//! No display adapters or drivers are modified by this diagnostic.

use std::fmt::Write as _;

pub(crate) fn append(report: &mut String) {
    #[cfg(windows)]
    probe_windows(report);
    #[cfg(not(windows))]
    report.push_str("DXGI/Direct3D11 is only available on Windows.\n");
}

#[cfg(windows)]
fn probe_windows(report: &mut String) {
    use windows::{
        core::Interface as _,
        Win32::{
            Foundation::HMODULE,
            Graphics::{
                Direct3D::{
                    D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_10_1,
                    D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
                },
                Direct3D11::{
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    D3D11_FEATURE_D3D10_X_HARDWARE_OPTIONS,
                    D3D11_FEATURE_DATA_D3D10_X_HARDWARE_OPTIONS,
                    D3D11_SDK_VERSION, D3D11CreateDevice, ID3D11Device,
                    ID3D11DeviceContext,
                },
                Dxgi::{CreateDXGIFactory2, DXGI_CREATE_FACTORY_FLAGS, IDXGIAdapter1, IDXGIFactory6},
            },
        },
    };

    report.push_str("\nDXGI / Direct3D 11 adapter diagnostic:\n");
    // The GPUI Windows backend enumerates DXGI adapters in this order and
    // selects the first adapter that can create the required D3D11 device.
    let factory: IDXGIFactory6 =
        match unsafe { CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS::default()) } {
            Ok(factory) => factory,
            Err(error) => {
                let _ = writeln!(report, "CreateDXGIFactory2: FAILED ({error})");
                return;
            }
        };
    report.push_str("CreateDXGIFactory2: OK\n");

    let mut selected: Option<String> = None;
    let mut adapter_count = 0;

    for index in 0..16u32 {
        let adapter: IDXGIAdapter1 = match unsafe { factory.EnumAdapters(index) } {
            Ok(adapter) => match adapter.cast() {
                Ok(adapter) => adapter,
                Err(error) => {
                    let _ = writeln!(report, "DXGI adapter #{index} cast: FAILED ({error})");
                    continue;
                }
            },
            Err(_) => break,
        };
        adapter_count += 1;
        let name = match unsafe { adapter.GetDesc1() } {
            Ok(description) => {
                String::from_utf16_lossy(&description.Description)
                    .trim_end_matches('\0')
                    .to_owned()
            }
            Err(error) => {
                let _ = writeln!(report, "DXGI adapter #{index} GetDesc1: FAILED ({error})");
                format!("Adapter #{index}")
            }
        };
        let _ = writeln!(report, "DXGI adapter #{index}: {name}");

        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        let mut level = D3D_FEATURE_LEVEL::default();
        let created = unsafe {
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[
                    D3D_FEATURE_LEVEL_11_1,
                    D3D_FEATURE_LEVEL_11_0,
                    D3D_FEATURE_LEVEL_10_1,
                ]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut level),
                Some(&mut context),
            )
        };
        match created {
            Ok(()) => {
                let _ = writeln!(report, "  D3D11CreateDevice: OK (feature level {:#X})", level.0);
            }
            Err(error) => {
                let _ = writeln!(
                    report,
                    "  D3D11CreateDevice: FAILED ({error}, HRESULT={:#010X})",
                    error.code().0 as u32,
                );
                continue;
            }
        }
        let Some(device) = device else {
            report.push_str("  D3D11CreateDevice: returned no device\n");
            continue;
        };
        let mut options = D3D11_FEATURE_DATA_D3D10_X_HARDWARE_OPTIONS::default();
        let feature_result = unsafe {
            device.CheckFeatureSupport(
                D3D11_FEATURE_D3D10_X_HARDWARE_OPTIONS,
                &mut options as *mut _ as _,
                std::mem::size_of::<D3D11_FEATURE_DATA_D3D10_X_HARDWARE_OPTIONS>() as u32,
            )
        };
        match feature_result {
            Ok(()) => {
                let supported = options
                    .ComputeShaders_Plus_RawAndStructuredBuffers_Via_Shader_4_x
                    .as_bool();
                let _ = writeln!(report, "  GPU StructuredBuffer support: {supported}");
                if supported && selected.is_none() {
                    selected = Some(name.clone());
                }
            }
            Err(error) => {
                let _ = writeln!(
                    report, "  CheckFeatureSupport: FAILED ({error}, HRESULT={:#010X})",
                    error.code().0 as u32
                );
            }
        }
    }
    let _ = writeln!(report, "DXGI adapters found: {adapter_count}");
    match selected {
        Some(name) => {
            let _ = writeln!(
                report,
                "GPUI-like adapter candidate (without optional DX debug layer): {name}"
            );
            report.push_str(
                "D3D11 device creation passed; GPUI can still fail to create its text/emoji shaders.\n",
            );
        }
        None => report.push_str(
            "No GPU adapter satisfied GPUI's basic D3D11/StructuredBuffer requirements.\n",
        ),
    }
}
