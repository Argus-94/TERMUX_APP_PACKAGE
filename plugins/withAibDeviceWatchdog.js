const { withAndroidManifest, withMainApplication, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

function moduleKotlin(pkg) { return `package ${pkg}

import android.content.Intent
import android.content.Context
import android.os.Build
import android.os.PowerManager
import com.facebook.react.bridge.*

class AibDeviceWatchdogModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "AibDeviceWatchdog"

  @ReactMethod
  fun start(promise: Promise) {
    try {
      val intent = Intent(context, AibDeviceWatchdogService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
      promise.resolve(true)
    } catch (e: Exception) { promise.reject("AIB_WATCHDOG_START", e.message, e) }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try { promise.resolve(context.stopService(Intent(context, AibDeviceWatchdogService::class.java))) }
    catch (e: Exception) { promise.reject("AIB_WATCHDOG_STOP", e.message, e) }
  }

  @ReactMethod
  fun isIgnoringBatteryOptimizations(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
        promise.resolve(true)
        return
      }
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      promise.resolve(power.isIgnoringBatteryOptimizations(context.packageName))
    } catch (e: Exception) {
      promise.reject("AIB_BATTERY_STATUS", e.message, e)
    }
  }
}
` }
function packageKotlin(pkg) { return `package ${pkg}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.uimanager.ViewManager

class AibDeviceWatchdogPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(AibDeviceWatchdogModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
` }
function serviceKotlin(pkg) { return `package ${pkg}

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import java.util.concurrent.Executors

/** Lightweight native watchdog for an active device/ADB session. */
class AibDeviceWatchdogService : Service() {
  private val executor = Executors.newSingleThreadScheduledExecutor()
  override fun onCreate() {
    super.onCreate()
    val channelId = "aib-device-watchdog"
    if (Build.VERSION.SDK_INT >= 26) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(channelId, "AI Builder device session", NotificationManager.IMPORTANCE_LOW)
      )
    }
    val notification: Notification = NotificationCompat.Builder(this, channelId)
      .setSmallIcon(android.R.drawable.stat_sys_warning)
      .setContentTitle("AI Builder")
      .setContentText("Device session is active")
      .setOngoing(true)
      .build()
    startForeground(7301, notification)
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Do not keep arbitrary builds/models alive here. This service exists only
    // while a device automation session is explicitly requested by the app.
    return START_NOT_STICKY
  }
  override fun onDestroy() { executor.shutdownNow(); super.onDestroy() }
  override fun onBind(intent: Intent?): IBinder? = null
}
` }

module.exports = function withAibDeviceWatchdog(config) {
  config = withDangerousMod(config, ['android', async (config) => {
    const pkg = config.android?.package || 'com.karat.aibuilder';
    const dir = path.join(config.modRequest.platformProjectRoot, 'app/src/main/java', pkg.replace(/\./g, '/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'AibDeviceWatchdogModule.kt'), moduleKotlin(pkg));
    fs.writeFileSync(path.join(dir, 'AibDeviceWatchdogPackage.kt'), packageKotlin(pkg));
    fs.writeFileSync(path.join(dir, 'AibDeviceWatchdogService.kt'), serviceKotlin(pkg));
    return config;
  }]);
  config = withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (!app) throw new Error('[withAibDeviceWatchdog] application missing');
    app.service = app.service || [];
    if (!app.service.some((s) => s.$?.['android:name'] === '.AibDeviceWatchdogService')) {
      app.service.push({ $: {
        'android:name': '.AibDeviceWatchdogService',
        'android:exported': 'false',
        'android:foregroundServiceType': 'connectedDevice'
      }});
    }
    return config;
  });
  config = withMainApplication(config, (config) => {
    let c = config.modResults.contents;
    if (c.includes('AibDeviceWatchdogPackage()') || c.includes('new AibDeviceWatchdogPackage()')) return config;
    const isKotlin = config.modResults.language === 'kt';
    if (isKotlin) {
      const applyPattern = /(PackageList\s*\(\s*this\s*\)\s*\.packages)(\s*\.toMutableList\s*\(\s*\))?(\s*\.apply\s*\{)/;
      const applyMatch = c.match(applyPattern);
      if (applyMatch) c = c.replace(applyPattern, `${applyMatch[1]}${applyMatch[2] || '.toMutableList()'}${applyMatch[3]}\n              add(AibDeviceWatchdogPackage())`);
      else if (c.includes('val packages = PackageList(this).packages')) c = c.replace('val packages = PackageList(this).packages', 'val packages = PackageList(this).packages\n            packages.add(AibDeviceWatchdogPackage())');
      else throw new Error('[withAibDeviceWatchdog] MainApplication package list not found');
    } else {
      const marker = 'List<ReactPackage> packages = new PackageList(this).getPackages();';
      if (!c.includes(marker)) throw new Error('[withAibDeviceWatchdog] Java package list not found');
      c = c.replace(marker, marker + '\n      packages.add(new AibDeviceWatchdogPackage());');
    }
    config.modResults.contents = c;
    return config;
  });
  return config;
};
