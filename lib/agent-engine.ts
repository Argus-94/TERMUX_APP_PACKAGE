/**
 * High-level agent engine: deterministic create-app, toolchain ensure,
 * Gradle error classification. Used by termux-agent before/around the LLM loop
 * so success does not depend on free-form bash from the model.
 */
import { executeGuardedTermuxCommand } from "./termux-executor";
import { persistentLogger } from "./persistent-logger";
import { runRepairRecipe } from "./repair-script-runner";
import { buildAndroidToolchainCommand } from "./android-toolchain-script";
import { AI_BUILDER_SHARED_ROOT, isWithinSharedAppRoot } from "./writable-path-policy";
import { getBuildBackend } from "./agent-shell-backend";
import { APK_BUILD_SAFETY_POLICY } from "./apk-build-safety-policy";
import { wrapWithAutobuild } from "./autobuild";
import { buildApkValidationCommand, parseApkValidation } from "./apk-validation";
import {
  buildProjectBuildRunnerInvocation,
  buildProjectBuildRunnerMaterializeCommand,
  extractProjectBuildRunnerPath,
} from "./project-build-runner";

/** Soft product words: user wish without explicit "приложение". */
const SOFT_APP_PRODUCT =
  /(игр[уаы]|утилит|виджет|программ[уаы]|таймер|timer|заметк|notes?|счётчик|счетчик|counter|трекер|tracker|чат|chat|бот|bot|клиент|reader|плеер|player|конвертер|converter|переводчик|flashlight|фонарик|погод|weather|калькул|todo|список\s+дел)/i;

export function isStrongCreateAppTask(task: string): boolean {
  const m = (task || "").toLowerCase();
  if (/CREATE_APP_PIPELINE/i.test(task)) return true;
  // JS \b is ASCII-only — Cyrillic verbs like «создай» never matched. Use open stems.
  const create =
    /(создай|создать|создадим|создайте|создал|создам|сгенерируй|зроби|створи|напиши|сделай|разработай|зроби\s+мені|створи\s+застосунок|\bgenerate\b|\bcreate\b|\bscaffold\b|\bmake\b|\bdevelop\b|new\s+app|build\s+me\s+(an?\s+)?app|make\s+me\s+(an?\s+)?(app|apk))/i.test(
      m,
    );
  // «Собери hello world / calculator apk» without a path/zip → create-from-scratch, not zip builder
  const buildAsCreate =
    !create &&
    /(собери|збери|собрать|build|compile|assemble|сделай\s+мне|напиши\s+мне|зроби\s+мені|збери\s+мені)/i.test(m) &&
    !/(\.zip|\/storage\/|\/sdcard\/|gradlew|из\s+исход|с\s+исход|исходник|from\s+source|from\s+sources)/i.test(m) &&
    (SOFT_APP_PRODUCT.test(m) ||
      /(hello\s*world|хело\s*ворд|хелло\s*ворлд|helloworld|калькул|\bcalculator\b|\btodo\b|игр[аыу]|\b2048\b|мини.?app|mini.?app)/i.test(m));
  if (!create && !buildAsCreate) return false;
  if (buildAsCreate) {
    // product intent without sources → treat as strong create
    return true;
  }
  // Explicit app/apk/android/project
  const app =
    /(приложен|додат(ок|ка)|\bapps?\b|\bapplication\b|\bprojects?\b|про[еє]кт|\bapk\b|\bandroid\b|калькул|конкул|\bcalculator\b|\bcalc\b|\btodo\b|\bgames?\b|игр[аыу]|\b2048\b|\btictactoe\b|\bsnake\b|hello\s*world|хело|helloworld|мини.?app|mini.?app)/i.test(
      m,
    );
  if (app) return true;
  // "Напиши таймер" / "сделай трекер воды" — product wish without saying "app"
  if (SOFT_APP_PRODUCT.test(m)) return true;
  // "Напиши … на android / под android / mobile"
  if (/(на|под|for)\s+android|\bmobile\b/i.test(m)) return true;
  // "Напиши [длинное пожелание] приложение" already in app; 
  // Long create requests that mention UI/screens/кнопк → treat as app build
  if (m.length >= 24 && /(экран|кнопк|activity|layout|material|ui\b)/i.test(m)) return true;
  return false;
}

function translitRu(s: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
    и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
    с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  return s
    .split("")
    .map((ch) => {
      const low = ch.toLowerCase();
      const tr = map[low];
      if (tr === undefined) return /[a-z0-9]/i.test(ch) ? ch : "";
      return ch === low ? tr : tr.charAt(0).toUpperCase() + tr.slice(1);
    })
    .join("");
}

