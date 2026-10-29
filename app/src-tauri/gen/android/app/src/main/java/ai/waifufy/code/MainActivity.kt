package ai.waifufy.code

import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AlertDialog
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File

class MainActivity : TauriActivity() {
  /** The last crash's stack trace, shown (and copyable) on the next launch: no adb needed to report it. */
  private val crashFile by lazy { File(filesDir, "last-crash.txt") }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    keepInsideSystemBars()
    catchCrashes()
  }

  /** Her notifications and the background connection (PhoneLink), driven by the page as `window.WaifufyAndroid`. */
  override fun onWebViewCreate(webView: WebView) {
    PhoneLink.activity = this
    PhoneLink.webView = webView
    webView.addJavascriptInterface(PhoneBridge(this), "WaifufyAndroid")
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
   * camera cutouts and the keyboard. The page lays itself out for the whole view, so the view is padded to the
   * part nothing covers, on the app's backdrop color, with light status icons.
   */
  private fun keepInsideSystemBars() {
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(BACKDROP)
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
    }
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val covered = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
      )
      view.setPadding(covered.left, covered.top, covered.right, covered.bottom)
      WindowInsetsCompat.CONSUMED
    }
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
  }
}
