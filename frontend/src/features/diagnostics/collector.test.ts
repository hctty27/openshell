import { describe, expect, it } from "vitest";
import { isTrackedBackendOperation } from "./collector";

describe("diagnostic RPC allowlist", () => {
  it("tracks slow user operations", () => {
    expect(isTrackedBackendOperation("Connect")).toBe(true);
    expect(isTrackedBackendOperation("SFTPList")).toBe(true);
    expect(isTrackedBackendOperation("AIStart")).toBe(true);
  });

  it("does not wrap hot terminal data/ACK paths or diagnostic calls", () => {
    expect(isTrackedBackendOperation("WriteTerminal")).toBe(false);
    expect(isTrackedBackendOperation("AcknowledgeTerminalOutput")).toBe(false);
    expect(isTrackedBackendOperation("DiagnosticsRecordBatch")).toBe(false);
    expect(isTrackedBackendOperation("SFTPTransfers")).toBe(false);
  });
});
