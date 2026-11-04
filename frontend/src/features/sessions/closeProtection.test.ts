import { describe, expect, it } from "vitest";
import type { Tab } from "../../types";
import { hasInterruptibleWork, isActiveRemoteSession, needsCloseConfirmation, sessionLabel } from "./closeProtection";

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
  it("closes untouched connecting and connected tabs without a prompt", () => {
    for (const status of ["connecting", "connected", "reconnecting"] as const)
      expect(needsCloseConfirmation(sample(status), () => false)).toBe(false);
  });
  it("protects input, quick commands and alternate-screen programs", () => {
    expect(needsCloseConfirmation({ ...sample("connected"), hasUserInput: true }, () => false)).toBe(true);
    expect(needsCloseConfirmation({ ...sample("connected"), hasExecutedAction: true }, () => false)).toBe(true);
    expect(needsCloseConfirmation(sample("connected"), () => false, false, true)).toBe(true);
    expect(needsCloseConfirmation({ ...sample("disconnected"), hasUserInput: true }, () => false)).toBe(false);
  });
  it("protects transfers and running AI without terminal input", () => {
    expect(needsCloseConfirmation(sample("connected"), () => true)).toBe(true);
    expect(needsCloseConfirmation(sample("connected"), () => false, true)).toBe(true);
  });
  it("renders distinguishable session labels", () => {
    expect(sessionLabel(sample("connected"))).toBe("US · root@example.test:22");
  });
});