export function guessAppNameStrong(task: string): string {
  // JS \b is ASCII-only: Cyrillic tokens never match with leading/trailing \b.
  // Use open stems + optional space separators so "хело ворд" / "калькулятор" work.
  const m = task.match(
    /(?:^|[^\p{L}\p{N}_])(калькулятор|конкулятор|calculator|2048|todo|snake|tictactoe|game|hello\s*world|хело\s*ворд|привіт\s*світ|helloworld|hello|мини.?app|mini.?app|тест(?:овое)?\s*app|test\s*app|таймер|timer|заметк\w*|notes?|трекер|tracker)(?=$|[^\p{L}\p{N}_])/iu,
  );
  if (m) {
    const x = m[1].toLowerCase().replace(/\s+/g, "");
    if (x.includes("кальк") || x.includes("конкул") || x === "calculator") return "Calculator";
    if (x === "2048") return "Game2048";
    if (x.includes("hello") || x.includes("хело") || x.includes("привіт") || x.includes("привет")) return "HelloWorld";
    if (x.includes("todo")) return "TodoApp";
    if (x.includes("snake")) return "Snake";
    if (x.includes("tictactoe")) return "TicTacToe";
    if (/тест|test/.test(x)) return "TestApp";
    if (/мини|mini/.test(x)) return "MiniApp";
    if (/таймер|timer/.test(x)) return "Timer";
    if (/заметк|note/.test(x)) return "Notes";
    if (/трекер|tracker/.test(x)) return "Tracker";
    return x.charAt(0).toUpperCase() + x.slice(1).replace(/[^a-zA-Z0-9]/g, "");
  }
  // Derive folder name from free-form wish after create verb
  const after = task.match(
    /(?:создай|создать|создадим|создайте|создал|создам|сгенерируй|зроби|створи|напиши|сделай|разработай|generate|create|scaffold|make|develop)\s+(.+)/i,
  );
  let rest = (after?.[1] || task).toLowerCase();
  rest = rest
    .replace(
      /(?:^|[^\p{L}\p{N}_])(простой|простое|простую|android|приложение|приложения|додаток|застосунок|app|apk|игру|игра|mobile|проект|project|пожалуйста|please|будь\s*ласка)(?=$|[^\p{L}\p{N}_])/giu,
      " ",
    )
    .replace(/[^a-zа-яё0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = rest.split(" ").filter((w) => w.length > 2).slice(0, 3);
  if (!parts.length) return "MiniApp";
  const slug = translitRu(parts.join(" ")).replace(/[^a-zA-Z0-9]/g, "");
  if (slug.length < 2) return "MiniApp";
  const name = slug.charAt(0).toUpperCase() + slug.slice(1);
  return name.slice(0, 32);
}


/** Deterministic minimal Android Gradle app (Java) under AIBuilderTermux. Trusted internal only. */
export function buildDeterministicCreateAppScript(
  appName: string,
  packageName: string,
  opts?: { forceFresh?: boolean; projectRoot?: string; scaffoldOnly?: boolean },
): string {
  const safe = appName.replace(/[^a-zA-Z0-9_]/g, "") || "MiniApp";
  // Each applicationId segment must be a valid Java identifier (letter start)
  let pkg = packageName.replace(/[^a-zA-Z0-9.]/g, "") || "com.aibuilder.mini";
  pkg = pkg
    .split(".")
    .map((seg) => {
      const s = (seg || "app").toLowerCase().replace(/[^a-z0-9_]/g, "") || "app";
      return /^[a-z_]/.test(s) ? s : "app" + s;
    })
    .join(".");
  const pkgPath = pkg.replace(/\./g, "/");
  const requestedRoot = (opts?.projectRoot || "").trim();
  if (requestedRoot && !isWithinSharedAppRoot(requestedRoot)) throw new Error("PROJECT_PATH_OUTSIDE_SHARED_ROOT");
  const unique = Date.now().toString(36);
  const projectRoot = opts?.forceFresh && requestedRoot
    ? `${requestedRoot}-fresh-${unique}`
    : requestedRoot || `${AI_BUILDER_SHARED_ROOT}/projects/${safe}-${unique}`;
  // Shell-safe double-quoted value; projectRoot may come from discovered/untrusted task input.
  const shellRoot = projectRoot.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
  const parts: string[] = [];
  parts.push("set -e");
  parts.push("set -o pipefail");
  parts.push('AIB_ROOT="/storage/emulated/0/AIBuilderTermux"');
  parts.push('AIB_PRIVATE_ROOT="${AIB_PRIVATE_ROOT:-$HOME/.aibuilder}"; export AIB_PRIVATE_ROOT');
  parts.push(opts?.scaffoldOnly ? 'AIB_SCAFFOLD_ONLY=1' : 'AIB_SCAFFOLD_ONLY=0');
  parts.push('ROOT="' + shellRoot + '"');
  parts.push('REUSE=0');
  parts.push(
    'ROOT_CANON=$(realpath -m -- "$ROOT") || { echo PROJECT_PATH_RESOLVE_FAILED; exit 77; }; '
    + 'case "$ROOT_CANON" in "$AIB_ROOT"/*) ;; *) echo PROJECT_PATH_OUTSIDE_SHARED_ROOT; exit 78;; esac; ROOT="$ROOT_CANON"; '
    + 'if [ -d "$ROOT" ] && { [ -f "$ROOT/settings.gradle" ] || [ -f "$ROOT/settings.gradle.kts" ]; } '
    + '&& [ -f "$ROOT/gradlew" ] && { [ -f "$ROOT/app/build.gradle" ] || [ -f "$ROOT/app/build.gradle.kts" ]; }; then '
    + 'REUSE=1; echo "REUSE_EXISTING_PROJECT=$ROOT"; '
    + 'elif [ -e "$ROOT" ] || [ -L "$ROOT" ]; then echo PROJECT_PATH_CONFLICT; exit 79; '
    + 'else echo "NEW_PROJECT=$ROOT"; fi',
  );
  parts.push(
    'mkdir -p "$ROOT/app/src/main/java/' +
      pkgPath +
      '" "$ROOT/app/src/main/res/layout" "$ROOT/app/src/main/res/values" "$ROOT/gradle/wrapper"',
  );
  // When REUSE=1 skip rewriting sources (preserve user/LLM customizations)
  parts.push('if [ "$REUSE" = "0" ]; then');
  parts.push(
    'SDK=""; for d in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" "$HOME/android-sdk" /opt/android-sdk /usr/lib/android-sdk "$PREFIX/opt/android-sdk" "$PREFIX/share/android-sdk" "$PREFIX/lib/android-sdk"; do ' +
      '[ -n "$d" ] && { [ -d "$d/platforms" ] && [ -n "$(ls -A "$d/platforms" 2>/dev/null)" ] || [ -d "$d/build-tools" ]; } && SDK="$d" && break; done',
  );
  parts.push(
    'if [ -z "$SDK" ]; then echo "ERROR: Android SDK missing ($PREFIX/opt/android-sdk)" >&2; exit 1; fi',
  );
  parts.push('export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"');
  parts.push('echo "sdk.dir=$SDK" > "$ROOT/local.properties"');
  parts.push(
    'COMPILE_SDK=34; ' +
      'if [ ! -f "$SDK/platforms/android-34/android.jar" ]; then ' +
      '  _cs=$(ls -1 "$SDK/platforms" 2>/dev/null | sed -n "s/^android-//p" | sort -n | tail -1); ' +
      '  [ -n "$_cs" ] && COMPILE_SDK="$_cs"; fi; echo "COMPILE_SDK=$COMPILE_SDK"',
  );
  parts.push(
    'JH=""; for d in "${JAVA_HOME:-}" "$PREFIX/lib/jvm/java-17-openjdk" "$PREFIX/lib/jvm/java-21-openjdk" "$PREFIX/lib/jvm/java-21-openjdk-aarch64" /usr/lib/jvm/default-java /usr/lib/jvm/java-17-openjdk-amd64 /usr/lib/jvm/java-17-openjdk-arm64 /usr/lib/jvm/java-21-openjdk-amd64; do ' +
      '[ -x "$d/bin/java" ] && JH="$d" && break; done',
  );
  parts.push('[ -n "$JH" ] && export JAVA_HOME="$JH" && export PATH="$JAVA_HOME/bin:$PATH"');
  parts.push('java -version 2>&1 | head -1 || { echo "ERROR: java missing" >&2; exit 1; }');
  parts.push(
    "printf '%s\\n' " +
      "'org.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=384m -Dfile.encoding=UTF-8' " +
      "'android.useAndroidX=true' " +
      "'android.nonTransitiveRClass=true' " +
      "'org.gradle.daemon=false' " +
      "'org.gradle.parallel=false' > \"$ROOT/gradle.properties\"",
  );
  // aapt2FromMavenOverride: avoid Permission denied when AGP extracts aapt2 onto noexec /storage
  parts.push(
    'AAPT2=$(ls "$SDK/build-tools"/*/aapt2 2>/dev/null | tail -1); ' +
      '[ -z "$AAPT2" ] && AAPT2=$(command -v aapt2 2>/dev/null || true); ' +
      'if [ -n "$AAPT2" ]; then ' +
      '  chmod +x "$AAPT2" 2>/dev/null || true; ' +
      '  printf "\\nandroid.aapt2FromMavenOverride=%s\\n" "$AAPT2" >> "$ROOT/gradle.properties"; ' +
      '  echo "aapt2_override=$AAPT2"; ' +
      'fi',
  );
  parts.push(
    "printf '%s\\n' " +
      "'pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }' " +
      "'dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS); repositories { google(); mavenCentral() } }' " +
      "'rootProject.name = \"" +
      safe +
      "\"' " +
      "'include \":app\"' > \"$ROOT/settings.gradle\"",
  );
  parts.push(
    "printf '%s\\n' " +
      "'buildscript { repositories { google(); mavenCentral() }; dependencies { classpath \"com.android.tools.build:gradle:8.2.2\" } }' " +
      "'task clean(type: Delete) { delete rootProject.buildDir }' > \"$ROOT/build.gradle\"",
  );
  // Write app/build.gradle with placeholder COMPILE_SDK then sed
  parts.push(
    "printf '%s\\n' " +
      "'apply plugin: \"com.android.application\"' " +
      "'android {' " +
      "'  namespace \"" +
      pkg +
      "\"' " +
      "'  compileSdk __COMPILE_SDK__' " +
      "'  defaultConfig {' " +
      "'    applicationId \"" +
      pkg +
      "\"' " +
      "'    minSdk 24' " +
      "'    targetSdk __COMPILE_SDK__' " +
      "'    versionCode 1' " +
      "'    versionName \"1.0\"' " +
      "'  }' " +
      "'  compileOptions {' " +
      "'    sourceCompatibility JavaVersion.VERSION_17' " +
      "'    targetCompatibility JavaVersion.VERSION_17' " +
      "'  }' " +
      "'}' " +
      "'dependencies {}' > \"$ROOT/app/build.gradle\"",
  );
  parts.push('sed -i "s/__COMPILE_SDK__/$COMPILE_SDK/g" "$ROOT/app/build.gradle"');
  parts.push(
    "printf '%s\\n' " +
      "'<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\">' " +
      "'  <application android:label=\"" +
      safe +
      "\" android:theme=\"@android:style/Theme.DeviceDefault.Light\">' " +
      "'    <activity android:name=\".MainActivity\" android:exported=\"true\">' " +
      "'      <intent-filter>' " +
      "'        <action android:name=\"android.intent.action.MAIN\"/>' " +
      "'        <category android:name=\"android.intent.category.LAUNCHER\"/>' " +
      "'      </intent-filter>' " +
      "'    </activity>' " +
      "'  </application>' " +
      "'</manifest>' > \"$ROOT/app/src/main/AndroidManifest.xml\"",
  );
  parts.push(
    "printf '%s\\n' " +
      "'<?xml version=\"1.0\" encoding=\"utf-8\"?>' " +
      "'<LinearLayout xmlns:android=\"http://schemas.android.com/apk/res/android\"' " +
      "'  android:orientation=\"vertical\" android:gravity=\"center\"' " +
      "'  android:layout_width=\"match_parent\" android:layout_height=\"match_parent\">' " +
      "'  <TextView android:id=\"@+id/hello\" android:layout_width=\"wrap_content\"' " +
      "'    android:layout_height=\"wrap_content\" android:text=\"" +
      safe +
      "\" android:textSize=\"24sp\"/>' " +
      "'</LinearLayout>' > \"$ROOT/app/src/main/res/layout/activity_main.xml\"",
  );
  parts.push(
    "printf '%s\\n' '<resources><string name=\"app_name\">" +
      safe +
      "</string></resources>' > \"$ROOT/app/src/main/res/values/strings.xml\"",
  );
  parts.push(
    "printf '%s\\n' " +
      "'package " +
      pkg +
      ";' " +
      "'import android.app.Activity;' " +
      "'import android.os.Bundle;' " +
      "'import android.widget.TextView;' " +
      "'public class MainActivity extends Activity {' " +
      "'  @Override protected void onCreate(Bundle b) {' " +
      "'    super.onCreate(b);' " +
      "'    setContentView(R.layout.activity_main);' " +
      "'    TextView tv = findViewById(R.id.hello);' " +
      "'    if (tv != null) tv.setText(\"" +
      safe +
      "\");' " +
      "'  }' " +
      "'}' > \"$ROOT/app/src/main/java/" +
      pkgPath +
      "/MainActivity.java\"",
  );
  parts.push(
    "printf '%s\\n' " +
      "'distributionBase=GRADLE_USER_HOME' " +
      "'distributionPath=wrapper/dists' " +
      "'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.2-bin.zip' " +
      "'networkTimeout=120000' " +
      "'zipStoreBase=GRADLE_USER_HOME' " +
      "'zipStorePath=wrapper/dists' > \"$ROOT/gradle/wrapper/gradle-wrapper.properties\"",
  );
  parts.push(
    "printf '%s\\n' " +
      "'#!/usr/bin/env bash' " +
      "'DIR=$(CDPATH= cd -- \"$(dirname \"$0\")\" && pwd)' " +
      "'JAR=\"$DIR/gradle/wrapper/gradle-wrapper.jar\"' " +
      "'if [ ! -f \"$JAR\" ]; then echo \"NO_WRAPPER_JAR: $JAR\" >&2; exit 1; fi' " +
      "'exec java -classpath \"$JAR\" org.gradle.wrapper.GradleWrapperMain \"$@\"' > \"$ROOT/gradlew\"",
  );
  parts.push('chmod 755 "$ROOT/gradlew"');
  // A missing wrapper is repaired only by the allowlisted verified-tool-pack recipe.
  parts.push(
    'if [ ! -f "$ROOT/gradle/wrapper/gradle-wrapper.jar" ] && [ "$AIB_SCAFFOLD_ONLY" != "1" ]; then ' +
      'echo "NO_VERIFIED_GRADLE_WRAPPER: repair only from the verified tool-pack recipe" >&2; exit 1; fi',
  );
  parts.push('fi'); // end REUSE=0 scaffold writes
  // Always refresh SDK env + local.properties (reuse and fresh)
  parts.push(
    'SDK=""; for d in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" "$HOME/android-sdk" /opt/android-sdk /usr/lib/android-sdk "$PREFIX/opt/android-sdk" "$PREFIX/share/android-sdk" "$PREFIX/lib/android-sdk"; do ' +
      '[ -n "$d" ] && { [ -d "$d/platforms" ] && [ -n "$(ls -A "$d/platforms" 2>/dev/null)" ] || [ -d "$d/build-tools" ]; } && SDK="$d" && break; done',
  );
  parts.push(
    'if [ -z "$SDK" ]; then echo "ERROR: Android SDK missing ($PREFIX/opt/android-sdk)" >&2; exit 1; fi',
  );
  parts.push('export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"');
  parts.push('echo "sdk.dir=$SDK" > "$ROOT/local.properties"');
  parts.push(
    'JH=""; for d in "${JAVA_HOME:-}" "$PREFIX/lib/jvm/java-17-openjdk" "$PREFIX/lib/jvm/java-21-openjdk" "$PREFIX/lib/jvm/java-21-openjdk-aarch64" /usr/lib/jvm/default-java /usr/lib/jvm/java-17-openjdk-amd64 /usr/lib/jvm/java-17-openjdk-arm64 /usr/lib/jvm/java-21-openjdk-amd64; do ' +
      '[ -x "$d/bin/java" ] && JH="$d" && break; done',
  );
  parts.push('[ -n "$JH" ] && export JAVA_HOME="$JH" && export PATH="$JAVA_HOME/bin:$PATH"');
  parts.push(
    'if [ ! -f "$ROOT/gradle/wrapper/gradle-wrapper.jar" ] && [ "$AIB_SCAFFOLD_ONLY" != "1" ]; then ' +
      'echo "NO_VERIFIED_GRADLE_WRAPPER: repair only from the verified tool-pack recipe" >&2; exit 1; fi',
  );
  // Ensure gradlew launcher exists (reuse projects may miss it)
  parts.push(
    'if [ ! -f "$ROOT/gradlew" ]; then ' +
    "printf '%s\\n' " +
      "'#!/usr/bin/env bash' " +
      "'DIR=$(CDPATH= cd -- \"$(dirname \"$0\")\" && pwd)' " +
      "'JAR=\"$DIR/gradle/wrapper/gradle-wrapper.jar\"' " +
      "'if [ ! -f \"$JAR\" ]; then echo \"NO_WRAPPER_JAR: $JAR\" >&2; exit 1; fi' " +
      "'exec java -classpath \"$JAR\" org.gradle.wrapper.GradleWrapperMain \"$@\"' > \"$ROOT/gradlew\"; " +
      'fi; chmod 755 "$ROOT/gradlew"',
  );
  parts.push(
    'if [ ! -f "$ROOT/gradle/wrapper/gradle-wrapper.properties" ]; then ' +
    "printf '%s\\n' " +
      "'distributionBase=GRADLE_USER_HOME' " +
      "'distributionPath=wrapper/dists' " +
      "'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.2-bin.zip' " +
      "'networkTimeout=120000' " +
      "'zipStoreBase=GRADLE_USER_HOME' " +
      "'zipStorePath=wrapper/dists' > \"$ROOT/gradle/wrapper/gradle-wrapper.properties\"; fi",
  );
  parts.push('export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}"');
  parts.push('mkdir -p "$GRADLE_USER_HOME"');
  // Always inject/refresh aapt2 override (REUSE path may have old gradle.properties without it)
  parts.push(
    'AAPT2=$(ls "$SDK/build-tools"/*/aapt2 2>/dev/null | tail -1); ' +
      '[ -z "$AAPT2" ] && AAPT2=$(command -v aapt2 2>/dev/null || true); ' +
      'if [ -n "$AAPT2" ]; then ' +
      '  chmod +x "$AAPT2" 2>/dev/null || true; ' +
      '  if [ -f "$ROOT/gradle.properties" ] && grep -q "^android.aapt2FromMavenOverride=" "$ROOT/gradle.properties" 2>/dev/null; then ' +
      '    sed -i "s|^android.aapt2FromMavenOverride=.*|android.aapt2FromMavenOverride=$AAPT2|" "$ROOT/gradle.properties"; ' +
      '  else ' +
      '    printf "\\nandroid.aapt2FromMavenOverride=%s\\n" "$AAPT2" >> "$ROOT/gradle.properties"; ' +
      '  fi; ' +
      '  echo "aapt2_override=$AAPT2"; ' +
      'fi',
  );
  if (opts?.scaffoldOnly) {
    parts.push('printf "PROJECT_ROOT=%s\\nPROJECT_KIND_PROVEN=gradle\\nSCAFFOLD_ONLY_COMPLETE=1\\n" "$ROOT"; exit 0');
  }
  parts.push(
    'cd "$ROOT"; ' +
      'LOCKDIR="${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}/.aib-build.lockdir"; ' +
      'if [ -d "$LOCKDIR" ]; then ' +
      '  LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCKDIR" 2>/dev/null || echo 0) )); ' +
      '  GRADLE_ALIVE=0; pgrep -f "[Gg]radle|GradleDaemon" >/dev/null 2>&1 && GRADLE_ALIVE=1; ' +
      '  if [ "$LOCK_AGE" -gt 2700 ] || { [ "$LOCK_AGE" -gt 600 ] && [ "$GRADLE_ALIVE" -eq 0 ]; }; then ' +
      '    echo "STALE_BUILD_LOCK age=${LOCK_AGE}s gradle_alive=$GRADLE_ALIVE — clearing"; rm -rf "$LOCKDIR"; fi; fi; ' +
      'if ! mkdir "$LOCKDIR" 2>/dev/null; then waited=0; while [ $waited -lt 120 ]; do sleep 5; waited=$((waited+5)); ' +
      '  if [ -d "$LOCKDIR" ]; then ' +
      '    LA=$(( $(date +%s) - $(stat -c %Y "$LOCKDIR" 2>/dev/null || echo 0) )); ' +
      '    GA=0; pgrep -f "[Gg]radle|GradleDaemon" >/dev/null 2>&1 && GA=1; ' +
      '    if [ "$LA" -gt 2700 ] || { [ "$LA" -gt 600 ] && [ "$GA" -eq 0 ]; }; then rm -rf "$LOCKDIR"; fi; fi; ' +
      '  mkdir "$LOCKDIR" 2>/dev/null && break; done; fi; ' +
      'if [ ! -d "$LOCKDIR" ]; then echo "BUILD_LOCK_TIMEOUT" >&2; exit 40; fi; ' +
      'trap "rmdir \"$LOCKDIR\" 2>/dev/null || true" EXIT; ' +
      'AAPT2_FLAG=""; [ -n "$AAPT2" ] && AAPT2_FLAG="-Pandroid.aapt2FromMavenOverride=$AAPT2"; ' +
      'bash gradlew clean assembleDebug --no-daemon --max-workers=2 --stacktrace -Dorg.gradle.jvmargs="-Xmx1536m -XX:MaxMetaspaceSize=384m -Dfile.encoding=UTF-8" $AAPT2_FLAG 2>&1',
  );
  parts.push(
    'APK=$(find "$ROOT/app/build/outputs/apk/release" "$ROOT/app/build/outputs/apk/debug" "$ROOT/app/build/outputs/apk" -type f -name "*.apk" 2>/dev/null | while read -r f; do ' +
      'printf "%s\t%s\n" "$(stat -c %Y "$f" 2>/dev/null || echo 0)" "$f"; done | sort -nr | head -1 | cut -f2-); ' +
      'if [ -z "$APK" ]; then APK=$(find "$ROOT" -type f -name "*.apk" 2>/dev/null | while read -r f; do ' +
      'printf "%s\t%s\n" "$(stat -c %Y "$f" 2>/dev/null || echo 0)" "$f"; done | sort -nr | head -1 | cut -f2-); fi',
  );
  parts.push(
    'if [ -n "$APK" ] && [ -f "$APK" ]; then SZ=$(wc -c < "$APK" | tr -d " "); ' +
      'if [ "$SZ" -lt 8192 ]; then echo "ERROR: APK too small (${SZ} bytes)" >&2; exit 1; fi; ' +
      'echo "AIB_DETERMINISTIC_APK=$APK"; echo "AIB_APK_SIZE=$SZ"; ls -la "$APK"; ' +
      'else echo "ERROR: no APK after assembleDebug" >&2; find "$ROOT" -name "*.apk" 2>/dev/null | head -10; exit 1; fi',
  );
  return parts.join("; ");
}


export async function ensureAndroidToolchain(timeoutMs = 120_000): Promise<{
  ok: boolean;
  log: string;
}> {
  // Read-only probe only in the selected environment; never inspect the other backend.
  const backend = getBuildBackend();
  const cmd = buildAndroidToolchainCommand(backend);
  const selectedTimeout = Math.min(Math.max(timeoutMs, 30_000), backend === "ubuntu-proot" ? 120_000 : 90_000);

  const evaluate = (r: { exitCode: number; stdout?: string; stderr?: string; timedOut?: boolean }, where: string) => {
    const log = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
    const javaOk = /^java=OK:\S.+$/m.test(log);
    const sdkOk = /^sdk_platforms=OK:\S+$/m.test(log) && /^aapt2=OK:\S+$/m.test(log);
    const gradleBroken = /^gradle=BROKEN\b/m.test(log) || /^gradle=OK:\s*$/m.test(log);
    const ok =
      r.exitCode === 0 &&
      !r.timedOut &&
      /AIB_TOOLCHAIN_START/.test(log) &&
      /AIB_TOOLCHAIN_END/.test(log) &&
      javaOk &&
      sdkOk &&
      !gradleBroken &&
      !/^sdk_dir=(?:MISSING|UNTRUSTED)$/m.test(log);
    persistentLogger.add(
      ok ? "info" : "warn",
      "AgentEngine",
      `ensureAndroidToolchain where=${where} ok=${ok} exit=${r.exitCode} timedOut=${!!r.timedOut}`,
    );
    return { ok, log: log.slice(0, 6000) };
  };

  try {
    const selected = await executeGuardedTermuxCommand(cmd, {
      timeoutMs: selectedTimeout,
      isBuild: true,
      trustedInternal: true,
      hostTermux: backend === "termux",
      backend,
    });
    return evaluate(selected, backend);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    persistentLogger.add("error", "AgentEngine", `ensureAndroidToolchain: ${msg}`);
    return { ok: false, log: msg };
  }
}

function buildDeterministicCreateBuildCommand(): string {
  return [
    "set +e; set -o pipefail",
    'AIB_PRIVATE_ROOT="${AIB_PRIVATE_ROOT:-$HOME/.aibuilder}"; export AIB_PRIVATE_ROOT; mkdir -p "$AIB_PRIVATE_ROOT/work"',
    'ROOT="$AIB_PROJECT_ROOT"; PREFIX="${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"',
    'SDK=""; for d in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" "$HOME/android-sdk" /opt/android-sdk /usr/lib/android-sdk "$PREFIX/opt/android-sdk" "$PREFIX/share/android-sdk" "$PREFIX/lib/android-sdk"; do [ -n "$d" ] && [ -d "$d/platforms" ] && ls "$d/platforms"/android-*/android.jar >/dev/null 2>&1 && SDK="$d" && break; done',
    '[ -n "$SDK" ] || { echo SDK_MISSING; exit 20; }; export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"',
    'JH=""; for d in "${JAVA_HOME:-}" "$PREFIX/lib/jvm/java-17-openjdk" "$PREFIX/lib/jvm/java-21-openjdk" "$PREFIX/lib/jvm/java-21-openjdk-aarch64" /usr/lib/jvm/default-java /usr/lib/jvm/java-17-openjdk-amd64 /usr/lib/jvm/java-17-openjdk-arm64 /usr/lib/jvm/java-21-openjdk-amd64; do [ -x "$d/bin/java" ] && JH="$d" && break; done',
    '[ -n "$JH" ] || { echo JAVA_MISSING; exit 21; }; export JAVA_HOME="$JH" PATH="$JH/bin:$PATH"; java -version 2>&1 | head -1',
    'cd -- "$ROOT" || { echo PROJECT_ROOT_UNAVAILABLE; exit 65; }',
    '[ -f gradlew ] && [ -f gradle/wrapper/gradle-wrapper.jar ] || { echo NO_VERIFIED_GRADLE_WRAPPER; exit 22; }',
    'export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}"; mkdir -p "$GRADLE_USER_HOME"',
    'AAPT2=$(ls "$SDK/build-tools"/*/aapt2 2>/dev/null | tail -1); AAPT2_FLAG=""; [ -n "$AAPT2" ] && AAPT2_FLAG="-Pandroid.aapt2FromMavenOverride=$AAPT2"',
    'LOCKDIR="$GRADLE_USER_HOME/.aib-build.lockdir"; mkdir "$LOCKDIR" 2>/dev/null || { echo BUILD_LOCK_BUSY; exit 40; }',
    'bash gradlew clean assembleDebug --no-daemon --max-workers=2 --console=plain --stacktrace -Dorg.gradle.jvmargs="-Xmx1536m -XX:MaxMetaspaceSize=384m -Dfile.encoding=UTF-8" $AAPT2_FLAG 2>&1 | tee "$AIB_PRIVATE_ROOT/work/create-app-build.log"; EC=${PIPESTATUS[0]}',
    'if [ "$EC" -ne 0 ]; then rmdir "$LOCKDIR" 2>/dev/null || true; exit "$EC"; fi',
    'APK=$(find "$ROOT/app/build/outputs/apk" -type f -name "*.apk" -print 2>/dev/null | head -1); [ -n "$APK" ] && [ -s "$APK" ] || { rmdir "$LOCKDIR" 2>/dev/null || true; echo APK_ARTIFACT_MISSING; exit 41; }',
    'SZ=$(wc -c < "$APK" | tr -d " "); [ "$SZ" -ge 8192 ] || { rmdir "$LOCKDIR" 2>/dev/null || true; echo APK_ARTIFACT_TOO_SMALL=$SZ; exit 42; }',
    'echo "AIB_DETERMINISTIC_APK=$APK"; echo "AIB_APK_SIZE=$SZ"; rmdir "$LOCKDIR" 2>/dev/null || true',
  ].join("; ");
}

export async function runDeterministicCreateApp(
  appName: string,
  packageName: string,
  timeoutMs = 1_200_000,
  opts?: { forceFresh?: boolean; projectRoot?: string },
): Promise<{ ok: boolean; apkPath: string | null; log: string }> {
  const backend = getBuildBackend();
  const baseOptions = { timeoutMs, isBuild: true, trustedInternal: true, backend, hostTermux: backend === "termux" } as const;
  try {
    const scaffoldCommand = buildDeterministicCreateAppScript(appName, packageName, {
      ...opts,
      scaffoldOnly: true,
    });
    const scaffold = await executeGuardedTermuxCommand(scaffoldCommand, baseOptions);
    const scaffoldLog = `${scaffold.stdout || ""}\n${scaffold.stderr || ""}`.trim();
    const projectRoot = scaffoldLog.match(/^PROJECT_ROOT=(.+)$/m)?.[1]?.trim();
    if (scaffold.exitCode !== 0 || !projectRoot || !isWithinSharedAppRoot(projectRoot)) {
      return { ok: false, apkPath: null, log: `SCAFFOLD_FAILED\n${scaffoldLog}`.slice(0, 8000) };
    }

    const materializeCommand = buildProjectBuildRunnerMaterializeCommand({
      projectRoot,
      projectName: appName,
      projectKind: "gradle",
      backend,
      variant: "assembleDebug",
      command: wrapWithAutobuild({ backend, projectKind: "gradle", primaryCommand: buildDeterministicCreateBuildCommand() }),
    });
    const materialized = await executeGuardedTermuxCommand(materializeCommand, {
      ...baseOptions,
      timeoutMs: Math.min(timeoutMs, 60_000),
    });
    const materializeLog = `${materialized.stdout || ""}\n${materialized.stderr || ""}`.trim();
    const runnerPath = extractProjectBuildRunnerPath(materializeLog);
    if (materialized.exitCode !== 0 || !runnerPath || !runnerPath.startsWith(`${projectRoot}/`)) {
      return {
        ok: false,
        apkPath: null,
        log: `PROJECT_BUILD_RUNNER_MATERIALIZE_FAILED\n${scaffoldLog}\n${materializeLog}`.slice(0, 8000),
      };
    }

    const build = await executeGuardedTermuxCommand(buildProjectBuildRunnerInvocation(runnerPath), {
      ...baseOptions,
      workdir: projectRoot,
    });
    const buildLog = `${build.stdout || ""}\n${build.stderr || ""}`.trim();
    const candidate = buildLog.match(/^AIB_DETERMINISTIC_APK=(.+)$/m)?.[1]?.trim() || null;
    let apkPath = candidate?.startsWith(`${projectRoot}/`) ? candidate : null;
    let ok = build.exitCode === 0 && !!apkPath && /^AIB_APK_SIZE=\d+$/m.test(buildLog);
    let validationLog = "";
    if (ok && apkPath) {
      const validation = await executeGuardedTermuxCommand(buildApkValidationCommand(apkPath, backend, { expectedPackageName: packageName }), {
        ...baseOptions,
        timeoutMs: 30_000,
      });
      validationLog = `${validation.stdout || ""}\n${validation.stderr || ""}`.trim();
      ok = parseApkValidation(validationLog, validation.exitCode ?? 1).ok;
      if (!ok) apkPath = null;
    }
    const log = [scaffoldLog, materializeLog, `PROJECT_BUILD_SCRIPT=${runnerPath}`, buildLog, validationLog]
      .filter(Boolean)
      .join("\n");
    persistentLogger.add(
      ok ? "info" : "warn",
      "AgentEngine",
      `deterministic create-app ${appName} backend=${backend} ok=${ok} script=${runnerPath} apk=${apkPath || "none"}`,
    );
    return { ok, apkPath, log: log.slice(0, 8000) };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, apkPath: null, log: msg };
  }
}

/** Map build failure text → repair recipe id (or null). */
export function classifyBuildError(stdout: string, stderr: string): string | null {
  const t = `${stdout}\n${stderr}`.toLowerCase();
  if (/unsupported class file major version|invalid source release|javaversion/i.test(t)) {
    return "java-install";
  }
  if (
    /gradle[-\s]?wrapper|could not find or load main class org.gradle|gradlew: not found|no_wrapper_jar|gradle-wrapper\.jar missing/i.test(
      t,
    )
  ) {
    return "gradle-wrapper";
  }
  if (/sdk location not found|android_home|sdk.dir|license not accepted/i.test(t)) {
    return "local-properties";
  }
  if (/aapt2|aapt\b|png crunch|resource linking/i.test(t)) {
    return "aapt2-sdk";
  }
  if (/cannot find symbol|package android\./i.test(t) && /compile/i.test(t)) {
    return "local-properties";
  }
  if (/ndk|cmake|clang\+\+/i.test(t) && /failed/i.test(t)) {
    return "ndk-path";
  }
  if (/pnpm|npm err|yarn|enoent.*node_modules|node_modules_install_failed|err_pnpm_store/i.test(t)) {
    return "expo-deps";
  }
  if (/expo_cli_missing|expo_prebuild_failed|cannot find module ['"]expo['"]|npx expo|prebuild_ec=[1-9]/i.test(t)) {
    return "expo-cli";
  }
  if (/\bnode\b.*not found|command not found: node|nodejs/i.test(t) && /expo|npm|pnpm|prebuild/i.test(t)) {
    return "nodejs";
  }
  if (/could not resolve|failed to download|connection (refused|reset)|unknown host|timed?\s*out|network is unreachable|temporary failure in name resolution|ssl.*handshake/i.test(t)) {
    return "wget-curl";
  }
  if (/apksigner_fail|keystore_gen_fail|keytool_missing|zipalign_fail|apksigner_missing|sign_failed/i.test(t)) {
    return "signing-tools";
  }
  if (/build_lock_timeout|build_lock_busy|stale_build_lock/i.test(t)) {
    return "build-lock";
  }
  if (/no space left|enospc|disk[_ ]?full|quota exceeded/i.test(t)) {
    return "disk-cache";
  }
  if (/out of memory|outofmemory|cannot allocate memory|enomem|gc overhead limit|daemon disappeared|process .* killed|signal 9|sigkill|low memory|memory pressure/i.test(t)) {
    // Stronger cleanup (transforms + daemon + tmp); gradle-cache still valid fallback in catalog
    return "disk-cache";
  }
  return null;
}

export async function tryAutoRepair(
  recipeId: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const rr = await runRepairRecipe(recipeId, { allowMedium: true });
    return {
      ok: !!rr.ok,
      message: (rr.stdout || rr.message || rr.stderr || "").slice(0, 2000),
    };
  } catch (e: unknown) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Toolchain → scaffold; if fail due to tools, repair once and scaffold again. */
export async function runCreateAppWithRetry(
  appName: string,
  packageName: string,
  timeoutMs = 1_200_000,
  opts?: { forceFresh?: boolean; projectRoot?: string },
): Promise<{ ok: boolean; apkPath: string | null; log: string }> {
  const tc1 = await ensureAndroidToolchain(Math.min(timeoutMs, 600_000));
  let det = await runDeterministicCreateApp(appName, packageName, timeoutMs, opts);
  if (det.ok && det.apkPath) {
    return { ok: true, apkPath: det.apkPath, log: tc1.log + "\n" + det.log };
  }
  const recipe =
    classifyBuildError(det.log, det.log) ||
    (/aapt2=MISSING|sdk_platforms=MISSING/i.test(tc1.log + det.log) ? "aapt2-sdk" : null) ||
    (/java=MISSING/i.test(tc1.log) ? "java-install" : null) ||
    (/gradle=MISSING/i.test(tc1.log) && getBuildBackend() === "termux" ? "gradle-pkg" : null);
  if (recipe) {
    persistentLogger.add("info", "AgentEngine", `create-app retry after recipe=${recipe}`);
    await tryAutoRepair(recipe);
    await ensureAndroidToolchain(Math.min(timeoutMs, 600_000));
    // Keep the same generated project so a verified wrapper/tool repair applies to the retry.
    const createdRoot = det.log.match(/^PROJECT_ROOT=(.+)$/m)?.[1]?.trim();
    const retryOptions = createdRoot
      ? { ...opts, projectRoot: createdRoot, forceFresh: false }
      : { ...opts, forceFresh: true };
    det = await runDeterministicCreateApp(appName, packageName, timeoutMs, {
      ...retryOptions,
    });
  }
  return {
    ok: !!(det.ok && det.apkPath),
    apkPath: det.apkPath,
    log: (tc1.log + "\n" + det.log).slice(0, 12000),
  };
}


/** Prompt fragment: tools first, shell last. */
export const TOOLS_FIRST_PROTOCOL = `
[PROTOCOL — TOOLS FIRST]
Prefer structured tools over free bash. Reply with EXACTLY one of:

AIB_TOOL:
{"tool":"fs.create","args":{"path":"$PROJECT_ROOT/file.java","content":"..."}}

AIB_TOOL:
{"tool":"toolchain.ensure","args":{}}

AIB_TOOL:
{"tool":"build.run","args":{"command":"assembleDebug"}}

AIB_TOOL:
{"tool":"diagnostics.log","args":{"traceId":"<current traceId>"}}

TERMUX_RUN: | UBUNTU_RUN: | UBUNTU_RUN:
<single bash command in the ACTIVE environment>

TERMUX_DONE: | UBUNTU_DONE: | UBUNTU_DONE:
<short summary with absolute .apk path if built>

Rules:
- Use only registered file/tool APIs enabled for the active execution target. In embedded-private mode use typed workspace.* tools; never assume fs.* or arbitrary shell access.
- In embedded-private mode, use AIB_TOOL runtime.packages for read-only package inventory/status from AI Builder's private prefix only; respect truncation/completeness flags, and never treat it as evidence that the disabled pkg/apt feed or package installation works.
- Android build from an archive, an existing folder, or a newly generated app: inspect the actual root, stack, wrapper/AGP and protected compiler settings first; preserve app identity, compiler settings, source and dependency lockfiles. AIB_TOOL build.run accepts only assembleDebug for a validated AIBuilderTermux project, checks All Files Access and app-private SDK/JDK plus an already-cached Gradle distribution, then invokes the cached Gradle binary with --offline and no clean task. If prerequisites are absent, report TOOLCHAIN_UNAVAILABLE with its reason; never create a shell build script, install/download toolchains, or switch to host Termux/Ubuntu/proot. Do not report an APK unless the tool returns its verified artifact path.
- GitHub tools use the connected encrypted token from the app vault automatically. NEVER put a token in AIB_TOOL args, TERMUX_RUN, chat text, or ask the user to paste one. On GITHUB_TOKEN_NOT_CONNECTED / GITHUB_AUTH_FAILED / GITHUB_PUSH_PERMISSION_REQUIRED / GITHUB_ACCESS_DENIED — stop and report the exact error code.
- The active target and integration settings are authoritative. Use only registered AIB_TOOL operations allowed there; never claim a disabled or missing tool is available, and never switch targets to work around a typed denial. In embedded-private mode, only the explicit typed GitHub API allowlist is available; github.materialize, github.downloadAsset, github.pack, github.copy, local-path access, arbitrary network access, and external shell/runtime tools are unavailable.
- GitHub reads are read-only. Every remote create/write/merge/comment requires a fresh exact per-call user confirmation; absent or denied confirmation means no remote request. Never treat a saved token as user authorization for a write.
- LANGUAGE: user tasks may be in any language. Infer intent; do not require specific keywords, quotes, or a fixed phrasing. Map the intent to the right tools.
- SIDE EFFECTS: use AIB_TOOL only when a registered operation supports the user's requested action on the active target. A plain chat answer is appropriate when the action is unsupported or the user only asks for information; never bypass a required confirmation.
- github.repoCreate { name, private?, description?, autoInit? } creates a repository only when the active target allows it and the exact per-call confirmation is approved. private=true when the user wants access only for themselves / private visibility (any language).
- Discover: github.repo (permissions, default_branch, archived) → github.branches / github.tags / github.tree / github.list / github.read / github.search / github.searchIssues / github.commits / github.commit / github.diff / github.prList / github.prFiles / github.releases / github.release / github.issue as needed.
- Write on GitHub only when explicitly requested and confirmed: unless the user explicitly demands the default branch, github.branch (dedicated agent branch) then atomic github.apply (create/update/delete, up to 100 files). Rename/move: github.rename (or apply delete+create). Always report commitSha/commitUrl after apply; never claim success without them. Prefer github.prCreate after write; github.prCreate can infer the repository default branch when base is omitted. Merge only when asked and confirmed: github.prMerge (mergeMethod: merge|squash|rebase).
- Issues: github.issue / github.issueCreate / github.issueComment / github.searchIssues.
- Releases/assets: github.releases / github.release are read-only; github.downloadAsset is available only when enabled for the active target and user-requested.
- Phone local copy: github.materialize → local file tools / github.pack / build.run only when those tools are enabled for the active target. They are unavailable in embedded-private mode; do not substitute shell, host Termux, or another backend. Local edits do NOT update GitHub unless an explicitly requested and confirmed github.apply succeeds.
- Typical request patterns (non-exhaustive — invent the same style of chain for any similar ask):
  • "analyze code / find bugs" → use only target-enabled read tools; make no unrequested changes
  • "fix in repo / create / delete / rename file" → use target-enabled write tools only after any required exact confirmation
  • "pack repo to ZIP on phone / save to folder" → materialize → pack only when those operations are enabled for the active target
  • "build APK from this repo" → use build.run only for a project already available at the validated root; report TOOLCHAIN_UNAVAILABLE or typed unsupported when prerequisites/target do not permit it
  • "download release APK/asset" → releases/release → downloadAsset only when enabled for the active target
  • "list PRs/issues/commits/tags/branches" → prList / searchIssues / commits / tags / branches
  • "comment on issue/PR / open issue" → issueComment / issueCreate
  • "merge PR" → prMerge
  • "compare branches / review PR files" → diff / prFiles / read
- AIB_TOOL examples (one JSON object per reply):
  AIB_TOOL: {"tool":"runtime.packages","args":{"limit":50}}
  AIB_TOOL: {"tool":"github.parse","args":{"text":"https://github.com/owner/repo"}}
  AIB_TOOL: {"tool":"github.repo","args":{"owner":"owner","repo":"repo"}}
  AIB_TOOL: {"tool":"github.tree","args":{"owner":"owner","repo":"repo","ref":"main"}}
  AIB_TOOL: {"tool":"github.read","args":{"owner":"owner","repo":"repo","path":"src/App.tsx","ref":"main"}}
  AIB_TOOL: {"tool":"github.write","args":{"owner":"owner","repo":"repo","branch":"agent/fix","path":"src/App.tsx","content":"...","message":"fix"}}
  AIB_TOOL: {"tool":"github.apply","args":{"owner":"owner","repo":"repo","branch":"agent/fix","message":"batch","files":[{"path":"a.ts","content":"..."},{"path":"b.ts","delete":true}]}}
  AIB_TOOL: {"tool":"github.materialize","args":{"owner":"owner","repo":"repo","ref":"main"}}
  AIB_TOOL: {"tool":"github.pack","args":{"sourceDir":"/storage/emulated/0/AIBuilderTermux/github/owner/repo-main"}}
  AIB_TOOL: {"tool":"github.downloadAsset","args":{"owner":"owner","repo":"repo","assetUrl":"https://api.github.com/repos/owner/repo/releases/assets/123"}}

- Interceptor (Перехват трафика) is APP-NATIVE (loopback proxy), NOT Termux/Ubuntu shell. Use AIB_TOOL interceptor.* regardless of SHELL_BACKEND:
  interceptor.status | enable | disable | last | detail | command | ruleToggle | rulesDisable
  Example: AIB_TOOL: {"tool":"interceptor.enable","args":{}}
  Example: AIB_TOOL: {"tool":"interceptor.command","args":{"text":"Заблокируй все запросы к google-analytics"}}
  Example: AIB_TOOL: {"tool":"interceptor.last","args":{"limit":20}}
  Shell backend is irrelevant for interceptor; do NOT use TERMUX_RUN for intercept ops.
- ENV_STATE, GOAL, POLICY, and SESSION_MEMORY blocks are authoritative. Complete GOAL; verify before DONE.
- On anti-stuck forceDone: honest TERMUX_DONE with GOAL unmet evidence — never invent artifacts.

- If a needed step is not a single github.* tool, combine tools (e.g. materialize + zip via pack; read + apply for surgical edits; release metadata + downloadAsset). Use TERMUX_RUN only when no github.* / fs.* / build.* tool covers the action (e.g. ad-hoc local shell), never for authenticated GitHub HTTP.
- AUTONOMY: detect missing tools with command -v/version checks and stay in the selected backend. toolchain.ensure is a read-only probe, not an SDK installer. Missing JDK may be repaired only through the host's backend-aware allowlisted java-install recipe; do not issue package installs from model-generated shell for an APK recovery.
- Android build safety (authoritative): ${APK_BUILD_SAFETY_POLICY}
- On a failed tool/shell command, inspect diagnostics.log and the first real error, identify the failing backend, use only the exact allowlisted repair recipes, then retry once with a changed strategy. Do not blindly repeat.
- Do NOT claim BUILD SUCCESSFUL without a real [TERMUX_RESULT] exit 0 and .apk path.
- Prefer deterministic allowlisted repairs / re-run assemble; never report build success until the host validates the non-empty APK archive and V1/V2/V3 signature.
`.trim();
