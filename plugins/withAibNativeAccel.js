/**
 * Open MIT native accelerator for AI Builder (plan Phase G).
 * Injects React Native module NativeModules.AibNativeAccel.
 * Does NOT change gradle.properties / compileSdk / NDK version.
 * Optional C sources under native/aib-native-accel are copied for future NDK link;
 * Kotlin path-map works without .so (isAvailable = true when module registered).
 */
const { withMainApplication, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

function moduleKotlin(pkg) {
  return `package ${pkg}

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit

/**
 * Open userspace path-accel + shell (MIT). Replaces proprietary proroot slot.
 * NativeModules.AibNativeAccel — consumed by core/runtime/native-accel-loader.ts
 */
class AibNativeAccelModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    private var jniLoaded = false
    init {
      try {
        System.loadLibrary("aibaccel")
        jniLoaded = true
      } catch (_: UnsatisfiedLinkError) {
        jniLoaded = false
      }
    }
  }

  override fun getName(): String = "AibNativeAccel"

  @ReactMethod
  fun isAvailable(promise: Promise) {
    // This legacy app-private shell cannot execute in the shared Termux runtime context.
    promise.resolve(false)
  }

  @ReactMethod
  fun probe(promise: Promise) {
    try {
      val map = Arguments.createMap()
      map.putBoolean("ok", false)
      map.putBoolean("supportsRuntimeContext", false)
      map.putString(
        "detail",
        "disabled: app-private shell cannot honor Termux workspace, cwd, env and timeout; router uses Termux/proot"
      )
      map.putBoolean("jni", jniLoaded)
      map.putString("version", "1.0.0-mit")
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("AIB_ACCEL_PROBE", e.message, e)
    }
  }

  /** Fast path rewrite: prefix from → to (Kotlin; JNI if loaded). */
  @ReactMethod
  fun mapPath(path: String, from: String, to: String, promise: Promise) {
    try {
      if (jniLoaded) {
        try {
          val cls = Class.forName("${pkg}.AibAccelNative")
          val m = cls.getMethod("mapPath", String::class.java, String::class.java, String::class.java)
          val out = m.invoke(null, path, from, to) as? String
          if (out != null) {
            promise.resolve(out)
            return
          }
        } catch (_: Throwable) {
          /* fall through */
        }
      }
      promise.resolve(kotlinMapPath(path, from, to))
    } catch (e: Exception) {
      promise.reject("AIB_ACCEL_MAP", e.message, e)
    }
  }

  @ReactMethod
  fun exec(command: String, promise: Promise) {
    try {
      // Keep the legacy API, but share the only supported process/env/timeout contract.
      val bridge = reactContext.getNativeModule(TermuxBridgeModule::class.java)
      if (bridge == null) {
        promise.reject("AIB_EMBEDDED_RUNTIME_UNAVAILABLE", "Bundled runtime bridge is not linked")
        return
      }
      bridge.runEmbeddedTermuxCommand(command, null, 120000.0, "accel-" + java.util.UUID.randomUUID().toString(), promise)
    } catch (e: Exception) {
      promise.reject("AIB_ACCEL_EXEC", e.message, e)
    }
  }

  private fun kotlinMapPath(path: String, from: String, to: String): String {
    if (from.isEmpty()) return path
    return if (path.startsWith(from)) to + path.substring(from.length) else path
  }
}
`;
}

function packageKotlin(pkg) {
  return `package ${pkg}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class AibNativeAccelPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(AibNativeAccelModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`;
}

/** Optional JNI helper class (loaded only if libaibaccel.so present). */
function jniHelperJava(pkg) {
  // String concat (not template) so package line ALWAYS ends with ';' for javac.
  // Never emit Kotlin-style "package x" without semicolon into a .java file.
  const safePkg = String(pkg || "com.karat.aibuilder").replace(/[^a-zA-Z0-9_.]/g, "");
  return (
    "package " + safePkg + ";\n" +
    "\n" +
    "/** JNI stubs - implemented in native/aib-native-accel (MIT). */\n" +
    "public final class AibAccelNative {\n" +
    "  private AibAccelNative() {}\n" +
    "  public static native String version();\n" +
    "  public static native String mapPath(String path, String from, String to);\n" +
    "}\n"
  );
}

function withAibNativeAccel(config) {
  config = withDangerousMod(config, [
    "android",
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const pkg =
        config.android?.package ||
        config.android?.packageName ||
        "com.karat.aibuilder";
      const pkgPath = pkg.replace(/\./g, "/");
      const srcDir = path.join(
        config.modRequest.platformProjectRoot,
        "app/src/main/java",
        pkgPath,
      );
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, "AibNativeAccelModule.kt"), moduleKotlin(pkg));
      fs.writeFileSync(path.join(srcDir, "AibNativeAccelPackage.kt"), packageKotlin(pkg));

      // Optional JNI Java class (same package as app modules) + copy C sources for manual/NDK builds
      // Bulletproof: remove any stale .java that might contain Kotlin-style package (no semicolon).
      const accelJavaPath = path.join(srcDir, "AibAccelNative.java");
      try { if (fs.existsSync(accelJavaPath)) fs.unlinkSync(accelJavaPath); } catch (_) {}
      const accelJavaSrc = jniHelperJava(pkg);
      if (!/^package\s+[\w.]+\s*;/.test(accelJavaSrc.split("\n")[0] || "")) {
        throw new Error("[withAibNativeAccel] generated AibAccelNative.java missing package ...; — refusing write");
      }
      fs.writeFileSync(accelJavaPath, accelJavaSrc, "utf8");
      // Also remove legacy hardcoded path from older plugin versions
      const legacyAccel = path.join(
        config.modRequest.platformProjectRoot,
        "app/src/main/java/com/aibuilder/accel/AibAccelNative.java",
      );
      try { if (fs.existsSync(legacyAccel)) fs.unlinkSync(legacyAccel); } catch (_) {}

      const nativeSrc = path.join(projectRoot, "native/aib-native-accel/src");
      const jniOut = path.join(
        config.modRequest.platformProjectRoot,
        "app/src/main/jni/aibaccel",
      );
      if (fs.existsSync(nativeSrc)) {
        fs.mkdirSync(jniOut, { recursive: true });
        for (const f of fs.readdirSync(nativeSrc)) {
          fs.copyFileSync(path.join(nativeSrc, f), path.join(jniOut, f));
        }
        fs.writeFileSync(
          path.join(jniOut, "CMakeLists.txt"),
          `cmake_minimum_required(VERSION 3.18)
project(aibaccel)
add_library(aibaccel SHARED aib_accel.c aib_accel_jni.c)
target_include_directories(aibaccel PRIVATE \${CMAKE_CURRENT_SOURCE_DIR})
find_library(log-lib log)
target_link_libraries(aibaccel \${log-lib})
`,
        );
      }
      return config;
    },
  ]);

  config = withMainApplication(config, (config) => {
    let c = config.modResults.contents;
    if (c.includes("AibNativeAccelPackage()")) return config;
    const isKotlin = config.modResults.language === "kt";
    if (isKotlin) {
      const marker = "PackageList(this).packages.apply {";
      if (c.includes(marker)) {
        c = c.replace(marker, marker + "\n              add(AibNativeAccelPackage())");
      } else if (c.includes("val packages = PackageList(this).packages")) {
        c = c.replace(
          "val packages = PackageList(this).packages",
          "val packages = PackageList(this).packages\n            packages.add(AibNativeAccelPackage())",
        );
      } else {
        throw new Error("[withAibNativeAccel] MainApplication package list not found");
      }
    } else {
      const marker = "List<ReactPackage> packages = new PackageList(this).getPackages();";
      if (!c.includes(marker)) throw new Error("[withAibNativeAccel] Java package list not found");
      c = c.replace(marker, marker + "\n      packages.add(new AibNativeAccelPackage());");
    }
    config.modResults.contents = c;
    return config;
  });

  return config;
}

module.exports = withAibNativeAccel;
