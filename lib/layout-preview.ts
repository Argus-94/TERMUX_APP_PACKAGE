/**
 * Спрощений розбір Android XML layout → дерево для прев’ю без збірки.
 */

export interface LayoutNode {
  tag: string;
  id?: string;
  text?: string;
  children: LayoutNode[];
}

export function parseAndroidLayoutXml(xml: string): LayoutNode | null {
  try {
    const raw = String(xml || "");
    // Bound input to avoid pathological/memory blowups in recursive parser
    if (raw.length > 200_000) return null;
    // strip comments & declarations
    const cleaned = raw
      .replace(/<\?xml[^?]*\?>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    if (!cleaned.includes("<")) return null;
    return parseElement(cleaned, 0).node;
  } catch {
    return null;
  }
}

function parseElement(input: string, depth = 0): { node: LayoutNode; rest: string } {
  if (depth > 40) {
    return { node: { tag: "?", children: [] }, rest: "" };
  }
  const open = input.match(/^<([A-Za-z0-9_.:]+)([^>]*)>/);
  if (!open) {
    return { node: { tag: "?", children: [] }, rest: input };
  }
  const tag = open[1].includes(".") ? open[1].split(".").pop()! : open[1];
  const attrs = open[2] || "";
  const selfClosing = /\/>\s*$/.test(open[0]) || /\/\s*$/.test(attrs);
  const idMatch = attrs.match(/android:id="([^"]+)"/);
  const textMatch = attrs.match(/android:text="([^"]+)"/);
  const node: LayoutNode = {
    tag,
    id: idMatch ? idMatch[1].replace("@+id/", "").slice(0, 80) : undefined,
    text: textMatch ? textMatch[1].slice(0, 200) : undefined,
    children: [],
  };
  let rest = input.slice(open[0].length);
  if (selfClosing || attrs.trim().endsWith("/")) {
    return { node, rest };
  }
  const closeTag = `</${open[1]}>`;
  let childBudget = 200;
  while (rest.trim() && childBudget > 0) {
    rest = rest.replace(/^\s+/, "");
    if (rest.startsWith(closeTag)) {
      return { node, rest: rest.slice(closeTag.length) };
    }
    if (rest.startsWith("</")) {
      // unexpected close
      const skip = rest.indexOf(">") + 1;
      rest = rest.slice(skip > 0 ? skip : 1);
      continue;
    }
    if (rest.startsWith("<")) {
      const child = parseElement(rest, depth + 1);
      node.children.push(child.node);
      rest = child.rest;
      childBudget -= 1;
    } else {
      const next = rest.indexOf("<");
      if (next === -1) break;
      rest = rest.slice(next);
    }
  }
  return { node, rest };
}

export function layoutTreeLines(node: LayoutNode, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  const extra = [node.id && `#${node.id}`, node.text && `"${node.text}"`].filter(Boolean).join(" ");
  const lines = [`${pad}▪ ${node.tag}${extra ? " " + extra : ""}`];
  for (const c of node.children) {
    lines.push(...layoutTreeLines(c, depth + 1));
  }
  return lines;
}

export function formatLayoutPreview(xml: string): string {
  const root = parseAndroidLayoutXml(xml);
  if (!root) return "Could not parse layout XML.";
  return ["Layout preview (structure):", ...layoutTreeLines(root).slice(0, 80)].join("\n");
}
