const { withGradleProperties, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const REQUIRED_PROPERTIES = {
  "org.gradle.daemon": "false",
  "org.gradle.jvmargs": "-Xmx4096m -XX:MaxMetaspaceSize=1024m",
  "android.useAndroidX": "true",
  "android.enableJetifier": "false",
  // Глобальный (на весь проект, а не только на модуль app) флаг AGP,
  // включающий генерацию BuildConfig везде, где она нужна — это и есть
  // официально задокументированное решение ошибки "Unresolved reference
  // 'BuildConfig'" на AGP 8+ (см. https://issuetracker.google.com/issues/283737536
  // и многочисленные issue в expo/expo и facebook/react-native с этим же
  // сообщением). Дополняет точечный fix в plugins/withEnsureBuildConfig.js —
  // тот правит только android/app/build.gradle текстом, этот флаг
  // гарантирует то же самое поведение на уровне всего Gradle-проекта, даже
  // если текстовый патч app/build.gradle по какой-то причине не применился.
  "android.defaults.buildfeatures.buildconfig": "true",
  // Preserve transitive dependency resources through generated R classes.
  "android.nonTransitiveRClass": "false",
  // Preserve final R.id constants for legacy Java switch/case compatibility.
  "android.nonFinalResIds": "false",
  // На некоторых раннерах CBE переиспользует ~/.gradle между сборками
  // разных проектов/пакетов. Инкрементальный кэш Kotlin-компилятора,
  // если он "прилип" от сборки с другим applicationId/namespace, — известная
  // причина ложных "Unresolved reference" (в т.ч. на R и BuildConfig) в
  // первом же файле, использующем эти классы. Отключаем инкрементальность,
  // чтобы каждая сборка компилировалась с нуля и не зависела от чужого кэша.
  "kotlin.incremental": "false"
};

function withFixGradleProperties(config) {
  config = withGradleProperties(config, (config) => {
    for (const [key, value] of Object.entries(REQUIRED_PROPERTIES)) {
      const existingIndex = config.modResults.findIndex(
        (item) => item.type === "property" && item.key === key
      );
      if (existingIndex >= 0) {
        config.modResults[existingIndex].value = value;
      } else {
        config.modResults.push({ type: "property", key, value });
      }
    }
    return config;
  });

  config = withDangerousMod(config, [
    "android",
    async (config) => {
      const propsPath = path.join(config.modRequest.platformProjectRoot, "gradle.properties");
      if (!fs.existsSync(propsPath)) return config;
      let text = fs.readFileSync(propsPath, "utf8");
      text = text.replace(/^(\d+)([a-zA-Z][\w.]*=.*)$/gm, "$2");
      text = text.replace(
        /(\S)(?=(?:org\.gradle\.|android\.|kotlin\.|expo\.)[A-Za-z][\w.-]*=)/g,
        "$1\n"
      );
      const lines = text.split("\n");
      const lastIndexByKey = new Map();
      lines.forEach((line, idx) => {
        const m = line.match(/^([A-Za-z][\w.-]*)=/);
        if (m) lastIndexByKey.set(m[1], idx);
      });
      const deduped = lines.filter((line, idx) => {
        const m = line.match(/^([A-Za-z][\w.-]*)=/);
        if (!m) return true;
        return lastIndexByKey.get(m[1]) === idx;
      });
      text = deduped.join("\n");
      for (const [key, value] of Object.entries(REQUIRED_PROPERTIES)) {
        const re = new RegExp(`^${key.replace(/\./g, "\\.")}=.*$`, "m");
        if (re.test(text)) {
          text = text.replace(re, `${key}=${value}`);
        } else {
          if (text.length > 0 && !text.endsWith("\n")) text += "\n";
          text += `${key}=${value}\n`;
        }
      }
      text = text.replace(/\n*$/, "\n");
      fs.writeFileSync(propsPath, text, "utf8");
      return config;
    }
  ]);

  config = withDangerousMod(config, [
    "android",
    async (config) => {
      const settingsPath = path.join(config.modRequest.platformProjectRoot, "settings.gradle");
      if (!fs.existsSync(settingsPath)) return config;
      let text = fs.readFileSync(settingsPath, "utf8");
      text = text.replace(/id\s+["\']org\.gradle\.toolchains\.foojay-resolver-convention["\'].*\n?/g, "");
      if (text.includes("pluginManagement")) {
        if (!text.includes("mavenCentral()")) {
          text = text.replace(
            /pluginManagement\s*\{([^}]*)repositories\s*\{/,
            `pluginManagement {$1repositories {\n        mavenCentral()`
          );
        }
        if (!text.includes("gradlePluginPortal()")) {
          text = text.replace(
            /pluginManagement\s*\{([^}]*)repositories\s*\{/,
            `pluginManagement {$1repositories {\n        gradlePluginPortal()`
          );
        }
      }
      if (!text.includes("buildCache")) {
        text += `\n\nbuildCache {\n    local {\n        enabled = false\n    }\n}\n`;
      }
      fs.writeFileSync(settingsPath, text, "utf8");
      return config;
    }
  ]);

  return config;
}

module.exports = withFixGradleProperties;
