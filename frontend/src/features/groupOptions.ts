import type { Group } from "../types";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export interface GroupOption {
  group: Group;
  /** Full path such as "Production / web". */
  label: string;
}

/**
 * Lists folders in tree order: every parent comes right before its children,
 * siblings sorted by name. Folders whose parent is missing (or that sit in a
 * parent cycle) are treated as top level so none disappear.
 */
export function groupOptions(groups: Group[]): GroupOption[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const children = new Map<string, Group[]>();
  const roots: Group[] = [];
  const reachesRoot = (group: Group): boolean => {
    const seen = new Set<string>([group.id]);
    let parent = group.parentId;
    while (parent) {
      const item = byId.get(parent);
      if (!item) return false;
      if (seen.has(parent)) return false;
      seen.add(parent);
      parent = item.parentId;
    }
    return true;
  };
  for (const group of groups) {
    const parent = group.parentId ? byId.get(group.parentId) : undefined;
    if (parent && reachesRoot(group)) {
      const list = children.get(parent.id) ?? [];
      list.push(group);
      children.set(parent.id, list);
    } else {
      roots.push(group);
    }
  }
  const sort = (items: Group[]) =>
    [...items].sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
  const result: GroupOption[] = [];
  const visit = (group: Group, prefix: string) => {
    const label = prefix ? `${prefix} / ${group.name}` : group.name;
    result.push({ group, label });
    for (const child of sort(children.get(group.id) ?? [])) visit(child, label);
  };
  for (const root of sort(roots)) visit(root, "");
  return result;
}
