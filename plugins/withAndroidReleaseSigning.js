const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const SIGNING_MARKER = "// AIB_RELEASE_SIGNING_ENV_V1";
const HARDENING_MARKER = "// AIB_RELEASE_R8_HARDENING_V1";
const REQUIRED_SIGNATURE_SCHEMES = ["enableV1Signing", "enableV2Signing", "enableV3Signing"];

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let mode = "code";
  let quote = "";
  let escaped = false;

  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (mode === "line-comment") {
      if (ch === "\n") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      if (ch === "*" && next === "/") {
        mode = "code";
        i += 1;
      }
      continue;
    }
    if (mode === "string") {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        mode = "code";
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      mode = "line-comment";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      mode = "block-comment";
      i += 1;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      mode = "string";
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
      if (depth < 0) throw new Error("AIB_RELEASE_SIGNING_GRADLE_BRACES_INVALID");
    }
  }

  throw new Error("AIB_RELEASE_SIGNING_GRADLE_BLOCK_UNCLOSED");
}

function findBlock(source, name, fromIndex = 0, beforeIndex = source.length) {
  const expression = new RegExp(`\\b${name}\\s*\\{`, "g");
  expression.lastIndex = fromIndex;
  let match;
  while ((match = expression.exec(source)) && match.index < beforeIndex) {
    const openIndex = match.index + match[0].lastIndexOf("{");
    const closeIndex = findMatchingBrace(source, openIndex);
    if (closeIndex < beforeIndex) return { start: match.index, open: openIndex, close: closeIndex };
    expression.lastIndex = openIndex + 1;
  }
  return null;
}

function releaseLocation(source) {
  const buildTypes = findBlock(source, "buildTypes");
  if (!buildTypes) throw new Error("AIB_RELEASE_SIGNING_BUILD_TYPES_MISSING");
  const release = findBlock(source, "release", buildTypes.open + 1, buildTypes.close);
  if (!release) throw new Error("AIB_RELEASE_SIGNING_RELEASE_BUILD_TYPE_MISSING");
  const lineStart = source.lastIndexOf("\n", release.start - 1) + 1;
  const releaseIndent = source.slice(lineStart, release.start).match(/^[\t ]*/)?.[0] ?? "";
  return { release, releaseIndent, propertyIndent: `${releaseIndent}    ` };
}

