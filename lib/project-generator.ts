import { generateAgentsMd } from "./agents-md";

export type ProjectTemplateId = "empty" | "compose" | "bottomnav";

export interface ProjectConfig {
  name: string;
  packageName: string;
  minSdk?: number;
  targetSdk?: number;
  useCompose?: boolean;
  template?: ProjectTemplateId;
  gitInit?: boolean;
  projectPath?: string;
}

export const GENERATOR_COMPILE_SDK = 34;
export const GENERATOR_TARGET_SDK_DEFAULT = 34;

function resolveTemplate(config: ProjectConfig): ProjectTemplateId {
  if (config.template) return config.template;
  return config.useCompose ? "compose" : "empty";
}

function isCompose(config: ProjectConfig): boolean {
  const t = resolveTemplate(config);
  return t === "compose" || t === "bottomnav" || !!config.useCompose;
}

export function generateProjectStructure(config: ProjectConfig): Record<string, string> {
  const template = resolveTemplate(config);
  const compose = isCompose(config);
  const pkgPath = config.packageName.replace(/\./g, "/");
  const files: Record<string, string> = {};

  files["build.gradle.kts"] = generateRootBuildGradle();
  files["settings.gradle.kts"] = `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "${config.name}"
include(":app")
`;
  files["gradle.properties"] =
    "android.useAndroidX=true\nandroid.nonTransitiveRClass=true\norg.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8\n";
  files["gradle/wrapper/gradle-wrapper.properties"] = generateWrapperProps();

  files["app/build.gradle.kts"] = generateAppBuildGradle({ ...config, useCompose: compose, template });
  files["app/src/main/AndroidManifest.xml"] = generateManifest(config);
  files[`app/src/main/java/${pkgPath}/MainActivity.kt`] = generateMainActivity({
    ...config,
    useCompose: compose,
    template,
  });
  files["app/src/main/res/values/colors.xml"] = generateColorsXml();
  files["app/src/main/res/values/strings.xml"] = generateStringsXml(config, template);
  files["app/src/main/res/values/themes.xml"] = generateThemesXml(config);

  if (template === "empty" && !compose) {
    files["app/src/main/res/layout/activity_main.xml"] = generateMainLayout();
  }
  if (template === "bottomnav") {
    files[`app/src/main/java/${pkgPath}/ui/HomeScreen.kt`] = generateHomeScreen(config.packageName);
    files[`app/src/main/java/${pkgPath}/ui/SettingsScreen.kt`] = generateSettingsScreen(config.packageName);
    files[`app/src/main/java/${pkgPath}/ui/Theme.kt`] = generateComposeTheme(config.packageName);
  }
  if (template === "compose") {
    files[`app/src/main/java/${pkgPath}/ui/Theme.kt`] = generateComposeTheme(config.packageName);
    files[`app/src/main/java/${pkgPath}/ui/Greeting.kt`] = generateGreeting(config.packageName, config.name);
  }

  // minimal drawable so resources resolve
  files["app/src/main/res/drawable/ic_launcher_foreground.xml"] = generateVectorIcon();
  files["app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml"] = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/accent_primary"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>
`;

  const stack =
    template === "bottomnav"
      ? "Kotlin, Android Gradle, Jetpack Compose, Navigation"
      : compose
        ? "Kotlin, Android Gradle, Jetpack Compose"
        : "Kotlin, Android Gradle, ViewBinding";

  files["README.md"] = generateReadme(config, template);
  files["AGENTS.md"] = generateAgentsMd({
    name: config.name,
    packageName: config.packageName,
    stack,
    projectPath: config.projectPath,
  });

  if (config.gitInit) {
    files[".gitignore"] = [
      "*.iml",
      ".gradle/",
      "/local.properties",
      "/.idea/",
      ".DS_Store",
      "/build",
      "/captures",
      ".externalNativeBuild",
      ".cxx",
      "app/build/",
      "*.apk",
      "*.ap_",
      "*.dex",
    ].join("\n") + "\n";
  }

  return files;
}

function generateRootBuildGradle(): string {
  return `plugins {
    id("com.android.application") version "8.2.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.22" apply false
}
`;
}

function generateWrapperProps(): string {
  return `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-8.2-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`;
}

function generateAppBuildGradle(config: ProjectConfig): string {
  const compose = isCompose(config);
  const minSdk = config.minSdk ?? 24;
  const targetSdk = config.targetSdk ?? GENERATOR_TARGET_SDK_DEFAULT;
  const composeBlock = compose
    ? `
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.8"
    }
`
    : `
    buildFeatures {
        viewBinding = true
    }
