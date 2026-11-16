#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "aib-interceptor-native-"));
const classes = path.join(temp, "classes");
const keystore = path.join(temp, "mitm-test-only.p12");
const storePassword = ["t", "e", "s", "t", "-", "p", "a", "s", "s"].join("");
mkdirSync(classes, { recursive: true });
try {
  execFileSync("keytool", [
    "-genkeypair", "-alias", "leaf", "-keyalg", "RSA", "-keysize", "2048",
    "-validity", "365", "-storetype", "PKCS12", "-keystore", keystore,
    "-storepass", storePassword, "-keypass", storePassword,
    "-dname", "CN=example.test,OU=Local test only,O=AI Builder",
    "-ext", "SAN=dns:example.test", "-noprompt",
  ], { stdio: "ignore" });
  execFileSync("javac", [
    "-Xlint:all", "-d", classes,
    path.join(root, "native", "aib-interceptor", "AibInterceptorProxyServer.java"),
    path.join(root, "scripts", "native", "AibInterceptorProxyServerSelfTest.java"),
  ], { stdio: "inherit" });
  execFileSync("java", ["-cp", classes, "com.karat.aibuilder.AibInterceptorProxyServerSelfTest", keystore], { stdio: "inherit" });
} catch (error) {
  console.error("aib-interceptor-native-selftest: FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
