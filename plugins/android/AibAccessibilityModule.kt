package __PACKAGE__

import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class AibAccessibilityModule(private val app: ReactApplicationContext) : ReactContextBaseJavaModule(app) {
  private data class PendingResponse(val latch: CountDownLatch = CountDownLatch(1), val body: AtomicReference<String?> = AtomicReference(null))
  private val pending = ConcurrentHashMap<String, PendingResponse>()
  private val loopback = AibLoopbackServer(::dispatchLoopbackRequest)

  override fun invalidate() {
    loopback.stop()
    failPending()
    super.invalidate()
  }

  override fun getName() = "AibAccessibility"

  /** Required by React Native NativeEventEmitter. */
  @ReactMethod fun addListener(eventName: String) { }
  /** Required by React Native NativeEventEmitter. */
  @ReactMethod fun removeListeners(count: Int) { }

  @ReactMethod fun status(promise: Promise) {
    try {
      val enabled = Settings.Secure.getString(app.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
      val component = ComponentName(app, AibAccessibilityService::class.java).flattenToString()
      val isEnabled = enabled.split(':').any { it.equals(component, true) }
      val active = AibAccessibilityService.current() != null
      val result = Arguments.createMap()
      result.putString("state", if (active) "available" else if (isEnabled) "unavailable" else "permission_required")
      if (!active) result.putString("reason", if (isEnabled) "Accessibility service is enabled but not bound." else "Enable AI Builder manually in Android Accessibility settings.")
      promise.resolve(result)
    } catch (e: Exception) { promise.reject("AIB_ACCESSIBILITY_STATUS", "Accessibility status unavailable", e) }
  }

  @ReactMethod fun virtualDisplayStatus(promise: Promise) {
    val result = Arguments.createMap()
    val service = AibAccessibilityService.current()
    val state = when {
      Build.VERSION.SDK_INT < 30 -> "unsupported"
      service != null -> "available"
      else -> "permission_required"
    }
    result.putString("state", state)
    result.putString("reason", when (state) {
      "unsupported" -> "AccessibilityService screenshot API requires Android 11 (API 30) or newer."
      "available" -> "Current-display screenshot is available. Public secondary displays may be enumerated; private-display access and arbitrary app launch are not provided."
      else -> "Enable AI Builder in Android Accessibility settings before capture."
    })
    promise.resolve(result)
  }

  /** Expose only live, non-private secondary displays discoverable through Android's public DisplayManager API. */
  @ReactMethod fun listPublicSecondaryDisplays(promise: Promise) {
    if (Build.VERSION.SDK_INT < 30) {
      val result = Arguments.createMap(); val status = Arguments.createMap()
      status.putString("state", "unsupported"); status.putString("reason", "Secondary-display screenshot/input requires Android 11 (API 30) or newer.")
      result.putMap("status", status); result.putArray("displays", Arguments.createArray()); return promise.resolve(result)
    }
    val service = AibAccessibilityService.current()
    if (service == null) {
      val result = Arguments.createMap(); val status = Arguments.createMap()
      status.putString("state", "permission_required"); status.putString("reason", "Enable AI Builder in Android Accessibility settings before display discovery.")
      result.putMap("status", status); result.putArray("displays", Arguments.createArray()); return promise.resolve(result)
    }
    try {
      val result = Arguments.createMap(); val status = Arguments.createMap(); val displays: WritableArray = Arguments.createArray()
      status.putString("state", "available"); status.putString("reason", "Live public secondary displays only; private displays and primary fallback are excluded.")
      service.listPublicSecondaryDisplays().forEach { display ->
        val item = Arguments.createMap(); item.putInt("displayId", display.displayId); item.putString("name", display.name)
        item.putInt("width", display.width); item.putInt("height", display.height); displays.pushMap(item)
      }
      result.putMap("status", status); result.putArray("displays", displays); promise.resolve(result)
    } catch (_: Exception) {
      val result = Arguments.createMap(); val status = Arguments.createMap()
      status.putString("state", "unavailable"); status.putString("reason", "PUBLIC_SECONDARY_DISPLAY_DISCOVERY_FAILED")
      result.putMap("status", status); result.putArray("displays", Arguments.createArray()); promise.resolve(result)
    }
  }

  /** Capture one current-display frame only after the user enabled the Accessibility Service in system settings. */
  @ReactMethod fun captureCurrentDisplay(promise: Promise) {
    if (Build.VERSION.SDK_INT < 30) {
      val result = Arguments.createMap(); val status = Arguments.createMap()
      status.putString("state", "unsupported"); status.putString("reason", "Screenshot requires Android 11 (API 30) or newer.")
      result.putMap("status", status); return promise.resolve(result)
    }
    val service = AibAccessibilityService.current()
    if (service == null) {
      val result = Arguments.createMap(); val status = Arguments.createMap()
      status.putString("state", "permission_required"); status.putString("reason", "Enable AI Builder in Android Accessibility settings before capture.")
      result.putMap("status", status); return promise.resolve(result)
    }
    service.captureCurrentDisplay { frame, error ->
      val result = Arguments.createMap(); val status = Arguments.createMap()
      if (frame != null) {
        status.putString("state", "available"); status.putString("reason", "Captured the primary display explicitly; secondary-display capture uses a separate exact-ID method.")
        result.putString("frameId", frame.frameId); result.putInt("displayId", frame.displayId); result.putInt("width", frame.width); result.putInt("height", frame.height); result.putString("data", frame.data)
      } else {
        status.putString("state", "unavailable"); status.putString("reason", error ?: "SCREENSHOT_CAPTURE_FAILED")
      }
      result.putMap("status", status); promise.resolve(result)
    }
  }

  /** Capture the requested public secondary display only. Invalid/primary IDs never fall back to display 0. */
  @ReactMethod fun captureSecondaryDisplay(displayId: Int, promise: Promise) {
    if (Build.VERSION.SDK_INT < 30) {
      val result = Arguments.createMap(); val status = Arguments.createMap()
      status.putString("state", "unsupported"); status.putString("reason", "Secondary-display screenshot requires Android 11 (API 30) or newer.")
      result.putMap("status", status); return promise.resolve(result)
    }
    if (displayId <= 0) {
      val result = Arguments.createMap(); val status = Arguments.createMap()
      status.putString("state", "unavailable"); status.putString("reason", "PRIMARY_OR_INVALID_DISPLAY_REJECTED; no fallback was used.")
      result.putMap("status", status); return promise.resolve(result)
    }
    val service = AibAccessibilityService.current()
    if (service == null) {
      val result = Arguments.createMap(); val status = Arguments.createMap()
      status.putString("state", "permission_required"); status.putString("reason", "Enable AI Builder in Android Accessibility settings before capture.")
      result.putMap("status", status); return promise.resolve(result)
    }
    service.captureSecondaryDisplay(displayId) { frame, error ->
      val result = Arguments.createMap(); val status = Arguments.createMap()
      if (frame != null && frame.displayId == displayId) {
        status.putString("state", "available"); status.putString("reason", "Captured the requested live public secondary display; frame-bound tap is available for this frame only.")
        result.putString("frameId", frame.frameId); result.putInt("displayId", frame.displayId); result.putInt("width", frame.width); result.putInt("height", frame.height); result.putString("data", frame.data)
      } else {
        status.putString("state", "unavailable"); status.putString("reason", error ?: "SECONDARY_DISPLAY_CAPTURE_FAILED")
      }
      result.putMap("status", status); promise.resolve(result)
    }
  }

  /** A tap is accepted only for the latest screenshot frame and its exact still-live display. */
  @ReactMethod fun tapCapturedSecondaryFrame(frameId: String, x: Double, y: Double, promise: Promise) {
    if (frameId.length > 128 || frameId.isBlank() || !x.isFinite() || !y.isFinite()) return promise.reject("AIB_DISPLAY_INPUT", "Invalid frame-bound display tap")
    val service = AibAccessibilityService.current() ?: return promise.reject("AIB_ACCESSIBILITY_DISABLED", "Accessibility service is not active")
    try { promise.resolve(service.tapCapturedSecondaryFrame(frameId, x.toFloat(), y.toFloat())) }
    catch (e: Exception) { promise.reject("AIB_DISPLAY_INPUT", "Secondary-display tap failed", e) }
  }

  @ReactMethod fun openSettings(promise: Promise) {
    try {
      app.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      promise.resolve(true)
    } catch (e: Exception) { promise.reject("AIB_ACCESSIBILITY_SETTINGS", "Could not open Accessibility settings", e) }
  }

  @ReactMethod fun startLoopback(promise: Promise) {
    try {
      if (AibAccessibilityService.current() == null) return promise.reject("AIB_ACCESSIBILITY_DISABLED", "Enable Accessibility before starting the loopback bridge")
      val started = loopback.start()
      val result = Arguments.createMap()
      result.putString("url", started.url)
      result.putString("token", started.token)
      promise.resolve(result)
    } catch (e: Exception) { promise.reject("AIB_DEVICE_BRIDGE_START", "Loopback device bridge could not start", e) }
  }

  @ReactMethod fun stopLoopback(promise: Promise) {
    loopback.stop()
    failPending()
    promise.resolve(true)
  }

  /** Complete one in-flight authenticated HTTP request after DeviceBridge has run its policy gate. */
  @ReactMethod fun respondLoopbackRequest(requestId: String, responseJson: String, promise: Promise) {
    if (requestId.length > 64 || responseJson.length > MAX_RESPONSE_CHARS) return promise.reject("AIB_DEVICE_BRIDGE_RESPONSE", "Invalid bridge response")
    try { JSONObject(responseJson) } catch (_: Exception) { return promise.reject("AIB_DEVICE_BRIDGE_RESPONSE", "Response must be a JSON object") }
    val item = pending[requestId] ?: return promise.resolve(false)
    item.body.set(responseJson)
    item.latch.countDown()
    promise.resolve(true)
  }

  private fun dispatchLoopbackRequest(method: String, path: String, body: String): String {
    if (body.length > MAX_REQUEST_CHARS) throw IllegalArgumentException("request_too_large")
    val requestId = UUID.randomUUID().toString()
    val item = PendingResponse()
    pending[requestId] = item
    try {
      app.runOnJSQueueThread {
        try {
          val event: WritableMap = Arguments.createMap()
          event.putString("requestId", requestId)
          event.putString("method", method)
          event.putString("path", path)
          event.putString("body", body)
          app.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(EVENT_NAME, event)
        } catch (_: Exception) {
          item.body.compareAndSet(null, ERROR_DISPATCH_UNAVAILABLE)
          item.latch.countDown()
        }
      }
      if (!item.latch.await(DISPATCH_TIMEOUT_SECONDS, TimeUnit.SECONDS)) return ERROR_DISPATCH_TIMEOUT
      return item.body.get()?.takeIf { it.length <= MAX_RESPONSE_CHARS } ?: ERROR_DISPATCH_INVALID_RESPONSE
    } finally {
      pending.remove(requestId)
    }
  }

  private fun failPending() {
    val ids = pending.keys.toList()
    for (id in ids) {
      val item = pending.remove(id) ?: continue
      item.body.set(ERROR_BRIDGE_STOPPED)
      item.latch.countDown()
    }
  }

  @ReactMethod fun getTree(promise: Promise) {
    val service = AibAccessibilityService.current() ?: return promise.reject("AIB_ACCESSIBILITY_DISABLED", "Accessibility service is not active")
    try {
      val out: WritableArray = Arguments.createArray()
      service.uiTree().forEach { row ->
        val item: WritableMap = Arguments.createMap()
        (row["text"] as? String)?.let { item.putString("text", it) }
        val bounds = row["bounds"] as? Map<*, *>
        if (bounds != null) {
          val b = Arguments.createMap()
          b.putInt("left", (bounds["left"] as Number).toInt()); b.putInt("top", (bounds["top"] as Number).toInt())
          b.putInt("right", (bounds["right"] as Number).toInt()); b.putInt("bottom", (bounds["bottom"] as Number).toInt())
          item.putMap("bounds", b)
        }
        item.putBoolean("clickable", row["clickable"] as? Boolean ?: false)
        (row["className"] as? String)?.let { item.putString("className", it) }
        out.pushMap(item)
      }
      promise.resolve(out)
    } catch (e: Exception) { promise.reject("AIB_ACCESSIBILITY_TREE", "Could not read active UI tree", e) }
  }

  /** Return accessible node metadata only for windows on the requested live public secondary display. */
  @ReactMethod fun getPublicSecondaryDisplayTree(displayId: Int, promise: Promise) {
    if (Build.VERSION.SDK_INT < 30 || displayId <= 0) return promise.reject("AIB_DISPLAY_TREE_UNAVAILABLE", "A valid API-30+ secondary display is required")
    val service = AibAccessibilityService.current() ?: return promise.reject("AIB_ACCESSIBILITY_DISABLED", "Accessibility service is not active")
    try {
      val out: WritableArray = Arguments.createArray()
      service.uiTreeForPublicSecondaryDisplay(displayId).forEach { row ->
        val item: WritableMap = Arguments.createMap()
        (row["text"] as? String)?.let { item.putString("text", it) }
        val bounds = row["bounds"] as? Map<*, *>
        if (bounds != null) {
          val b = Arguments.createMap()
          b.putInt("left", (bounds["left"] as Number).toInt()); b.putInt("top", (bounds["top"] as Number).toInt())
          b.putInt("right", (bounds["right"] as Number).toInt()); b.putInt("bottom", (bounds["bottom"] as Number).toInt())
          item.putMap("bounds", b)
        }
        item.putBoolean("clickable", row["clickable"] as? Boolean ?: false)
        (row["className"] as? String)?.let { item.putString("className", it) }
        out.pushMap(item)
      }
      promise.resolve(out)
    } catch (e: Exception) { promise.reject("AIB_DISPLAY_TREE", "Could not read windows on the requested secondary display", e) }
  }

  @ReactMethod fun clickText(text: String, promise: Promise) {
    val service = AibAccessibilityService.current() ?: return promise.reject("AIB_ACCESSIBILITY_DISABLED", "Accessibility service is not active")
    if (text.length > 1000 || text.any { it.isISOControl() }) return promise.reject("AIB_ACCESSIBILITY_INPUT", "Invalid click text")
    promise.resolve(service.clickText(text))
  }

  @ReactMethod fun tap(x: Double, y: Double, promise: Promise) = performGesture(x, y, x, y, 80.0, promise)
  @ReactMethod fun swipe(x1: Double, y1: Double, x2: Double, y2: Double, duration: Double, promise: Promise) = performGesture(x1, y1, x2, y2, duration, promise)

  private fun performGesture(x1: Double, y1: Double, x2: Double, y2: Double, duration: Double, promise: Promise) {
    val service = AibAccessibilityService.current() ?: return promise.reject("AIB_ACCESSIBILITY_DISABLED", "Accessibility service is not active")
    if (listOf(x1, y1, x2, y2, duration).any { !it.isFinite() } || duration !in 50.0..5000.0) return promise.reject("AIB_ACCESSIBILITY_INPUT", "Invalid gesture coordinates/duration")
    promise.resolve(service.gesture(x1.toFloat(), y1.toFloat(), x2.toFloat(), y2.toFloat(), duration.toLong()))
  }

  @ReactMethod fun inputText(text: String, promise: Promise) {
    val service = AibAccessibilityService.current() ?: return promise.reject("AIB_ACCESSIBILITY_DISABLED", "Accessibility service is not active")
    if (text.isEmpty() || text.length > 1000 || text.any { it.isISOControl() && it != '\n' && it != '\t' }) return promise.reject("AIB_ACCESSIBILITY_INPUT", "Invalid input text")
    promise.resolve(service.enterText(text))
  }

  @ReactMethod fun systemKey(key: String, promise: Promise) {
    val service = AibAccessibilityService.current() ?: return promise.reject("AIB_ACCESSIBILITY_DISABLED", "Accessibility service is not active")
    val global = when (key) {
      "BACK" -> android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK
      "HOME" -> android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME
      "RECENTS" -> android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_RECENTS
      "NOTIFICATIONS" -> android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
      "QUICK_SETTINGS" -> android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS
      else -> -1
    }
    if (global < 0) return promise.reject("AIB_ACCESSIBILITY_KEY", "Unsupported system key")
    promise.resolve(service.performGlobalAction(global))
  }

  private companion object {
    const val EVENT_NAME = "AibDeviceBridgeRequest"
    const val DISPATCH_TIMEOUT_SECONDS = 20L
    const val MAX_REQUEST_CHARS = 16_384
    const val MAX_RESPONSE_CHARS = 65_536
    const val ERROR_DISPATCH_UNAVAILABLE = "{\"ok\":false,\"error\":\"device_policy_dispatch_unavailable\"}"
    const val ERROR_DISPATCH_TIMEOUT = "{\"ok\":false,\"error\":\"device_policy_dispatch_timeout\"}"
    const val ERROR_DISPATCH_INVALID_RESPONSE = "{\"ok\":false,\"error\":\"device_policy_response_invalid\"}"
    const val ERROR_BRIDGE_STOPPED = "{\"ok\":false,\"error\":\"device_bridge_stopped\"}"
  }
}
