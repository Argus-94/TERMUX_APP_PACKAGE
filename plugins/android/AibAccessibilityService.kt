package __PACKAGE__

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityService.ScreenshotResult
import android.accessibilityservice.AccessibilityService.TakeScreenshotCallback
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Path
import android.hardware.display.DisplayManager
import android.hardware.HardwareBuffer
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.util.DisplayMetrics
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.ByteArrayOutputStream
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Only active after the owner manually enables AI Builder in Android Accessibility settings. */
class AibAccessibilityService : AccessibilityService() {
  private val screenshotExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private val captureGuard = Any()
  private var screenshotInFlight = false
  private var lastScreenshotAt = 0L
  private var lastCapturedFrame: CapturedFrameTarget? = null

  override fun onServiceConnected() { super.onServiceConnected(); active = WeakReference(this) }
  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    // Any subsequent Android-reported UI event conservatively invalidates the prior secondary frame.
    // Do not read AccessibilityRecord.displayId here: that API was added only in API 33.
    if (event != null) synchronized(captureGuard) {
      lastCapturedFrame = null
    }
    /* Intentionally no event/text logging or persistence. */
  }
  override fun onInterrupt() { }
  override fun onDestroy() {
    synchronized(captureGuard) { lastCapturedFrame = null }
    screenshotExecutor.shutdownNow()
    if (active?.get() === this) { active = null; AibLoopbackLifecycle.stop() }
    super.onDestroy()
  }

  /** Live discoverable non-private logical displays; Android's primary display is deliberately omitted. */
  fun listPublicSecondaryDisplays(): List<SecondaryDisplayInfo> {
    if (Build.VERSION.SDK_INT < 30) return emptyList()
    val manager = getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager ?: return emptyList()
    return manager.displays.asSequence()
      .filter { it.displayId != Display.DEFAULT_DISPLAY && it.isValid && (it.flags and Display.FLAG_PRIVATE) == 0 }
      .mapNotNull { display ->
        try {
          val metrics = DisplayMetrics()
          display.getRealMetrics(metrics)
          if (metrics.widthPixels <= 0 || metrics.heightPixels <= 0) null
          else SecondaryDisplayInfo(display.displayId, display.name.take(80).ifBlank { "Secondary display" }, metrics.widthPixels, metrics.heightPixels)
        } catch (_: Exception) { null }
      }
      .take(MAX_SECONDARY_DISPLAYS)
      .toList()
  }

  /** Preserve the established explicit primary-display capture API. It never serves as a secondary fallback. */
  fun captureCurrentDisplay(callback: (CapturedFrame?, String?) -> Unit) = captureDisplayInternal(Display.DEFAULT_DISPLAY, false, callback)

  /** Capture an exact, currently enumerated public secondary display or fail closed. */
  fun captureSecondaryDisplay(displayId: Int, callback: (CapturedFrame?, String?) -> Unit) {
    if (displayId <= 0 || findPublicSecondaryDisplay(displayId) == null) return callback(null, "TARGET_PUBLIC_SECONDARY_DISPLAY_UNAVAILABLE")
    captureDisplayInternal(displayId, true, callback)
  }

  private fun captureDisplayInternal(displayId: Int, allowSecondaryInput: Boolean, callback: (CapturedFrame?, String?) -> Unit) {
    if (Build.VERSION.SDK_INT < 30) return callback(null, "SCREENSHOT_API_UNAVAILABLE")
    synchronized(captureGuard) {
      val now = SystemClock.uptimeMillis()
      if (screenshotInFlight) return callback(null, "SCREENSHOT_BUSY")
      if (now - lastScreenshotAt < MIN_CAPTURE_INTERVAL_MS) return callback(null, "SCREENSHOT_RATE_LIMIT")
      screenshotInFlight = true
      lastScreenshotAt = now
      lastCapturedFrame = null
    }
    val completed = AtomicBoolean(false)
    fun finish(frame: CapturedFrame?, error: String?) {
      if (!completed.compareAndSet(false, true)) return
      synchronized(captureGuard) {
        screenshotInFlight = false
        lastCapturedFrame = if (frame != null && allowSecondaryInput) CapturedFrameTarget(
          frame.frameId, frame.displayId, frame.width, frame.height, frame.sourceWidth, frame.sourceHeight, SystemClock.uptimeMillis(),
        ) else null
      }
      callback(frame, error)
    }
    try {
      // Use the caller's exact display id. The platform returns an error for unavailable or inaccessible displays.
      takeScreenshot(displayId, screenshotExecutor, object : TakeScreenshotCallback {
        override fun onSuccess(screenshot: ScreenshotResult) {
          val hardwareBuffer: HardwareBuffer = screenshot.hardwareBuffer
          var wrapped: Bitmap? = null
          var software: Bitmap? = null
          var output: Bitmap? = null
          try {
            wrapped = Bitmap.wrapHardwareBuffer(hardwareBuffer, screenshot.colorSpace)
              ?: return finish(null, "SCREENSHOT_BUFFER_UNAVAILABLE")
            software = wrapped!!.copy(Bitmap.Config.ARGB_8888, false)
              ?: return finish(null, "SCREENSHOT_COPY_UNAVAILABLE")
            val source = software!!
            val sourceWidth = hardwareBuffer.width
            val sourceHeight = hardwareBuffer.height
            if (sourceWidth <= 0 || sourceHeight <= 0) return finish(null, "SCREENSHOT_DIMENSIONS_INVALID")
            val scale = minOf(1.0, MAX_CAPTURE_DIMENSION.toDouble() / maxOf(source.width, source.height).toDouble())
            output = if (scale < 1.0) Bitmap.createScaledBitmap(source, (source.width * scale).toInt().coerceAtLeast(1), (source.height * scale).toInt().coerceAtLeast(1), true) else source
            val bytes = ByteArrayOutputStream()
            if (!output!!.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, bytes)) return finish(null, "SCREENSHOT_ENCODE_FAILED")
            if (bytes.size() > MAX_CAPTURE_BYTES) return finish(null, "SCREENSHOT_TOO_LARGE")
            finish(CapturedFrame(UUID.randomUUID().toString(), displayId, output!!.width, output!!.height, sourceWidth, sourceHeight, Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)), null)
          } catch (_: Exception) {
            finish(null, "SCREENSHOT_CAPTURE_FAILED")
          } finally {
            hardwareBuffer.close()
            wrapped?.recycle()
            if (output !== software) output?.recycle()
            software?.recycle()
          }
        }
        override fun onFailure(errorCode: Int) { finish(null, "SCREENSHOT_FAILED_$errorCode") }
      })
    } catch (_: Exception) {
      finish(null, "SCREENSHOT_CAPTURE_FAILED")
    }
  }

  /** Dispatch one tap only to the public secondary display belonging to the latest live screenshot frame. */
  fun tapCapturedSecondaryFrame(frameId: String, x: Float, y: Float): Boolean {
    if (Build.VERSION.SDK_INT < 30 || frameId.isBlank() || !x.isFinite() || !y.isFinite()) return false
    return synchronized(captureGuard) {
      val target = lastCapturedFrame ?: return@synchronized false
      if (target.frameId != frameId || SystemClock.uptimeMillis() - target.capturedAt > MAX_FRAME_AGE_MS) return@synchronized false
      if (x < 0f || y < 0f || x >= target.frameWidth || y >= target.frameHeight) return@synchronized false
      if (findPublicSecondaryDisplay(target.displayId) == null) return@synchronized false
      val logicalX = x * target.sourceWidth.toFloat() / target.frameWidth.toFloat()
      val logicalY = y * target.sourceHeight.toFloat() / target.frameHeight.toFloat()
      if (!logicalX.isFinite() || !logicalY.isFinite()) return@synchronized false
      val path = Path().apply { moveTo(logicalX, logicalY) }
      val stroke = GestureDescription.StrokeDescription(path, 0, TAP_DURATION_MS)
      val gesture = GestureDescription.Builder()
        .setDisplayId(target.displayId)
        .addStroke(stroke)
        .build()
      val accepted = try { dispatchGesture(gesture, null, null) } catch (_: Exception) { false }
      if (accepted) lastCapturedFrame = null
      accepted
    }
  }

  private fun findPublicSecondaryDisplay(displayId: Int): Display? {
    if (Build.VERSION.SDK_INT < 30 || displayId <= 0) return null
    val manager = getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager ?: return null
    return manager.getDisplay(displayId)?.takeIf {
      it.displayId != Display.DEFAULT_DISPLAY && it.isValid && (it.flags and Display.FLAG_PRIVATE) == 0
    }
  }

  fun uiTree(): List<Map<String, Any>> {
    val root = rootInActiveWindow ?: return emptyList()
    val out = ArrayList<Map<String, Any>>(128)
    fun visit(node: AccessibilityNodeInfo, depth: Int) {
      if (depth > 40 || out.size >= 500) return
      val r = android.graphics.Rect(); node.getBoundsInScreen(r)
      if (r.width() > 0 && r.height() > 0) {
        val item = HashMap<String, Any>()
        if (!node.isPassword) node.text?.toString()?.take(1000)?.let { if (it.isNotEmpty()) item["text"] = it }
        item["bounds"] = mapOf("left" to r.left, "top" to r.top, "right" to r.right, "bottom" to r.bottom)
        item["clickable"] = node.isClickable
        node.className?.toString()?.take(160)?.let { item["className"] = it }
        out.add(item)
      }
      for (i in 0 until node.childCount) node.getChild(i)?.let { visit(it, depth + 1) }
    }
    visit(root, 0)
    return out
  }
  /** Inspect only windows Android currently exposes on the selected public secondary display. */
  fun uiTreeForPublicSecondaryDisplay(displayId: Int): List<Map<String, Any>> {
    if (Build.VERSION.SDK_INT < 30 || findPublicSecondaryDisplay(displayId) == null) return emptyList()
    val out = ArrayList<Map<String, Any>>(128)
    fun visit(node: AccessibilityNodeInfo, depth: Int) {
      if (depth > 40 || out.size >= 500) return
      val r = android.graphics.Rect(); node.getBoundsInScreen(r)
      if (r.width() > 0 && r.height() > 0) {
        val item = HashMap<String, Any>()
        if (!node.isPassword) node.text?.toString()?.take(1000)?.let { if (it.isNotEmpty()) item["text"] = it }
        item["bounds"] = mapOf("left" to r.left, "top" to r.top, "right" to r.right, "bottom" to r.bottom)
        item["clickable"] = node.isClickable
        node.className?.toString()?.take(160)?.let { item["className"] = it }
        out.add(item)
      }
      for (i in 0 until node.childCount) node.getChild(i)?.let { visit(it, depth + 1) }
    }
    try {
      windows.asSequence().filter { it.displayId == displayId }.forEach { window ->
        val root = window.root
        if (root != null) visit(root, 0)
      }
    } catch (_: Exception) { return emptyList() }
    return out
  }
  fun clickText(value: String): Boolean {
    if (value.isEmpty() || value.length > 1000) return false
    val root = rootInActiveWindow ?: return false
    val match = root.findAccessibilityNodeInfosByText(value).firstOrNull { it.isClickable } ?: return false
    return match.performAction(AccessibilityNodeInfo.ACTION_CLICK)
  }
  fun enterText(value: String): Boolean {
    if (value.isEmpty() || value.length > 1000) return false
    val root = rootInActiveWindow ?: return false
    val node = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
    val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value) }
    return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
  }
  fun gesture(x1: Float, y1: Float, x2: Float, y2: Float, duration: Long): Boolean {
    if (Build.VERSION.SDK_INT < 24 || !inside(x1, y1) || !inside(x2, y2) || duration !in 50L..5000L) return false
    val path = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
    val stroke = GestureDescription.StrokeDescription(path, 0, duration)
    return dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
  }
  private fun inside(x: Float, y: Float): Boolean {
    val m = resources.displayMetrics
    return x.isFinite() && y.isFinite() && x >= 0 && y >= 0 && x < m.widthPixels && y < m.heightPixels
  }
  companion object {
    const val MAX_CAPTURE_DIMENSION = 1280
    const val JPEG_QUALITY = 60
    const val MAX_CAPTURE_BYTES = 1_500_000
    const val MIN_CAPTURE_INTERVAL_MS = 500L
    const val MAX_FRAME_AGE_MS = 10_000L
    const val MAX_SECONDARY_DISPLAYS = 16
    const val TAP_DURATION_MS = 80L
    @Volatile private var active: WeakReference<AibAccessibilityService>? = null
    fun current(): AibAccessibilityService? = active?.get()
  }
}

data class CapturedFrame(val frameId: String, val displayId: Int, val width: Int, val height: Int, val sourceWidth: Int, val sourceHeight: Int, val data: String)
data class SecondaryDisplayInfo(val displayId: Int, val name: String, val width: Int, val height: Int)
private data class CapturedFrameTarget(val frameId: String, val displayId: Int, val frameWidth: Int, val frameHeight: Int, val sourceWidth: Int, val sourceHeight: Int, val capturedAt: Long)
