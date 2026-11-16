package __PACKAGE__

import android.app.ActivityManager
import android.os.BatteryManager
import android.os.Build
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.os.PowerManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/** Android memory telemetry only; it never kills processes or mutates user data. */
class AibMemoryPressureModule(private val app: ReactApplicationContext) : ReactContextBaseJavaModule(app) {
  private val callbacks = object : ComponentCallbacks2 {
    override fun onConfigurationChanged(newConfig: Configuration) = Unit

    override fun onLowMemory() {
      emitPressure(ComponentCallbacks2.TRIM_MEMORY_COMPLETE)
    }

    override fun onTrimMemory(level: Int) {
      if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) emitPressure(level)
    }
  }

  init {
    app.registerComponentCallbacks(callbacks)
  }

  override fun getName(): String = "AibMemoryPressure"

  override fun invalidate() {
    app.unregisterComponentCallbacks(callbacks)
    super.invalidate()
  }

  @ReactMethod
  fun addListener(eventName: String) = Unit

  @ReactMethod
  fun removeListeners(count: Int) = Unit

  @ReactMethod
  fun getAvailableMemoryBytes(promise: Promise) {
    try {
      val manager = app.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        ?: throw IllegalStateException("ActivityManager unavailable")
      val info = ActivityManager.MemoryInfo()
      manager.getMemoryInfo(info)
      promise.resolve(info.availMem.toDouble())
    } catch (error: Exception) {
      promise.reject("AIB_MEMORY_METRIC_FAILED", "Could not query available Android memory.", error)
    }
  }

  @ReactMethod
  fun getDevicePowerState(promise: Promise) {
    try {
      val battery = app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
      val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
      val plugged = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) ?: -1
      val manager = app.getSystemService(Context.POWER_SERVICE) as? PowerManager
      val result = Arguments.createMap()
      if (level >= 0 && scale > 0) result.putInt("batteryPercent", (level * 100 / scale).coerceIn(0, 100)) else result.putNull("batteryPercent")
      if (plugged >= 0) result.putBoolean("pluggedIn", plugged != 0) else result.putNull("pluggedIn")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && manager != null) result.putBoolean("lowPowerMode", manager.isPowerSaveMode) else result.putNull("lowPowerMode")
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("AIB_POWER_METRIC_FAILED", "Could not query Android power state.", error)
    }
  }

  private fun emitPressure(level: Int) {
    try {
      val event = Arguments.createMap()
      event.putInt("level", level)
      event.putDouble("timestamp", System.currentTimeMillis().toDouble())
      val manager = app.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
      if (manager != null) {
        val info = ActivityManager.MemoryInfo()
        manager.getMemoryInfo(info)
        event.putDouble("availableMemoryBytes", info.availMem.toDouble())
      }
      app.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("AibMemoryPressure", event)
    } catch (_: Exception) {
      // The app may be tearing down its React context; telemetry is best effort.
    }
  }
}
