import { expect, test } from "vitest";
import { CONTENT_SECURITY_POLICY, contentSecurityPolicy } from "../csp";

test("the packaged app forbids inline and eval'd scripts and foreign connections", () => {
  const directives = Object.fromEntries(CONTENT_SECURITY_POLICY.split("; ").map(part => {
    const [name, ...values] = part.split(" ");
    return [name, values];
  }));
  expect(directives["script-src"]).toEqual(["'self'"]);
  expect(directives["connect-src"]).toEqual(["'self'"]);
  expect(directives["object-src"]).toEqual(["'none'"]);
  expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
  // Only production builds get the meta tag; the dev server needs inline
  // scripts for React Fast Refresh.
  expect(contentSecurityPolicy().apply).toBe("build");
});
