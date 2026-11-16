export type AnsiTextStyle = Readonly<{
  color?: string;
  backgroundColor?: string;
  fontWeight?: "700";
  fontStyle?: "italic";
  textDecorationLine?: "underline";
  opacity?: number;
}>;
export type AnsiTextSegment = Readonly<{ text: string; style?: AnsiTextStyle }>;

const ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;

/** Convert bounded ANSI output into safe React Native text runs using the active 16-color theme palette. */
export function parseAnsiText(input: string, palette: readonly string[], foreground: string, background: string): readonly AnsiTextSegment[] {
  const segments: AnsiTextSegment[] = [];
  let foregroundColor: string | undefined;
  let backgroundColor: string | undefined;
  let bold = false;
  let dim = false;
  let italic = false;
  let underline = false;
  let inverse = false;
  let offset = 0;

  const currentStyle = (): AnsiTextStyle | undefined => {
    const style: { color?: string; backgroundColor?: string; fontWeight?: "700"; fontStyle?: "italic"; textDecorationLine?: "underline"; opacity?: number } = {};
    if (inverse) {
      style.color = backgroundColor ?? background;
      style.backgroundColor = foregroundColor ?? foreground;
    } else {
      if (foregroundColor) style.color = foregroundColor;
      if (backgroundColor) style.backgroundColor = backgroundColor;
    }
    if (bold) style.fontWeight = "700";
    if (dim) style.opacity = 0.68;
    if (italic) style.fontStyle = "italic";
    if (underline) style.textDecorationLine = "underline";
    return Object.keys(style).length ? style : undefined;
  };
  const append = (raw: string): void => {
    const text = raw.replace(/\r\n?/g, "\n").replace(CONTROL_CHARACTERS, "");
    if (!text) return;
    const style = currentStyle();
    const previous = segments[segments.length - 1];
    if (previous && JSON.stringify(previous.style) === JSON.stringify(style)) {
      segments[segments.length - 1] = { text: previous.text + text, ...(style ? { style } : {}) };
    } else segments.push({ text, ...(style ? { style } : {}) });
  };
  const paletteColor = (index: number): string | undefined => Number.isInteger(index) && index >= 0 && index < palette.length ? palette[index] : undefined;
  const xtermColor = (index: number): string | undefined => {
    if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
    if (index < 16) return paletteColor(index);
    if (index < 232) {
      const value = index - 16;
      const component = (n: number) => n === 0 ? 0 : 55 + n * 40;
      const r = component(Math.floor(value / 36));
      const g = component(Math.floor((value % 36) / 6));
      const b = component(value % 6);
      return `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
    }
    const gray = 8 + (index - 232) * 10;
    return `#${[gray, gray, gray].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  };
  const applySgr = (sequence: string): void => {
    const parameters = sequence.slice(2, -1).split(/[;:]/).filter(Boolean).map((value) => Number(value));
    const codes = parameters.length ? parameters : [0];
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i]!;
      if (code === 0) { foregroundColor = undefined; backgroundColor = undefined; bold = false; dim = false; italic = false; underline = false; inverse = false; }
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 3) italic = true;
      else if (code === 4) underline = true;
      else if (code === 7) inverse = true;
      else if (code === 22) { bold = false; dim = false; }
      else if (code === 23) italic = false;
      else if (code === 24) underline = false;
      else if (code === 27) inverse = false;
      else if (code === 39) foregroundColor = undefined;
      else if (code === 49) backgroundColor = undefined;
      else if (code >= 30 && code <= 37) foregroundColor = paletteColor(code - 30);
      else if (code >= 90 && code <= 97) foregroundColor = paletteColor(code - 90 + 8);
      else if (code >= 40 && code <= 47) backgroundColor = paletteColor(code - 40);
      else if (code >= 100 && code <= 107) backgroundColor = paletteColor(code - 100 + 8);
      else if ((code === 38 || code === 48) && codes[i + 1] === 5) {
        const color = xtermColor(codes[i + 2]!);
        if (color) { if (code === 38) foregroundColor = color; else backgroundColor = color; }
        i += 2;
      } else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
        const parts = codes.slice(i + 2, i + 5);
        if (parts.length === 3 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
          const color = `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
          if (code === 38) foregroundColor = color; else backgroundColor = color;
        }
        i += 4;
      }
    }
  };

  for (const match of input.matchAll(ESCAPE_SEQUENCE)) {
    const sequence = match[0];
    const index = match.index ?? offset;
    append(input.slice(offset, index));
    if (sequence.startsWith("\u001b[") && sequence.endsWith("m")) applySgr(sequence);
    offset = index + sequence.length;
  }
  append(input.slice(offset));
  return segments;
}
