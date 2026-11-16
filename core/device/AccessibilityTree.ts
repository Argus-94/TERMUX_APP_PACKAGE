export type UiBounds = { left: number; top: number; right: number; bottom: number };

export type UiNode = {
  index: number;
  text?: string;
  resourceId?: string;
  className?: string;
  contentDescription?: string;
  packageName?: string;
  clickable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  scrollable?: boolean;
  bounds?: UiBounds;
  children: UiNode[];
};

export type UiSnapshot = {
  ok: boolean;
  rawXml?: string;
  root?: UiNode;
  nodeCount: number;
  error?: string;
};

/** Parses Android uiautomator XML without adding a native/XML dependency. */
export function parseUiHierarchy(xml: string): UiSnapshot {
  const source = String(xml || "").trim();
  if (!source) return { ok: false, nodeCount: 0, error: "EMPTY_UI_HIERARCHY" };
  const tags = source.match(/<node\b[^>]*>/g) || [];
  if (!tags.length) return { ok: false, rawXml: source, nodeCount: 0, error: "NO_UI_NODES" };

  const root: UiNode = {
    index: -1,
    children: [],
  };
  const stack: Array<{ node: UiNode; depth: number }> = [{ node: root, depth: -1 }];
  let index = 0;
  for (const tag of tags) {
    const depth = (tag.match(/\bdepth="(\d+)"/)?.[1]);
    const node: UiNode = {
      index: index++,
      text: attr(tag, "text"),
      resourceId: attr(tag, "resource-id"),
      className: attr(tag, "class"),
      contentDescription: attr(tag, "content-desc"),
      packageName: attr(tag, "package"),
      clickable: boolAttr(tag, "clickable"),
      enabled: boolAttr(tag, "enabled"),
      focused: boolAttr(tag, "focused"),
      selected: boolAttr(tag, "selected"),
      scrollable: boolAttr(tag, "scrollable"),
      bounds: parseBounds(attr(tag, "bounds")),
      children: [],
    };
    const d = depth == null ? 0 : Number(depth);
    while (stack.length && stack[stack.length - 1].depth >= d) stack.pop();
    (stack[stack.length - 1]?.node ?? root).children.push(node);
    stack.push({ node, depth: d });
  }
  return { ok: true, rawXml: source, root, nodeCount: index };
}

export function flattenUiTree(root?: UiNode): UiNode[] {
  if (!root) return [];
  const out: UiNode[] = [];
  const visit = (n: UiNode) => { for (const c of n.children) { out.push(c); visit(c); } };
  visit(root);
  return out;
}

export function findUiNodes(root: UiNode | undefined, query: Partial<Pick<UiNode, "text" | "resourceId" | "className" | "contentDescription" | "packageName">>): UiNode[] {
  return flattenUiTree(root).filter((node) => Object.entries(query).every(([key, value]) => {
    if (value == null) return true;
    return String((node as any)[key] ?? "").toLowerCase().includes(String(value).toLowerCase());
  }));
}

export function nodeCenter(node: UiNode): { x: number; y: number } | undefined {
  const b = node.bounds;
  if (!b) return undefined;
  return { x: Math.round((b.left + b.right) / 2), y: Math.round((b.top + b.bottom) / 2) };
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${escapeRegExp(name)}="([^"]*)"`));
  return m ? decodeXml(m[1]) : undefined;
}
function boolAttr(tag: string, name: string): boolean | undefined {
  const value = attr(tag, name);
  return value == null ? undefined : value === "true";
}
function parseBounds(value?: string): UiBounds | undefined {
  if (!value) return undefined;
  const m = value.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  return m ? { left: +m[1], top: +m[2], right: +m[3], bottom: +m[4] } : undefined;
}
function decodeXml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
