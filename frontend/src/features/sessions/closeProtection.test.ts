import { describe, expect, it } from "vitest";
import type { Tab } from "../../types";
import { hasInterruptibleWork, isActiveRemoteSession, sessionLabel } from "./closeProtection";

const sample = (status: Tab["status"]): Tab => ({
  id:"t", status, ref:null,  error:null,
  home:"", cwd:"",
  session:{id:"s",name:"US",host:"example.test",port:22,username:"root",
    groupId:"",authType:"key",privateKeyPath:"",credentialRef:""},
});

describe("closeProtection", () => {
  it("prompts for connected, connecting, and reconnecting tabs", () => {
    for (const status of ["connected","connecting","reconnecting"] as const)
      expect(isActiveRemoteSession(sample(status))).toBe(true);
    expect(isActiveRemoteSession(sample("disconnected"))).toBe(false);
    expect(isActiveRemoteSession(sample("error"))).toBe(false);
  });
  it("counts active file transfers without AI task state", () => {
    const tab = sample("disconnected");
    expect(hasInterruptibleWork(tab, () => false)).toBe(false);
    expect(hasInterruptibleWork(tab, () => true)).toBe(true);
  });
  it("renders distinguishable session labels", () => {
    expect(sessionLabel(sample("connected"))).toBe("US · root@example.test:22");
  });
});
