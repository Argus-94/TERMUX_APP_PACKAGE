import type { ExpoConfig, ConfigContext } from "expo/config";
import fs from "node:fs";
import path from "node:path";
import withFixGradleProperties from "./plugins/withFixGradleProperties";
import withEnsureBuildConfig from "./plugins/withEnsureBuildConfig";
import withAndroidWindowSoftInput from "./plugins/withAndroidWindowSoftInput";
import withLlamaRnProguard from "./plugins/withLlamaRnProguard";
import withTermuxBridge from "./plugins/withTermuxBridge";
import withEmbeddedTermuxLibraries from "./plugins/withEmbeddedTermuxLibraries";
import withGithubTool from "./plugins/withGithubTool";
import withAibDeviceWatchdog from "./plugins/withAibDeviceWatchdog";
import withAibNativeAccel from "./plugins/withAibNativeAccel";
import withAibCredentialProxy from "./plugins/withAibCredentialProxy";
import withAibInterceptor from "./plugins/withAibInterceptor";
import withAibAccessibility from "./plugins/withAibAccessibility";

const APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version as string;

// Expo's current type schema narrows this legacy field to true, but this app
// intentionally preserves its existing false setting. Only the type is widened;
// release tests compare the emitted configuration JavaScript with the baseline.
type AIBuilderExpoConfig = Omit<ExpoConfig, "android"> & {
  android: Omit<NonNullable<ExpoConfig["android"]>, "edgeToEdgeEnabled"> & { edgeToEdgeEnabled: false };
};

export default ({ config }: ConfigContext): AIBuilderExpoConfig => ({
  ...config,
  name: "AI Builder",
  slug: "ai-builder",
  scheme: "aibuilder",
  version: APP_VERSION,
  orientation: "portrait",
  userInterfaceStyle: "dark",
  newArchEnabled: true,
  icon: "./assets/images/icon.png",
  ios: {
    bundleIdentifier: "com.karat.aibuilder",
  },
  android: {
    // Keep app content inside Android system bars on every screen.
    // Individual safe-area padding remains useful for keyboards/sheets, while
    // disabling edge-to-edge prevents bottom controls from slipping under
    // gesture/navigation buttons on devices with non-zero navigation insets.
    edgeToEdgeEnabled: false,
    package: "com.karat.aibuilder",
    versionCode: 513,
    adaptiveIcon: {
      foregroundImage: "./assets/images/adaptive-icon-fg.png",
      backgroundImage: "./assets/images/adaptive-icon-bg.png"
    },
    // MANAGE_EXTERNAL_STORAGE is a restricted Android 11+ special access.
    // The Runtime screen opens Settings only after an explicit user tap; the
    // permission gates exact-root workspace APIs and is not a path sandbox.
    // Shared-root shell CWD also requires it; arbitrary roots remain blocked.
    blockedPermissions: [
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.READ_MEDIA_AUDIO"
    ],
    permissions: [
      "android.permission.INTERNET",
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.CAMERA",
      // Android foreground-service permissions are intentionally not declared here.
      // The former ModelKeepAliveService used dataSync to keep a ~3 GB model resident
      // indefinitely, which is not an appropriate dataSync use case on Android 15+.
      "android.permission.WAKE_LOCK",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE",
      "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
      "android.permission.RECORD_AUDIO",
      "android.permission.REQUEST_INSTALL_PACKAGES",
      "android.permission.MANAGE_EXTERNAL_STORAGE"
    ]
  },
  plugins: ([
    "expo-router",
    // "Unresolved reference 'BuildConfig'/'R'" на release-сборке — известная
    // проблема AGP 8+, если buildConfig явно не включён. См.
    // plugins/withEnsureBuildConfig.js.
    withEnsureBuildConfig,
    withAndroidWindowSoftInput,
    withLlamaRnProguard,
    // No indefinite foreground service is used for local-model residency.
    // See A-03 remediation in lib/keep-alive.ts.
    // Офлайн-модель (llama.rn / llama.cpp) — CPU-инференс на любом Android-
    // телефоне, поэтому OpenCL (GPU-ускорение под конкретный чипсет) здесь
    // намеренно выключен: меньше риск проблем со сборкой/совместимостью на
    // разных устройствах, важнее стабильная работа "из коробки".
    [
      "llama.rn",
      {
        enableOpenCLAndHexagon: false
      }
    ],
    // App-private bundled runtime only: native one-shot execution and embedded PTY.
    // No external Termux package visibility, permission or Intent dispatch.
    // Shared workspace access remains an explicit exact-root permission flow.
    withTermuxBridge,
    // Pinned official Termux terminal-view/emulator libraries for the embedded console (coordinates verified against upstream library documentation).
    withEmbeddedTermuxLibraries,
    withGithubTool,
    withAibDeviceWatchdog,
    withAibAccessibility,
    // Open MIT path-accel slot (NativeModules.AibNativeAccel). No proprietary proroot.
    withAibNativeAccel,
    // Loopback-only, authenticated local proxy for provider credentials used by userspace agents.
    withAibCredentialProxy,
    // Separate user-consented traffic proxy; no Android system trust policy is modified.
    withAibInterceptor,
    [
      "expo-speech-recognition",
      {
        // Системный текст диалога разрешения (Android / iOS). На Android 13+
        // диалог иногда не появляется, если permission уже "denied" без canAskAgain —
        // тогда UI предлагает «Открыть настройки».
        microphonePermission: "AI Builder использует микрофон для голосового ввода запросов.",
        speechRecognitionPermission: "AI Builder использует распознавание речи для преобразования голоса в текст.",
        androidSpeechServicePackages: [
          "com.google.android.googlequicksearchbox",
          "com.google.android.as",
          "com.samsung.android.bixby.agent"
        ]
      }
    ],
    [
      "expo-notifications",
      {
        icon: "./assets/images/notification-icon.png",
        color: "#F0F1F3",
        defaultChannel: "agent",
      },
    ],
    // ВАЖНО: withFixGradleProperties должен быть ПОСЛЕДНИМ в массиве
    // plugins (см. build-prompt-universal-v3.md, правило B.4) — он
    // патчит gradle.properties/settings.gradle уже ПОСЛЕ того, как все
    // остальные плагины (в т.ч. llama.rn, withTermuxBridge и т.д.)
    // дописали в них свои собственные настройки при `expo prebuild`.
    // Если поставить его раньше — правки этого плагина оказываются "под"
    // более поздними плагинами и затираются/склеиваются заново, из-за
    // чего CBE падает на 403 от Maven Central и на склеенных свойствах
    // gradle.properties. Именно это и было причиной поломки сборки.
    withFixGradleProperties
  ] as any),
  extra: {}
});
