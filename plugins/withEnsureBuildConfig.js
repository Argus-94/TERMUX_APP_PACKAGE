const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * Делает Android-проект, сгенерированный Expo, самодостаточным для AGP 8+:
 * включаем генерацию BuildConfig, задаём единые namespace/applicationId и
 * синхронизируем package-директивы Kotlin с android.package.
 *
 * Плагин намеренно работает как dangerous mod: CBE запускает prebuild --clean,
 * поэтому правки применяются к свежесгенерированному проекту на каждой сборке.
 */
function withEnsureBuildConfig(config) {
  const androidPackage = config.android?.package || "com.karat.aibuilder";
  const packagePattern = androidPackage.replace(/\./g, "\\.");

  return withDangerousMod(config, ["android", async (config) => {
    const root = config.modRequest.platformProjectRoot;
    const buildGradlePath = path.join(root, "app", "build.gradle");

    if (fs.existsSync(buildGradlePath)) {
      let text = fs.readFileSync(buildGradlePath, "utf8");

      // AGP 8 не генерирует BuildConfig без явного флага.
      if (!/buildFeatures\s*\{[\s\S]*?\bbuildConfig\s+true\b/.test(text)) {
        if (/buildFeatures\s*\{/.test(text)) {
          text = text.replace(/buildFeatures\s*\{/, (match) =>
            `${match}\n        buildConfig true`
          );
        } else {
          text = text.replace(/android\s*\{/, (match) =>
            `${match}\n    buildFeatures {\n        buildConfig true\n    }`
          );
        }
      }

      // Expo SDK 54 создаёт Groovy build.gradle. Учитываем также возможные
      // варианты с двоеточием/равно, чтобы не получить дубли при повторном mod.
      if (/namespace\s*(?:=\s*)?["'][^"']+["']/.test(text)) {
        text = text.replace(
          /namespace\s*(?:=\s*)?["'][^"']+["']/, 
          `namespace "${androidPackage}"`
        );
      } else {
        text = text.replace(/android\s*\{/, (match) =>
          `${match}\n    namespace "${androidPackage}"`
        );
      }

      if (/applicationId\s*(?:=\s*)?["'][^"']+["']/.test(text)) {
        text = text.replace(
          /applicationId\s*(?:=\s*)?["'][^"']+["']/, 
          `applicationId "${androidPackage}"`
        );
      } else {
        text = text.replace(/defaultConfig\s*\{/, (match) =>
          `${match}\n        applicationId "${androidPackage}"`
        );
      }

      // Гарантируем сборку автономного APK без Metro (встраивание JS бандла в debug)
      if (!/debuggableVariants\s*=\s*\[\s*\]/.test(text)) {
        if (/react\s*\{/.test(text)) {
          text = text.replace(/react\s*\{/, "react {\n    debuggableVariants = []");
        }
      }

      fs.writeFileSync(buildGradlePath, text, "utf8");
    }

    // Sync package directive with android.package for app sources.
    // CRITICAL: Kotlin uses `package x` (no semicolon); Java requires `package x;`.
    // Previous versions rewrote BOTH as Kotlin-style and broke javac on any .java
    // (e.g. AibAccelNative.java → "error: ';' expected").
    const javaRoot = path.join(root, "app", "src", "main", "java");
    if (fs.existsSync(javaRoot)) {
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(fullPath);
          else if (/\.(kt|java)$/.test(entry.name)) {
            let source = fs.readFileSync(fullPath, "utf8");
            if (!/^package\s+/m.test(source)) continue;
            const isJava = entry.name.endsWith(".java");
            const packageLine = isJava
              ? ("package " + androidPackage + ";")
              : ("package " + androidPackage);
            const next = source.replace(/^package\s+[^\r\n]+/m, packageLine);
            if (next !== source) {
              fs.writeFileSync(fullPath, next, "utf8");
            }
          }
        }
      };
      walk(javaRoot);
    }

    return config;
  }]);
}

module.exports = withEnsureBuildConfig;
