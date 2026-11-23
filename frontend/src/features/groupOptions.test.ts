import { expect, test } from "vitest";
import { groupOptions } from "./groupOptions";

test("folders list parents before their children", () => {
  const options = groupOptions([
    { id: "web", name: "web", parentId: "prod" },
    { id: "test", name: "测试环境" },
    { id: "prod", name: "生产环境" },
    { id: "db", name: "db", parentId: "prod" },
    { id: "orphan", name: "orphan", parentId: "gone" },
    { id: "a", name: "a", parentId: "b" },
    { id: "b", name: "b", parentId: "a" },
  ]);
  const labels = options.map((option) => option.label);
  expect(labels.indexOf("生产环境")).toBeLessThan(labels.indexOf("生产环境 / web"));
  expect(labels.indexOf("生产环境 / db")).toBeLessThan(labels.indexOf("生产环境 / web"));
  expect(labels).toContain("orphan");
  expect(labels).toHaveLength(7);
});