function ensureReleaseSigning(source) {
  if (source.includes(SIGNING_MARKER)) {
    if (!source.includes("signingConfig signingConfigs.release") || !source.includes("AIB_RELEASE_SIGNING_CREDENTIALS_REQUIRED")) {
      throw new Error("AIB_RELEASE_SIGNING_MARKER_CONTENT_INVALID");
    }
    const markerIndex = source.indexOf(SIGNING_MARKER);
    const markedRelease = findBlock(source, "release", markerIndex + SIGNING_MARKER.length);
    if (!markedRelease) throw new Error("AIB_RELEASE_SIGNING_MARKER_CONTENT_INVALID");
    const lineStart = source.lastIndexOf("\n", markedRelease.start - 1) + 1;
    const blockIndent = source.slice(lineStart, markedRelease.start).match(/^[\t ]*/)?.[0] ?? "";
    let signingReleaseBlock = source.slice(markedRelease.start, markedRelease.close + 1);
    for (const scheme of REQUIRED_SIGNATURE_SCHEMES) {
      signingReleaseBlock = setReleaseBoolean(signingReleaseBlock, scheme, `${blockIndent}  `);
    }
    return source.slice(0, markedRelease.start) + signingReleaseBlock + source.slice(markedRelease.close + 1);
  }

  const { release, releaseIndent, propertyIndent } = releaseLocation(source);
  const signingConfigs = findBlock(source, "signingConfigs");
  if (!signingConfigs) throw new Error("AIB_RELEASE_SIGNING_CONFIGS_MISSING");
  if (findBlock(source, "release", signingConfigs.open + 1, signingConfigs.close)) {
    throw new Error("AIB_RELEASE_SIGNING_RELEASE_CONFIG_ALREADY_EXISTS");
  }

  let releaseBlock = source.slice(release.start, release.close + 1);
  const signingLines = [...releaseBlock.matchAll(/^[\t ]*signingConfig\s*(?:=\s*)?([^\r\n]+)$/gm)];
  if (signingLines.length > 1) throw new Error("AIB_RELEASE_SIGNING_DUPLICATE_CONFIG");
  if (signingLines.length === 1) {
    const existing = signingLines[0][1].trim();
    if (existing !== "signingConfigs.debug" && existing !== "signingConfigs.release") {
      throw new Error("AIB_RELEASE_SIGNING_CONFIG_UNEXPECTED");
    }
    const lineStart = signingLines[0].index;
    releaseBlock = releaseBlock.slice(0, lineStart)
      + `${propertyIndent}signingConfig signingConfigs.release`
      + releaseBlock.slice(lineStart + signingLines[0][0].length);
  } else {
    const openBrace = releaseBlock.indexOf("{");
    releaseBlock = releaseBlock.slice(0, openBrace + 1)
      + `\n${propertyIndent}signingConfig signingConfigs.release`
      + releaseBlock.slice(openBrace + 1);
  }

  let transformed = source.slice(0, release.start) + releaseBlock + source.slice(release.close + 1);
  const adjustedConfigs = findBlock(transformed, "signingConfigs");
  if (!adjustedConfigs) throw new Error("AIB_RELEASE_SIGNING_CONFIGS_MISSING");
  const signingBlock = `\n${releaseIndent}    ${SIGNING_MARKER}\n${releaseIndent}    release {\n`
    + `${releaseIndent}      enableV1Signing true\n`
    + `${releaseIndent}      enableV2Signing true\n`
    + `${releaseIndent}      enableV3Signing true\n`
    + `${releaseIndent}      def aibReleaseRequested = gradle.startParameter.taskNames.any { it.toLowerCase().contains("release") }\n`
    + `${releaseIndent}      def aibReleaseStoreFile = System.getenv("AIB_RELEASE_STORE_FILE")\n`
    + `${releaseIndent}      def aibReleaseStorePassword = System.getenv("AIB_RELEASE_STORE_PASSWORD")\n`
    + `${releaseIndent}      def aibReleaseKeyAlias = System.getenv("AIB_RELEASE_KEY_ALIAS")\n`
    + `${releaseIndent}      def aibReleaseKeyPassword = System.getenv("AIB_RELEASE_KEY_PASSWORD")\n`
    + `${releaseIndent}      def aibReleaseCredentialsMissing = [aibReleaseStoreFile, aibReleaseStorePassword, aibReleaseKeyAlias, aibReleaseKeyPassword].any { it == null || it.trim().isEmpty() }\n`
    + `${releaseIndent}      if (aibReleaseRequested && (aibReleaseCredentialsMissing || aibReleaseKeyAlias != "karat")) {\n`
    + `${releaseIndent}        throw new GradleException("AIB_RELEASE_SIGNING_CREDENTIALS_REQUIRED")\n`
    + `${releaseIndent}      }\n`
    + `${releaseIndent}      if (!aibReleaseCredentialsMissing && aibReleaseKeyAlias == "karat") {\n`
    + `${releaseIndent}        def aibReleaseKeyFile = new File(aibReleaseStoreFile)\n`
    + `${releaseIndent}        if (aibReleaseRequested && !aibReleaseKeyFile.isFile()) {\n`
    + `${releaseIndent}          throw new GradleException("AIB_RELEASE_SIGNING_KEYSTORE_UNAVAILABLE")\n`
    + `${releaseIndent}        }\n`
    + `${releaseIndent}        storeFile aibReleaseKeyFile\n`
    + `${releaseIndent}        storePassword aibReleaseStorePassword\n`
    + `${releaseIndent}        keyAlias aibReleaseKeyAlias\n`
    + `${releaseIndent}        keyPassword aibReleaseKeyPassword\n`
    + `${releaseIndent}      }\n`
    + `${releaseIndent}    }\n`;
  transformed = transformed.slice(0, adjustedConfigs.close) + signingBlock + transformed.slice(adjustedConfigs.close);

  if (!transformed.includes(SIGNING_MARKER) || !transformed.includes("signingConfig signingConfigs.release")) {
    throw new Error("AIB_RELEASE_SIGNING_PATCH_INCOMPLETE");
  }
  return transformed;
}

