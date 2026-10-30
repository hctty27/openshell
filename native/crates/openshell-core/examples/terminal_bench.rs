//! Reproducible ANSI parsing and viewport snapshot microbenchmark.
//! Run on Windows: cargo run --release -p openshell-core --example terminal_bench
//! Compare throughput on the same machine before claiming improvements.

use std::time::Instant;

use openshell_core::{TerminalEngine, TerminalSize};

fn main() {
    let mut terminal = TerminalEngine::new(TerminalSize::new(120, 40));
    let sample = b"\x1b[32m2026-10-29T08:00:00Z INFO sample log message 0123456789 abcdefghijk\x1b[0m\r\n";
    let target = 32 * 1024 * 1024;
    let mut processed = 0_usize;
    let started = Instant::now();

    while processed < target {
        terminal.feed(sample);
        processed += sample.len();
    }

    let parser_elapsed = started.elapsed();
    let render_started = Instant::now();

    let mut cells = 0;
    for _ in 0..200 {
        let grid = terminal.render_cells();
        cells += grid.iter().map(Vec::len).sum::<usize>();
    }
    let render_elapsed = render_started.elapsed();

    println!(
        "ANSI parser: {:.1} MiB in {:.3} s, {:.1} MiB/s",
        processed as f64 / 1_048_576.0,
        parser_elapsed.as_secs_f64(),
        processed as f64 / 1_048_576.0 / parser_elapsed.as_secs_f64(),
    );
    println!(
        "Viewport: {cells} cells in {:.3} s, {:.0} cells/s",
        render_elapsed.as_secs_f64(),
        cells as f64 / render_elapsed.as_secs_f64(),
    );
}
