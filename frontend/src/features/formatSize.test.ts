import { expect, test } from "vitest";
import { formatSize } from "./formatSize";

test("sizes use one precision rule everywhere", () => {
  expect(formatSize(0)).toBe("0 B");
  expect(formatSize(1023)).toBe("1023 B");
  expect(formatSize(1536)).toBe("1.5 KB");
  expect(formatSize(23 * 1048576)).toBe("23 MB");
  expect(formatSize(1073741824)).toBe("1.0 GB");
  expect(formatSize(1048575 * 1024)).toBe("1.0 GB");
  expect(formatSize(9.97 * 1024)).toBe("10 KB");
  expect(formatSize(5 * 1024 ** 4)).toBe("5.0 TB");
});
