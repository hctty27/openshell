import { describe, expect, it } from "vitest";
import type { Tab } from "../../types";
import { hasInterruptibleWork, isActiveRemoteSession, sessionLabel } from "./closeProtection";

const sample = (status: Tab["status"]): Tab => ({
  id:"t", status, ref:null, chatBusy:false, executing:false, proposal:null, error:null,
  home:"", cwd:"", messages:[],
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
  it("counts running tasks, pending proposals, and active transfers", () => {
    const tab = sample("disconnected");
    expect(hasInterruptibleWork(tab, () => false)).toBe(false);
    expect(hasInterruptibleWork({...tab, chatBusy:true}, () => false)).toBe(true);
    expect(hasInterruptibleWork({...tab, executing:true}, () => false)).toBe(true);
    expect(hasInterruptibleWork({...tab, proposal: {id:"p"} as Tab["proposal"]}, () => false)).toBe(true);
    expect(hasInterruptibleWork(tab, () => true)).toBe(true);
  });
  it("renders distinguishable session labels", () => {
    expect(sessionLabel(sample("connected"))).toBe("US · root@example.test:22");
  });
});
