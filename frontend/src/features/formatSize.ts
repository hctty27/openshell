const units = ["KB", "MB", "GB", "TB"];

/**
 * Formats a byte count the same way everywhere (SFTP panel, ZMODEM picker,
 * transfer center): whole bytes below 1 KiB, one decimal below 10 units and
 * whole units above, e.g. "512 B", "1.5 KB", "1.0 GB", "23 MB".
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  let value = bytes;
  let index = -1;
  do {
    value /= 1024;
    index++;
  } while (value >= 1024 && index < units.length - 1);
  // Rounding 9.96 to one decimal would print "10.0"; switch to whole units.
  const digits = value < 9.95 ? 1 : 0;
  if (digits === 0 && Math.round(value) >= 1024 && index < units.length - 1) {
    return `1.0 ${units[index + 1]}`;
  }
  return `${value.toFixed(digits)} ${units[index]}`;
}
