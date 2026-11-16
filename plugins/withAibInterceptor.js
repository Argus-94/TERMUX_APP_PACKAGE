const { withAppBuildGradle, withDangerousMod, withMainApplication } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

/** Install the loopback-only interceptor native module; never edits Android network trust policy. */
function withAibInterceptor(config) {
  config = withDangerousMod(config, ["android", async (config) => {
    const source = path.join(config.modRequest.projectRoot, "native", "aib-interceptor");
    const pkg = String(config.android?.package || "com.karat.aibuilder");
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(pkg)) {
      throw new Error("[withAibInterceptor] Invalid Android Java package");
    }
    const destination = path.join(config.modRequest.platformProjectRoot, "app", "src", "main", "java", ...pkg.split("."));
    const files = [
      "AibInterceptorProxyServer.java",
      "AibInterceptorCertificateStore.kt",
      "AibInterceptorProxyModule.kt",
      "AibInterceptorProxyPackage.kt",
    ];
    fs.mkdirSync(destination, { recursive: true });
    for (const name of files) {
      const from = path.join(source, name);
      if (!fs.existsSync(from)) throw new Error(`[withAibInterceptor] Required source missing: ${name}`);
      fs.copyFileSync(from, path.join(destination, name));
    }
    return config;
  }]);

  config = withMainApplication(config, (config) => {
    let contents = config.modResults.contents;
    if (contents.includes("AibInterceptorProxyPackage()")) return config;
    const isKotlin = config.modResults.language === "kt";
    if (isKotlin && contents.includes("PackageList(this).packages.apply {")) {
      contents = contents.replace("PackageList(this).packages.apply {", "PackageList(this).packages.apply {\n              add(AibInterceptorProxyPackage())");
    } else if (isKotlin && contents.includes("val packages = PackageList(this).packages")) {
      contents = contents.replace("val packages = PackageList(this).packages", "val packages = PackageList(this).packages\n            packages.add(AibInterceptorProxyPackage())");
    } else if (!isKotlin && contents.includes("List<ReactPackage> packages = new PackageList(this).getPackages();")) {
      contents = contents.replace("List<ReactPackage> packages = new PackageList(this).getPackages();", "List<ReactPackage> packages = new PackageList(this).getPackages();\n      packages.add(new AibInterceptorProxyPackage());");
    } else {
      throw new Error("[withAibInterceptor] Could not find MainApplication package registration point");
    }
    config.modResults.contents = contents;
    return config;
  });

  config = withAppBuildGradle(config, (config) => {
    let contents = config.modResults.contents;
    const dependencies = [
      "implementation 'com.squareup.okhttp3:okhttp:4.12.0'",
      "implementation 'com.squareup.okhttp3:okhttp-tls:4.12.0'",
    ];
    const missing = dependencies.filter((dependency) => !contents.includes(dependency));
    if (missing.length) {
      const marker = "dependencies {";
      const at = contents.indexOf(marker);
      if (at < 0) throw new Error("[withAibInterceptor] Could not find app Gradle dependencies block");
      const insertion = `${marker}\n    ${missing.join("\n    ")}`;
      contents = contents.slice(0, at) + contents.slice(at).replace(marker, insertion);
      config.modResults.contents = contents;
    }
    return config;
  });
  return config;
}

module.exports = withAibInterceptor;
