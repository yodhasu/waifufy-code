package ai.waifufy.code

import android.content.ClipData
import android.content.ClipboardManager
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AlertDialog
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import kotlin.math.abs

class MainActivity : TauriActivity() {
  /** The last crash's stack trace, shown (and copyable) on the next launch: no adb needed to report it. */
  private val crashFile by lazy { File(filesDir, "last-crash.txt") }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    keepInsideSystemBars()
    preferSixtyHz()
    catchCrashes()
  }

  /**
   * A 90 or 120 Hz screen runs at 60 Hz while she is open: every frame the page draws costs the WebView's compositor
   * about the same CPU whatever is on it, and her 3D runs at 60 fps, so the extra refreshes would only burn battery.
   */
  private fun preferSixtyHz() {
    val display = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) display else @Suppress("DEPRECATION") windowManager.defaultDisplay) ?: return
    val now = display.mode
    val sixty = display.supportedModes
      .filter { it.physicalWidth == now.physicalWidth && it.physicalHeight == now.physicalHeight }
      .minByOrNull { abs(it.refreshRate - TARGET_HZ) } ?: return
    window.attributes = window.attributes.apply { preferredDisplayModeId = sixty.modeId }
  }

  /** Her notifications and the background connection (PhoneLink), driven by the page as `window.WaifufyAndroid`. */
  override fun onWebViewCreate(webView: WebView) {
    PhoneLink.activity = this
    PhoneLink.webView = webView
    // Chrome's inspector over USB (chrome://inspect), only while the phone itself has USB debugging on: a developer's
    // phone on a cable, never an ordinary one.
    if (Settings.Global.getInt(contentResolver, Settings.Global.ADB_ENABLED, 0) == 1) WebView.setWebContentsDebuggingEnabled(true)
    webView.addJavascriptInterface(PhoneBridge(this), "WaifufyAndroid")
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    fitSystemBars()
  }

  override fun onDestroy() {
    // Swiped away: the page and its connection are gone, so nothing is left to keep alive.
    if (PhoneLink.activity === this) {
      PhoneLink.activity = null
      PhoneLink.webView = null
      if (isFinishing) PhoneLink.disconnected(applicationContext)
    }
    super.onDestroy()
  }

  /**
   * Android draws apps edge to edge (enforced from Android 15), under the status bar, the gesture or button bar,
   * camera cutouts and the keyboard. Upright the page lays itself out between them: the view is padded to the part
   * nothing covers, on the app's backdrop color, with light status icons. Sideways (Theater) it fills the screen.
   */
  private fun keepInsideSystemBars() {
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(BACKDROP)
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      // Sideways only the keyboard pushes the page up: the bars are hidden, and the cutout's side is hers to stand in.
      val types = if (sideways()) WindowInsetsCompat.Type.ime()
      else WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      val covered = insets.getInsets(types)
      view.setPadding(covered.left, covered.top, covered.right, covered.bottom)
      WindowInsetsCompat.CONSUMED
    }
    fitSystemBars()
  }

  private fun sideways() = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

  /**
   * Sideways the status and navigation bars hide (a swipe from an edge shows them for a moment) and the page runs
   * under a camera cutout, so the stage fills the screen instead of a box inside the bars. Upright they show again.
   */
  private fun fitSystemBars() {
    val sideways = sideways()
    WindowCompat.getInsetsController(window, window.decorView).apply {
      if (sideways) hide(WindowInsetsCompat.Type.systemBars()) else show(WindowInsetsCompat.Type.systemBars())
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode = if (sideways) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
      }
    }
    ViewCompat.requestApplyInsets(findViewById(android.R.id.content))
  }

  private fun catchCrashes() {
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      runCatching {
        crashFile.writeText(
          "Waifufy Code ${BuildConfig.VERSION_NAME} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) · " +
            "${Build.MANUFACTURER} ${Build.MODEL}\n\n${Log.getStackTraceString(error)}",
        )
      }
      previous?.uncaughtException(thread, error)
    }
    if (!crashFile.exists()) return
    val report = runCatching { crashFile.readText() }.getOrDefault("")
    crashFile.delete()
    if (report.isBlank()) return
    AlertDialog.Builder(this)
      .setTitle("Waifufy Code closed unexpectedly")
      .setMessage("Copy this and send it to the developer, so it can be fixed:\n\n${report.take(REPORT_SHOWN)}")
      .setPositiveButton("Copy") { _, _ ->
        val clipboard = getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("Waifufy Code crash", report))
      }
      .setNegativeButton("Close", null)
      .show()
  }

  private companion object {
    /** #05070f, the stage backdrop (tauri.conf.json backgroundColor). */
    val BACKDROP = Color.rgb(5, 7, 15)
    const val REPORT_SHOWN = 3500
    const val TARGET_HZ = 60f
  }
}
