const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Keep llama.rn's JNI entry points without broad app-wide keeps. PDFBox's
// JPXFilter references Gemalto's optional JPEG2000 image decoder; text-only PDF
// extraction does not decode images, so suppress only this exact missing class.
const RULES = [
  {
    line: "-keep class com.rnllama.** { *; }",
    content: "# llama.rn\n-keep class com.rnllama.** { *; }",
  },
  {
    line: "-dontwarn com.gemalto.jp2.JP2Decoder",
    content: "# PDFBox JPX image decoder is optional for PDF text extraction.\n-dontwarn com.gemalto.jp2.JP2Decoder",
  },
];

function withLlamaRnProguard(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const proguardPath = path.join(
        config.modRequest.platformProjectRoot,
        "app/proguard-rules.pro"
      );
      if (!fs.existsSync(proguardPath)) return config;
      const text = fs.readFileSync(proguardPath, "utf8");
      const existingLines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
      const missing = RULES.filter(({ line }) => !existingLines.has(line));
      if (missing.length === 0) return config;
      const base = text.replace(/\s*$/, "");
      const separator = base.length > 0 ? "\n\n" : "";
      fs.writeFileSync(proguardPath, `${base}${separator}${missing.map(({ content }) => content).join("\n\n")}\n`, "utf8");
      return config;
    },
  ]);
}

module.exports = withLlamaRnProguard;
