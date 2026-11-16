import { useCallback, useEffect, useRef, useState } from "react";
import {
  StyleSheet,
  View,
  Text,
  NativeModules,
  Platform,
  ActivityIndicator,
  Linking,
  Share,
  Alert,
  DeviceEventEmitter,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../components/ThemeContext";
import { useLanguage } from "../components/LanguageContext";
import { isAllowedGithubToolHttpUrl, isTrustedGithubToolDocumentUrl } from "../lib/github-tool-security";
import { persistentLogger } from "../lib/persistent-logger";
import { createGithubToolMessageParser, createGithubToolOnMessage, createGithubToolReply, createGithubToolSessionSecretVault, routeGithubToolMessage, type GithubToolNativeModule } from "../lib/github-tool-bridge-host";

const GITHUB_BRIDGE_SOURCE_MARKER = "AIB_GITHUB_BRIDGE_FIX_V272_02";
const githubSessionSecretVault = createGithubToolSessionSecretVault();
function logGithubBridgeDiagnostic(stage: string) {
  persistentLogger.add("info", "GithubTool", `${GITHUB_BRIDGE_SOURCE_MARKER} ${stage}`, "app");
}

/**
 * GitHub under shared AI Builder header.
 * HTTP: bounded AibGithubTool native bridge (RN fetch only as old-build fallback).
 * Save: native MediaStore or expo share. Secrets: AibGithubTool.
 */
export default function GithubScreen() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [sessionOnly, setSessionOnly] = useState(() => githubSessionSecretVault.isSessionOnly());
  // The install-time Android WebView patch forwards the full current top-level document URL and
  // drops subframes. Keep the last allowlisted navigation as a consistency gate; never substitute it.
  const docUrlRef = useRef<string>("file:///android_asset/github-tool/repos.html");
  const webRef = useRef<{ injectJavaScript: (js: string) => void } | null>(null);
  const mod = NativeModules.AibGithubTool as GithubToolNativeModule | undefined;

  useEffect(() => {
    logGithubBridgeDiagnostic("source_marker_loaded");
    logGithubBridgeDiagnostic(`native.module.${mod?.secretGet && mod?.secretSet ? "available" : "unavailable"}`);
  }, []);

  // Native transfer callbacks (upload progress / completion) -> page globals used by releases.js.
  useEffect(() => {
    const allowed = new Set(["window.__ugProgress", "window.__ugDone", "window.__ugDownloadDone", "window.__ugPicked"]);
    const sub = DeviceEventEmitter.addListener("AibGithubToolEvent", (ev: { fn?: string; args?: string }) => {
      try {
        const fn = String(ev?.fn || "");
        if (!allowed.has(fn)) return;
        const args = JSON.parse(String(ev?.args || "[]"));
        if (!Array.isArray(args)) return;
        const call = `${fn}.apply(null,${JSON.stringify(args)})`;
        webRef.current?.injectJavaScript(`try{${call}}catch(e){};true;`);
      } catch { /* a stale event never breaks the screen */ }
    });
    return () => sub.remove();
  }, []);

  // Real system-bar inset (Android edge-to-edge): the page uses it so fixed bottom buttons never sit under nav keys.
  const bottomInset = Math.max(0, Math.round(insets.bottom || 0));
  const insetJs = `try{document.documentElement.style.setProperty('--aib-sab','${bottomInset}px');}catch(e){};true;`;
  useEffect(() => {
    try { webRef.current?.injectJavaScript(insetJs); } catch { /* ignore */ }
  }, [insetJs]);

  const confirmSessionOnly = useCallback((reason: string) => new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      if (accepted) setSessionOnly(true);
      resolve(accepted);
    };
    const reasonText = reason === "module_unavailable"
      ? "Нативный модуль защищённого хранилища не найден."
      : reason === "keystore_unavailable"
        ? "Android Keystore не смог подтвердить безопасную запись."
        : "Защищённое хранилище не подтвердило запись токена.";
    Alert.alert(
      "Защищённое хранилище недоступно",
      `${reasonText}\n\nМожно продолжить только в текущем сеансе: токен останется в оперативной памяти и будет удалён при закрытии или перезапуске AI Builder. Для следующего сеанса его потребуется ввести заново. На устройство он записан не будет.`,
      [
        { text: "Отмена", style: "cancel", onPress: () => finish(false) },
        { text: "Только этот сеанс", onPress: () => finish(true) },
      ],
      { cancelable: true, onDismiss: () => finish(false) },
    );
  }), []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let WebView: any = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    WebView = require("react-native-webview").WebView;
  } catch {
    WebView = null;
  }

  const reply = useCallback(createGithubToolReply(webRef), []);

  const saveFileRn = useCallback(async (name: string, mime: string, b64: string) => {
    // Prefer native module (MediaStore Downloads)
    if (mod?.saveFile) {
      await mod.saveFile(name, mime || "application/octet-stream", b64);
      return;
    }
    // Fallback: write cache + system share sheet
    const FileSystem = require("expo-file-system/legacy") as {
      cacheDirectory: string | null;
      writeAsStringAsync: (uri: string, data: string, opts: { encoding: string }) => Promise<void>;
      EncodingType: { Base64: string };
    };
    const Sharing = require("expo-sharing") as {
      isAvailableAsync: () => Promise<boolean>;
      shareAsync: (uri: string, opts?: { mimeType?: string; dialogTitle?: string }) => Promise<void>;
    };
    const dir = FileSystem.cacheDirectory || "";
    const safe = String(name || "file").replace(/[^\w.\-()+ ]+/g, "_").slice(0, 120) || "file";
    const uri = `${dir}aib-gh-${Date.now()}-${safe}`;
    await FileSystem.writeAsStringAsync(uri, String(b64).replace(/\s/g, ""), {
      encoding: FileSystem.EncodingType.Base64,
    });
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, {
        mimeType: mime || "application/octet-stream",
        dialogTitle: safe,
      });
    } else {
      throw new Error("Sharing unavailable");
    }
  }, [mod]);

  const routeMessage = useCallback(
    (event: { nativeEvent: { data: string; url?: string | null } }) => routeGithubToolMessage(event, {
      native: mod,
      sessionVault: githubSessionSecretVault,
      confirmSessionOnly,
      onSessionOnly: () => setSessionOnly(true),
      notifySecretsUpdated: () => {
        try {
          webRef.current?.injectJavaScript(
            `try{if(typeof window.__aibRehydrateGithubSecrets==="function")window.__aibRehydrateGithubSecrets();}catch(e){};true;`,
          );
        } catch { /* a navigated or unmounted WebView will hydrate on its next load */ }
      },
      parseMessage: createGithubToolMessageParser(logGithubBridgeDiagnostic),
      isAllowedHttpUrl: isAllowedGithubToolHttpUrl,
      reply,
      saveFile: saveFileRn,
      openUrl: (url) => Linking.openURL(url),
      shareText: (text, title) => Share.share({ message: text, title }),
      stage: logGithubBridgeDiagnostic,
      emitToWeb: (fn: string, args: unknown[]) => {
        if (!/^window\.__ug(?:Progress|Done|DownloadDone|Picked)$/.test(fn)) return;
        try { webRef.current?.injectJavaScript(`try{${fn}.apply(null,${JSON.stringify(args)})}catch(e){};true;`); } catch { /* ignore */ }
      },
    }),
    [mod, reply, saveFileRn, confirmSessionOnly],
  );
  const onMessage = useCallback(
    createGithubToolOnMessage(() => docUrlRef.current, routeMessage, logGithubBridgeDiagnostic),
    [routeMessage],
  );

  const injected = `
(function(){
  if (window.__aibBridge) return;
  window.__aibBridge = true;
  window.__aibDocumentId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  window.__aibSecretsReady = false;
  window.__aibSessionOnly = false;
  window.__aibSecretCache = Object.create(null);
  window.__aibCbs = {};
  window.__aibSeq = 0;
  function call(type, extra, timeoutMs, onRequestId) {
    return new Promise(function(resolve, reject) {
      var id = window.__aibDocumentId + ':c' + (++window.__aibSeq);
      try { if (typeof onRequestId === 'function') onRequestId(id); } catch(e) {}
      var settled = false;
      var timer = setTimeout(function() {
        if (settled) return;
        settled = true;
        try { delete window.__aibCbs[id]; } catch(e) {}
        reject(new Error('bridge timeout'));
      }, Math.max(1000, Math.min(Number(timeoutMs) || 20000, 90000)));
      window.__aibCbs[id] = {
        resolve: function(v) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(v);
        },
        reject: function(e) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      };
      var msg = Object.assign({}, extra || {}, { type: type, id: id, documentId: window.__aibDocumentId });
      try {
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify(msg));
        } else {
          settled = true;
          clearTimeout(timer);
          try { delete window.__aibCbs[id]; } catch(e) {}
          reject(new Error('no ReactNativeWebView'));
        }
      } catch (e) {
        settled = true;
        clearTimeout(timer);
        try { delete window.__aibCbs[id]; } catch(e2) {}
        reject(e);
      }
    });
  }
  window.__aibDiagnostic = function(stage, correlationId) {
    if (stage !== 'secretSet_reply_success' && stage !== 'secretSet_reply_failure' && stage !== 'secretSet_promise_rejected') return;
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        var message = { type: 'diag', stage: stage };
        if (typeof correlationId === 'string' && /^[a-z0-9]{1,16}-[a-z0-9]{8}:c[1-9][0-9]{0,9}$/.test(correlationId)) message.correlationId = correlationId;
        window.ReactNativeWebView.postMessage(JSON.stringify(message));
      }
    } catch(e) {}
  };
  window.__aibLog = function(text) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'log', text: String(text).slice(0, 300) }));
      }
    } catch (e) {}
  };
  window.__aibHttp = function(payload) {
    var wait = 20000;
    try {
      var p = JSON.parse(String(payload));
      var authCheck = !p.binary && p.url === 'https://api.github.com/user' && (!p.method || String(p.method).toUpperCase() === 'GET') && p.body == null;
      var slackMs = authCheck ? 15000 : 5000;
      var maxWaitMs = p.binary ? 185000 : (authCheck ? 30000 : 35000);
      wait = Math.min(Math.max(Number(p.timeoutMs) || (p.binary ? 120000 : 15000), 1000) + slackMs, maxWaitMs);
    } catch(e) {}
    return call('httpRequest', { payload: String(payload) }, wait);
  };
  window.__aibSaveFile = function(name, mime, b64) {
    return call('saveFile', { name: String(name||'file'), mime: String(mime||'application/octet-stream'), value: String(b64||'') }, 90000).then(function(r) {
      if (String(r).indexOf('0:') === 0) throw new Error(String(r).slice(2) || 'save failed');
      return true;
    });
  };
  window.AndroidInterface = {
    httpRequest: function() { throw new Error('use async __aibHttp'); },
    secretGet: function(k) {
      try { return window.__aibSecretCache[k] || ''; } catch (e) { return ''; }
    },
    secretSet: function(k, v, migration) {
      var value = String(v == null ? '' : v);
      window.__aibSecretWriteRollbackFailed = false;
      var correlationId = '';
      return call('secretSet', { name: k, value: value, migration: migration === true }, 90000, function(id) { correlationId = id; }).then(function(r) {
        var result = String(r);
        if (result !== '1' && result !== '1:session') {
          var failure = result.indexOf('0:') === 0 ? result.slice(2) : 'storage_unavailable';
          var safeFailures = ['module_unavailable','keystore_unavailable','storage_unavailable','rollback_failed','input_rejected'];
          window.__aibSecretWriteFailure = safeFailures.indexOf(failure) >= 0 ? failure : 'storage_unavailable';
          window.__aibSecretWriteRollbackFailed = window.__aibSecretWriteFailure === 'rollback_failed';
          window.__aibDiagnostic('secretSet_reply_failure', correlationId);
          throw new Error('Secure storage rejected the token');
        }
        try { window.__aibSecretCache[k] = value; } catch (e) {}
        window.__aibSecretWriteFailure = '';
        if (result === '1:session') window.__aibSessionOnly = true;
        window.__aibDiagnostic('secretSet_reply_success', correlationId);
        return true;
      }).catch(function(e) {
        window.__aibDiagnostic('secretSet_promise_rejected', correlationId);
        if (window.__aibSecretWriteRollbackFailed) try { alert('Не удалось сохранить токен: защищённое хранилище не подтвердило восстановление предыдущего значения. Старый активный токен в текущем сеансе не изменён; проверьте состояние подключения.'); } catch (e3) {}
        return false;
      });
    },
    secretDelete: function(k) {
      return call('secretDelete', { name: k }).then(function(r) {
        if (String(r) !== '1') throw new Error('Secure storage rejected token deletion');
        try { delete window.__aibSecretCache[k]; } catch (e) {}
        return true;
      }).catch(function(e) {
        try { alert('Не удалось удалить секрет из защищённого хранилища.'); } catch (e3) {}
        return false;
      });
    },
    saveFile: function(name, mime, b64) {
      // fire-and-forget async (saveToDevice is sync API)
      window.__aibSaveFile(name, mime, b64).then(function() {
        try { if (window.__aibToast) window.__aibToast('Сохранено: ' + name); } catch(e) {}
      }).catch(function(err) {
        try { alert('Не удалось сохранить: ' + (err && err.message ? err.message : err)); } catch(e) {}
      });
      return true;
    },
    pickFiles: function() {
      // Native file picker has no timeout: the user may browse for a long time.
      var id = window.__aibDocumentId + ':c' + (++window.__aibSeq);
      function finish(v) { try { if (typeof window.__ugPicked === 'function') window.__ugPicked(String(v || '[]')); } catch(e) {} }
      window.__aibCbs[id] = { resolve: finish, reject: function() { finish('[]'); } };
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'pickFiles', id: id, documentId: window.__aibDocumentId }));
      } catch (e) {
        try { delete window.__aibCbs[id]; } catch(e2) {}
        finish('[]');
      }
    },
    uploadAsset: function(id, url, token, name, mime) {
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'uploadAsset', transferId: String(id || ''), url: String(url || ''), token: String(token || ''),
          name: String(name || 'file'), mime: String(mime || 'application/octet-stream'), documentId: window.__aibDocumentId
        }));
      } catch (e) {
        try { if (typeof window.__ugDone === 'function') window.__ugDone(String(id || ''), 0, 'Не удалось передать файл в приложение'); } catch(e2) {}
      }
    },
    cancelTransfer: function(id) {
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'cancelTransfer', transferId: String(id || ''), documentId: window.__aibDocumentId }));
      } catch (e) {}
    },
    openUrl: function(u) {
      call('openUrl', { url: String(u || '') });
    },
    shareText: function(t, title) {
      call('shareText', { text: String(t||''), title: String(title||'') });
    },
    isOnline: function() { return navigator.onLine !== false; },
    showToast: function(m) {
      try { if (window.__aibToast) window.__aibToast(String(m||'')); } catch(e) {}
    },
    showError: function(m) { try { alert(String(m||'')); } catch(e) {} },
    keepScreenOn: function() {},
    closeHost: function() {},
    openAppMenu: function() {}
  };
  function signalSecretsReady() {
    window.__aibSecretsReady = true;
    try { window.dispatchEvent(new Event('aib-secrets-ready')); } catch (e) {}
  }
  function hydrateSecrets() {
    window.__aibSecretsReady = false;
    return Promise.all(['unzipgit_token','unzipgit_tokens','unzipgit_apikeys'].map(function(k) {
    return call('secretGet', { name: k }).then(function(v) {
      if (v) {
        try { window.__aibSecretCache[k] = v; } catch (e) {}
        try { localStorage.removeItem(k); localStorage.removeItem('aib_sec_' + k); } catch (e2) {}
      } else { try { delete window.__aibSecretCache[k]; } catch (e3) {} }
    }).catch(function(){});
    })).then(signalSecretsReady, signalSecretsReady);
  }
  window.__aibRehydrateGithubSecrets = hydrateSecrets;
  window.__aibWhenSecretsReady = function(fn) {
    if (typeof fn !== 'function') return;
    window.addEventListener('aib-secrets-ready', fn);
    if (window.__aibSecretsReady) setTimeout(fn, 0);
  };
  window.__aibSecretsReadyPromise = hydrateSecrets();
})();
true;
`;

  if (Platform.OS !== "android") {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.muted }}>{t("githubOnlyAndroid")}</Text>
      </View>
    );
  }

  if (!WebView) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.danger, padding: 16, textAlign: "center" }}>
          {t("githubWebViewMissing")}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {!ready ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#2F4F4F" />
        </View>
      ) : null}
      {sessionOnly ? (
        <View style={[styles.sessionBanner, { backgroundColor: colors.warning }]}>
          <Text style={[styles.sessionBannerText, { color: colors.onWarning }]}>Токен хранится только в памяти текущего сеанса. После закрытия или перезапуска AI Builder его нужно ввести снова.</Text>
        </View>
      ) : null}
      {error ? <Text style={[styles.err, { color: colors.danger }]}>{error}</Text> : null}
      <WebView
        ref={webRef}
        style={styles.web}
        source={{ uri: "file:///android_asset/github-tool/repos.html" }}
        originWhitelist={["file://*"]}
        onShouldStartLoadWithRequest={(request: { url: string }) => {
          const trusted = isTrustedGithubToolDocumentUrl(request.url);
          if (trusted) docUrlRef.current = request.url;
          return trusted;
        }}
        onNavigationStateChange={(nav: { url?: string }) => {
          if (isTrustedGithubToolDocumentUrl(nav?.url)) docUrlRef.current = nav.url as string;
        }}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        setSupportMultipleWindows={false}
        onMessage={onMessage}
        injectedJavaScriptBeforeContentLoaded={injected + insetJs}
        injectedJavaScript={injected + insetJs}
        onLoadEnd={() => {
          setReady(true);
          try {
            webRef.current?.injectJavaScript(injected);
            webRef.current?.injectJavaScript(insetJs);
          } catch {
            /* ignore */
          }
        }}
        onError={(e: { nativeEvent?: { description?: string } }) =>
          setError(`${t("githubWebViewError")}: ${e?.nativeEvent?.description || ""}`.trim())
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  web: { flex: 1, backgroundColor: "#101418" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20 },
  loading: { position: "absolute", top: 8, alignSelf: "center", zIndex: 2 },
  sessionBanner: { paddingHorizontal: 12, paddingVertical: 8 },
  sessionBannerText: { fontSize: 12 },
  err: { padding: 8, fontSize: 12 },
});
