const { withAndroidManifest, withDangerousMod, withMainApplication } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');
const { assertRequiredNativeSourceAssets } = require('./native-source-manifest.cjs');

module.exports = function withAibAccessibility(config) {
  config = withDangerousMod(config, ['android', async (cfg) => {
    assertRequiredNativeSourceAssets(cfg.modRequest.projectRoot);
    const pkg = cfg.android?.package || 'com.karat.aibuilder';
    const root = cfg.modRequest.platformProjectRoot;
    const sourceRoot = path.join(cfg.modRequest.projectRoot, 'plugins', 'android');
    const javaDir = path.join(root, 'app/src/main/java', pkg.replace(/\./g, '/'));
    const resDir = path.join(root, 'app/src/main/res');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.mkdirSync(path.join(resDir, 'xml'), { recursive: true });
    fs.mkdirSync(path.join(resDir, 'values'), { recursive: true });
    for (const file of ['AibAccessibilityService.kt', 'AibAccessibilityModule.kt', 'AibAccessibilityPackage.kt', 'AibLoopbackServer.kt', 'AibMemoryPressureModule.kt', 'AibMemoryPressurePackage.kt']) {
      const source = fs.readFileSync(path.join(sourceRoot, file), 'utf8').replaceAll('__PACKAGE__', pkg);
      fs.writeFileSync(path.join(javaDir, file), source);
    }
    const loopbackPath = path.join(javaDir, 'AibLoopbackServer.kt');
    let loopbackSource = fs.readFileSync(loopbackPath, 'utf8');
    const getRouteMarker = '"GET /v1/status", "GET /v1/screen/tree", "GET /v1/adb/list", "GET /v1/virtualdisplay/capture",';
    const getRoutes = '"GET /v1/status", "GET /v1/screen/tree", "GET /v1/adb/list", "GET /v1/adb/reconnect", "GET /v1/virtualdisplay/status", "GET /v1/virtualdisplay/displays", "GET /v1/virtualdisplay/capture",';
    if (!loopbackSource.includes('"GET /v1/adb/reconnect"')) {
      if (!loopbackSource.includes(getRouteMarker)) throw new Error('[withAibAccessibility] Loopback GET route marker missing from canonical source');
      loopbackSource = loopbackSource.replace(getRouteMarker, getRoutes);
    }
    const postRouteMarker = '"POST /v1/adb/pair", "POST /v1/adb/connect", "POST /v1/files/read", "POST /v1/sensors/read"';
    const postRoutes = `${postRouteMarker}, "POST /v1/virtualdisplay/tree", "POST /v1/virtualdisplay/capture", "POST /v1/virtualdisplay/input"`;
    if (!loopbackSource.includes('"POST /v1/virtualdisplay/tree"')) {
      if (!loopbackSource.includes(postRouteMarker)) throw new Error('[withAibAccessibility] Loopback POST route marker missing from canonical source');
      loopbackSource = loopbackSource.replace(postRouteMarker, postRoutes);
    }
    fs.writeFileSync(loopbackPath, loopbackSource);
    fs.copyFileSync(path.join(sourceRoot, 'aib_accessibility_service.xml'), path.join(resDir, 'xml', 'aib_accessibility_service.xml'));
    fs.writeFileSync(path.join(resDir, 'values', 'aib_accessibility_strings.xml'), '<resources><string name="aib_accessibility_service_description">AI Builder can inspect and interact with the screen only after you enable this service in Android Settings.</string></resources>\n');
    return cfg;
  }]);
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (!app) throw new Error('[withAibAccessibility] Android application manifest missing');
    app.service = app.service || [];
    if (!app.service.some((entry) => entry.$?.['android:name'] === '.AibAccessibilityService')) {
      app.service.push({ $: {
        'android:name': '.AibAccessibilityService',
        'android:label': 'AI Builder accessibility',
        'android:permission': 'android.permission.BIND_ACCESSIBILITY_SERVICE',
        'android:exported': 'true'
      }, 'intent-filter': [{ action: [{ $: { 'android:name': 'android.accessibilityservice.AccessibilityService' } }] }], 'meta-data': [{ $: { 'android:name': 'android.accessibilityservice', 'android:resource': '@xml/aib_accessibility_service' } }] });
    }
    return cfg;
  });
  config = withMainApplication(config, (cfg) => {
    let source = cfg.modResults.contents;
    for (const packageName of ['AibAccessibilityPackage', 'AibMemoryPressurePackage']) {
      if (source.includes(`${packageName}()`) || source.includes(`new ${packageName}()`)) continue;
      if (cfg.modResults.language === 'kt') {
        const applyPattern = /(PackageList\s*\(\s*this\s*\)\s*\.packages)(\s*\.toMutableList\s*\(\s*\))?(\s*\.apply\s*\{)/;
        const applyMatch = source.match(applyPattern);
        if (applyMatch) source = source.replace(applyPattern, `${applyMatch[1]}${applyMatch[2] || '.toMutableList()'}${applyMatch[3]}\n              add(${packageName}())`);
        else if (source.includes('val packages = PackageList(this).packages')) source = source.replace('val packages = PackageList(this).packages', `val packages = PackageList(this).packages\n            packages.add(${packageName}())`);
        else throw new Error(`[withAibAccessibility] MainApplication package list not found while registering ${packageName}`);
      } else {
        const marker = 'List<ReactPackage> packages = new PackageList(this).getPackages();';
        if (!source.includes(marker)) throw new Error(`[withAibAccessibility] MainApplication package list not found while registering ${packageName}`);
        source = source.replace(marker, marker + `\n      packages.add(new ${packageName}());`);
      }
    }
    cfg.modResults.contents = source;
    return cfg;
  });
  return config;
};
