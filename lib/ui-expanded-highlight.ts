import { GOLD, GOLD_DEEP, GOLD_LIGHT } from "../theme/colors";

/** Shared visual language for expanded accordion / collapsible headers. */
export const EXPANDED_GOLD = GOLD;
export const EXPANDED_GOLD_DEEP = GOLD_DEEP;

function goldRgba(alpha: number): string {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(GOLD.slice(offset, offset + 2), 16));
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
}

export type ExpandedHighlightColors = {
  inkBright: string;
  muted: string;
  line: string;
  surface: string;
  accent: string;
  accentDim: string;
};

export function expandedHeaderStyle(
  expanded: boolean,
  colors: ExpandedHighlightColors,
  fillHighlight: boolean = true,
): Record<string, unknown> {
  const gold = EXPANDED_GOLD;
  const goldDeep = EXPANDED_GOLD_DEEP;
  return {
    backgroundColor: expanded && fillHighlight ? goldRgba(0.22) : colors.surface,
    borderColor: expanded ? gold : colors.line,
    borderWidth: expanded ? 1.5 : 1,
    // Keep left accent bar, but content must clear it (see expandedContentPaddingLeft)
    borderLeftWidth: expanded ? 4 : 1,
    borderLeftColor: expanded ? goldDeep : expanded ? gold : colors.line,
    shadowColor: expanded ? gold : "transparent",
    shadowOpacity: expanded ? 0.35 : 0,
    shadowRadius: expanded ? 8 : 0,
    shadowOffset: { width: 0, height: 2 },
    elevation: expanded ? 3 : 0,
  };
}

/** Extra left padding so icon/title clear the thick Gold left border. */
export function expandedContentPaddingLeft(expanded: boolean, base: number = 12): number {
  return expanded ? base + 4 : base;
}

export function expandedTitleColor(expanded: boolean, inkBright: string): string {
  if (!expanded) return inkBright;
  const inkIsLight =
    /^#([FEfe]|[A-Fa-f][A-Fa-f0-9]{5})/.test(inkBright) ||
    inkBright.toLowerCase().includes("f8fafc");
  return inkIsLight ? GOLD_LIGHT : GOLD_DEEP;
}

export function expandedIconColors(_expanded: boolean, colors: ExpandedHighlightColors) {
  // Icons keep their original (non-Gold) colours in both states;
  // only the header background/border/title are highlighted.
  return {
    bg: colors.accentDim,
    fg: colors.accent,
    chevron: colors.muted,
  };
}

/** Solid icon chip so the Gold header fill does not tint the glyph. */
export function expandedIconChipStyle(
  expanded: boolean,
  colors: ExpandedHighlightColors,
  size: number = 36,
): Record<string, unknown> {
  const icons = expandedIconColors(expanded, colors);
  return {
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.28),
    alignItems: "center" as const,
    justifyContent: "center" as const,
    // Opaque surface so the Gold rgba fill never shows through the chip
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: expanded ? goldRgba(0.35) : colors.line,
    // Inner accent wash (solid, not the header Gold)
    // Use a nested view for the accent tint if needed; chip itself stays solid.
    overflow: "hidden" as const,
  };
}

/** Inner accent disc for the chip (optional). */
export function expandedIconChipInnerStyle(
  colors: ExpandedHighlightColors,
  size: number = 36,
): Record<string, unknown> {
  const icons = expandedIconColors(false, colors);
  const inner = Math.max(22, size - 8);
  return {
    width: inner,
    height: inner,
    borderRadius: Math.round(inner * 0.28),
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: icons.bg,
  };
}

export function expandedBodyStyle(expanded: boolean): Record<string, unknown> | null {
  // Body stays neutral — Gold is reserved for indicator/settings headers only.
  if (!expanded) return null;
  return {
    marginLeft: 0,
    paddingLeft: 0,
  };
}

/** Neutral outer card for indicator panels (no Gold on the whole card). */
export function indicatorCardStyle(colors: ExpandedHighlightColors): Record<string, unknown> {
  return {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderLeftWidth: 1,
    borderLeftColor: colors.line,
  };
}

/** Neutral indicator header; expanded state uses only a restrained theme accent outline. */
export function indicatorHeaderStyle(
  expanded: boolean,
  colors: ExpandedHighlightColors,
): Record<string, unknown> {
  if (!expanded) {
    return {
      backgroundColor: "transparent",
      borderWidth: 0,
      borderLeftWidth: 0,
    };
  }
  return {
    backgroundColor: colors.surface,
    borderColor: colors.accent,
    borderWidth: 1,
    borderLeftWidth: 2,
    borderLeftColor: colors.accent,
    borderRadius: 12,
  };
}