function setReleaseBoolean(releaseBlock, name, propertyIndent) {
  const expression = new RegExp(`^[\\t ]*(?:is)?${name}\\s*(?:=\\s*)?[^\\r\\n]*$`, "gm");
  const matches = [...releaseBlock.matchAll(expression)];
  if (matches.length > 1) throw new Error(`AIB_RELEASE_R8_DUPLICATE_${name.toUpperCase()}`);
  if (matches.length === 1) {
    const line = matches[0][0];
    const indent = line.match(/^[\t ]*/)?.[0] ?? propertyIndent;
    return releaseBlock.slice(0, matches[0].index)
      + `${indent}${name} true`
      + releaseBlock.slice(matches[0].index + line.length);
  }
  const openBrace = releaseBlock.indexOf("{");
  if (openBrace < 0) throw new Error("AIB_RELEASE_R8_RELEASE_BLOCK_INVALID");
  return releaseBlock.slice(0, openBrace + 1)
    + `\n${propertyIndent}${name} true`
    + releaseBlock.slice(openBrace + 1);
}

function ensureOptimizedProguardFiles(releaseBlock, propertyIndent) {
  const matches = [...releaseBlock.matchAll(/^[\t ]*proguardFiles\b[^\r\n]*$/gm)];
  if (matches.length > 1) throw new Error("AIB_RELEASE_R8_PROGUARD_FILES_SHAPE_UNSUPPORTED");
  const canonical = `${propertyIndent}proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"`;
  if (matches.length === 0) {
    const openBrace = releaseBlock.indexOf("{");
    if (openBrace < 0) throw new Error("AIB_RELEASE_R8_RELEASE_BLOCK_INVALID");
    return releaseBlock.slice(0, openBrace + 1)
      + `\n${canonical}`
      + releaseBlock.slice(openBrace + 1);
  }

  let line = matches[0][0];
  const indent = line.match(/^[\t ]*/)?.[0] ?? propertyIndent;
  if (/getDefaultProguardFile\s*\(/.test(line)) {
    const defaultCall = line.match(/getDefaultProguardFile\(\s*(["'])([^"']+)\1\s*\)/);
    if (!defaultCall) throw new Error("AIB_RELEASE_R8_PROGUARD_DEFAULT_FILE_UNSUPPORTED");
    line = line.replace(defaultCall[0], `getDefaultProguardFile(${defaultCall[1]}proguard-android-optimize.txt${defaultCall[1]})`);
  } else if (!line.includes("proguard-android-optimize.txt")) {
    line = line.replace(/\bproguardFiles\b/, `proguardFiles getDefaultProguardFile("proguard-android-optimize.txt")`);
  }
  if (!line.includes("proguard-rules.pro")) line += ', "proguard-rules.pro"';
  line = `${indent}${line.trimStart()}`;
  return releaseBlock.slice(0, matches[0].index)
    + line
    + releaseBlock.slice(matches[0].index + matches[0][0].length);
}

function ensureReleaseHardening(source) {
  const { release, propertyIndent } = releaseLocation(source);
  let releaseBlock = source.slice(release.start, release.close + 1);
  if (releaseBlock.includes(HARDENING_MARKER)) {
    const minify = [...releaseBlock.matchAll(/^[\t ]*minifyEnabled\s+true\s*$/gm)];
    const shrink = [...releaseBlock.matchAll(/^[\t ]*shrinkResources\s+true\s*$/gm)];
    const proguard = [...releaseBlock.matchAll(/^[\t ]*proguardFiles\b[^\r\n]*$/gm)];
    if (minify.length !== 1 || shrink.length !== 1 || proguard.length !== 1
      || !proguard[0][0].includes("proguard-android-optimize.txt")
      || !proguard[0][0].includes("proguard-rules.pro")) {
      throw new Error("AIB_RELEASE_R8_HARDENING_MARKER_CONTENT_INVALID");
    }
    return source;
  }

  releaseBlock = setReleaseBoolean(releaseBlock, "minifyEnabled", propertyIndent);
  releaseBlock = setReleaseBoolean(releaseBlock, "shrinkResources", propertyIndent);
  releaseBlock = ensureOptimizedProguardFiles(releaseBlock, propertyIndent);
  const openBrace = releaseBlock.indexOf("{");
  releaseBlock = releaseBlock.slice(0, openBrace + 1)
    + `\n${propertyIndent}${HARDENING_MARKER}`
    + releaseBlock.slice(openBrace + 1);
  return source.slice(0, release.start) + releaseBlock + source.slice(release.close + 1);
}

function ensureArm64OnlyAbiFilter(source) {
  const android = findBlock(source, "android");
  if (!android) throw new Error("AIB_RELEASE_ABI_ANDROID_BLOCK_MISSING");
  const defaultConfig = findBlock(source, "defaultConfig", android.open + 1, android.close);
  if (!defaultConfig) throw new Error("AIB_RELEASE_ABI_DEFAULT_CONFIG_MISSING");
  const defaultConfigSource = source.slice(defaultConfig.start, defaultConfig.close + 1);
  const ndkMatches = [...defaultConfigSource.matchAll(/\bndk\s*\{/g)];
  if (ndkMatches.length > 1) throw new Error("AIB_RELEASE_ABI_DUPLICATE_NDK_BLOCK");
  const lineStart = source.lastIndexOf("\n", defaultConfig.start - 1) + 1;
  const defaultIndent = source.slice(lineStart, defaultConfig.start).match(/^[\t ]*/)?.[0] ?? "";
  const ndkIndent = `${defaultIndent}    `;

  if (ndkMatches.length === 0) {
    const closingLineStart = source.lastIndexOf("\n", defaultConfig.close - 1) + 1;
    const insertion = `${ndkIndent}ndk {\n`
      + `${ndkIndent}    // AIB_RELEASE_ABI_ARM64_ONLY_V1\n`
      + `${ndkIndent}    abiFilters "arm64-v8a"\n`
      + `${ndkIndent}}\n`;
    return source.slice(0, closingLineStart) + insertion + source.slice(closingLineStart);
  }

  const ndk = findBlock(defaultConfigSource, "ndk");
  if (!ndk) throw new Error("AIB_RELEASE_ABI_NDK_BLOCK_INVALID");
  const ndkOpen = defaultConfig.start + ndk.open;
  const ndkClose = defaultConfig.start + ndk.close;
  const body = source.slice(ndkOpen + 1, ndkClose);
  const cleanBody = body
    .replace(/^[\t ]*\/\/ AIB_RELEASE_ABI_ARM64_ONLY_V1[^\r\n]*\r?\n?/gm, "")
    .replace(/^[\t ]*abiFilters\b[^\r\n]*\r?\n?/gm, "")
    .replace(/\s*$/, "");
  const ndkLineStart = source.lastIndexOf("\n", ndkOpen - 1) + 1;
  const ndkBlockIndent = source.slice(ndkLineStart, ndkOpen).match(/^[\t ]*/)?.[0] ?? ndkIndent;
  const filterIndent = `${ndkBlockIndent}    `;
  const normalizedBody = `${cleanBody}\n${filterIndent}// AIB_RELEASE_ABI_ARM64_ONLY_V1\n`
    + `${filterIndent}abiFilters "arm64-v8a"\n${ndkBlockIndent}`;
  return source.slice(0, ndkOpen + 1) + normalizedBody + source.slice(ndkClose);
}

function transformBuildGradle(source) {
  if (typeof source !== "string") throw new Error("AIB_RELEASE_SIGNING_GRADLE_SOURCE_INVALID");
  const releaseConfig = ensureReleaseHardening(ensureReleaseSigning(source));
  return ensureArm64OnlyAbiFilter(releaseConfig);
}

function withAndroidReleaseSigning(config) {
  return withDangerousMod(config, ["android", async (modConfig) => {
    const buildGradlePath = path.join(modConfig.modRequest.platformProjectRoot, "app", "build.gradle");
    if (!fs.existsSync(buildGradlePath)) throw new Error("AIB_RELEASE_SIGNING_GRADLE_MISSING");
    const source = fs.readFileSync(buildGradlePath, "utf8");
    const transformed = transformBuildGradle(source);
    if (transformed !== source) fs.writeFileSync(buildGradlePath, transformed, "utf8");
    return modConfig;
  }]);
}

module.exports = withAndroidReleaseSigning;
module.exports.transformBuildGradle = transformBuildGradle;