`;

  const deps = compose
    ? `dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.activity:activity-compose:1.8.2")
    implementation(platform("androidx.compose:compose-bom:2024.02.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.navigation:navigation-compose:2.7.7")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
`
    : `dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
}
`;

  return `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "${config.packageName}"
    compileSdk = ${GENERATOR_COMPILE_SDK}

    defaultConfig {
        applicationId = "${config.packageName}"
        minSdk = ${minSdk}
        targetSdk = ${targetSdk}
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
${composeBlock}
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

${deps}`;
}

function generateManifest(config: ProjectConfig): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/Theme.App">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;
}

function generateMainActivity(config: ProjectConfig): string {
  const template = resolveTemplate(config);
  const pkg = config.packageName;

  if (template === "bottomnav") {
    return `package ${pkg}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import ${pkg}.ui.AppTheme
import ${pkg}.ui.HomeScreen
import ${pkg}.ui.SettingsScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            AppTheme {
                var selected by rememberSaveable { mutableIntStateOf(0) }
                Scaffold(
                    bottomBar = {
                        NavigationBar {
                            NavigationBarItem(
                                selected = selected == 0,
                                onClick = { selected = 0 },
                                icon = { Icon(Icons.Default.Home, contentDescription = null) },
                                label = { Text("Home") },
                            )
                            NavigationBarItem(
                                selected = selected == 1,
                                onClick = { selected = 1 },
                                icon = { Icon(Icons.Default.Settings, contentDescription = null) },
                                label = { Text("Settings") },
                            )
                        }
                    }
                ) { padding ->
                    when (selected) {
                        0 -> HomeScreen(Modifier.padding(padding))
                        else -> SettingsScreen(Modifier.padding(padding))
                    }
                }
            }
        }
    }
}
`;
  }

  if (isCompose(config)) {
    return `package ${pkg}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ${pkg}.ui.AppTheme
import ${pkg}.ui.Greeting

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            AppTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(24.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Greeting(name = "${config.name}")
                    }
                }
            }
        }
    }
}
`;
  }

  return `package ${pkg}

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
    }
}
`;
}

function generateHomeScreen(pkg: string): string {
  return `package ${pkg}.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

@Composable
fun HomeScreen(modifier: Modifier = Modifier) {
    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("Home", style = MaterialTheme.typography.headlineMedium)
    }
}
`;
}

function generateSettingsScreen(pkg: string): string {
  return `package ${pkg}.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

@Composable
fun SettingsScreen(modifier: Modifier = Modifier) {
    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("Settings", style = MaterialTheme.typography.headlineMedium)
    }
}
`;
}

function generateComposeTheme(pkg: string): string {
  return `package ${pkg}.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Accent = Color(0xFF9FCBFF)
private val DarkBg = Color(0xFF101418)
private val DarkSurface = Color(0xFF181C20)

private val DarkColors = darkColorScheme(
    primary = Accent,
    background = DarkBg,
    surface = DarkSurface,
)

private val LightColors = lightColorScheme(
    primary = Accent,
)

@Composable
fun AppTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}
`;
}

function generateGreeting(pkg: string, appName: string): string {
  return `package ${pkg}.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

@Composable
fun Greeting(name: String, modifier: Modifier = Modifier) {
    Text(
        text = "Hello, $name!",
        style = MaterialTheme.typography.headlineMedium,
        color = MaterialTheme.colorScheme.primary,
        modifier = modifier,
    )
}
`;
}

function generateThemesXml(_config: ProjectConfig): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.App" parent="Theme.Material3.DayNight.NoActionBar">
        <item name="colorPrimary">@color/accent_soft</item>
        <item name="colorPrimaryContainer">@color/accent_primary</item>
        <item name="android:statusBarColor">@color/black</item>
        <item name="android:navigationBarColor">@color/black</item>
    </style>
</resources>
`;
}

function generateMainLayout(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<androidx.constraintlayout.widget.ConstraintLayout
    xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:app="http://schemas.android.com/apk/res-auto"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:padding="16dp">

    <TextView
        android:id="@+id/titleText"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="@string/app_name"
        android:textSize="22sp"
        android:textStyle="bold"
        app:layout_constraintTop_toTopOf="parent"
        app:layout_constraintStart_toStartOf="parent"
        app:layout_constraintEnd_toEndOf="parent"
        app:layout_constraintBottom_toBottomOf="parent" />

</androidx.constraintlayout.widget.ConstraintLayout>
`;
}

function generateColorsXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="purple_200">#FFBB86FC</color>
    <color name="purple_500">#FF6200EE</color>
    <color name="purple_700">#FF3700B3</color>
    <color name="accent_soft">#FF9FCBFF</color>
    <color name="accent_primary">#FF194A72</color>
    <color name="black">#FF000000</color>
    <color name="white">#FFFFFFFF</color>
</resources>
`;
}

function generateStringsXml(config: ProjectConfig, template: ProjectTemplateId): string {
  const extra =
    template === "bottomnav"
      ? `    <string name="title_home">Home</string>\n    <string name="title_settings">Settings</string>\n`
      : "";
  return `<resources>
    <string name="app_name">${config.name}</string>
${extra}</resources>
`;
}

function generateVectorIcon(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M54,30 L74,70 L34,70 Z"/>
</vector>
`;
}

function generateReadme(config: ProjectConfig, template: ProjectTemplateId): string {
  return `# ${config.name}

Generated by **AI Builder** · template: \`${template}\`

- package: \`${config.packageName}\`
- minSdk: ${config.minSdk ?? 24}
- targetSdk: ${config.targetSdk ?? GENERATOR_TARGET_SDK_DEFAULT}
- Compose: ${isCompose(config) ? "yes" : "no"}

## Build (Termux)

\`\`\`bash
export ANDROID_HOME=$PREFIX/opt/android-sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
cd ${config.projectPath || "."}
bash gradlew assembleDebug --no-daemon
\`\`\`
`;
}
