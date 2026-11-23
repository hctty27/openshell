import { expect, test } from "vitest";
import { insecureAIBaseUrl } from "./AIProviderSettings";

test("warns only for plain HTTP to a non-local AI endpoint", () => {
  expect(insecureAIBaseUrl("http://api.example.com/v1")).toBe(true);
  expect(insecureAIBaseUrl("http://10.0.0.5:8000/v1")).toBe(true);
  expect(insecureAIBaseUrl("https://api.example.com/v1")).toBe(false);
  expect(insecureAIBaseUrl("http://localhost:11434/v1")).toBe(false);
  expect(insecureAIBaseUrl("http://127.0.0.1:8080/v1")).toBe(false);
  expect(insecureAIBaseUrl("http://[::1]:8080/v1")).toBe(false);
  expect(insecureAIBaseUrl("not a url")).toBe(false);
});
