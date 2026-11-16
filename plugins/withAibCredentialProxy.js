const { withMainApplication, withDangerousMod, withAndroidManifest } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">[::1]</domain>
  </domain-config>
</network-security-config>
`;

/** Install the loopback-only credential proxy module into generated Android sources. */
function withAibCredentialProxy(config) {
  config = withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (!application) throw new Error("[withAibCredentialProxy] Android application element is missing");
    application.$ = application.$ || {};
    application.$["android:networkSecurityConfig"] = "@xml/aib_network_security_config";
    return config;
  });

  config = withDangerousMod(config, ["android", async (config) => {
    const source = path.join(config.modRequest.projectRoot, "native", "aib-credential-proxy");
    const pkg = String(config.android?.package || "com.karat.aibuilder");
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(pkg)) {
      throw new Error("[withAibCredentialProxy] Invalid Android Java package");
    }
    const destination = path.join(config.modRequest.platformProjectRoot, "app", "src", "main", "java", ...pkg.split("."));
    const files = ["AibCredentialHttpProxyServer.java", "AibCredentialProxyModule.kt", "AibCredentialProxyPackage.kt"];
    for (const name of files) {
      const from = path.join(source, name);
      if (!fs.existsSync(from)) throw new Error(`[withAibCredentialProxy] Required source missing: ${name}`);
      fs.mkdirSync(destination, { recursive: true });
      fs.copyFileSync(from, path.join(destination, name));
    }

    const xmlDestination = path.join(config.modRequest.platformProjectRoot, "app", "src", "main", "res", "xml", "aib_network_security_config.xml");
    fs.mkdirSync(path.dirname(xmlDestination), { recursive: true });
    fs.writeFileSync(xmlDestination, NETWORK_SECURITY_CONFIG, "utf8");
    return config;
  }]);

  config = withMainApplication(config, (config) => {
    let contents = config.modResults.contents;
    if (contents.includes("AibCredentialProxyPackage()")) return config;
    const isKotlin = config.modResults.language === "kt";
    const registration = isKotlin ? "add(AibCredentialProxyPackage())" : "packages.add(new AibCredentialProxyPackage());";
    if (isKotlin && contents.includes("PackageList(this).packages.apply {")) {
      contents = contents.replace("PackageList(this).packages.apply {", `PackageList(this).packages.apply {\n              ${registration}`);
    } else if (isKotlin && contents.includes("val packages = PackageList(this).packages")) {
      contents = contents.replace("val packages = PackageList(this).packages", `val packages = PackageList(this).packages\n            packages.add(AibCredentialProxyPackage())`);
    } else if (!isKotlin && contents.includes("List<ReactPackage> packages = new PackageList(this).getPackages();")) {
      contents = contents.replace("List<ReactPackage> packages = new PackageList(this).getPackages();", `List<ReactPackage> packages = new PackageList(this).getPackages();\n      ${registration}`);
    } else {
      throw new Error("[withAibCredentialProxy] Could not find MainApplication package registration point");
    }
    config.modResults.contents = contents;
    return config;
  });
  return config;
}

module.exports = withAibCredentialProxy;
