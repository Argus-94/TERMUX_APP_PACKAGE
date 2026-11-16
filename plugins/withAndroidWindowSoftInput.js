const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

function withAndroidWindowSoftInput(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const manifestPath = path.join(config.modRequest.platformProjectRoot, "app/src/main/AndroidManifest.xml");
      if (!fs.existsSync(manifestPath)) return config;
      let text = fs.readFileSync(manifestPath, "utf8");

      if (text.includes('android:windowSoftInputMode')) {
        text = text.replace(
          /android:windowSoftInputMode="[^"]*"/,
          'android:windowSoftInputMode="adjustResize"'
        );
      } else if (text.includes('<activity')) {
        text = text.replace(
          /(<activity[^>]*android:name="\.MainActivity"[^>]*?)>/,
          '$1 android:windowSoftInputMode="adjustResize">'
        );
      }

      fs.writeFileSync(manifestPath, text, "utf8");
      return config;
    }
  ]);
}

module.exports = withAndroidWindowSoftInput;
