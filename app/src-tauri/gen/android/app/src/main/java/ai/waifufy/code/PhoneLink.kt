package ai.waifufy.code

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Her messages on the phone (v0.7.2): while the app is in the background, what she says in casual mode arrives as
 * one conversation notification, like a chat app's, with an inline Reply that goes back through the page as a normal
 * message. KeepAliveService holds the connection to the computer open meanwhile. The page drives it all through
 * `window.WaifufyAndroid` (Bridge) and gets replies at `window.__waifufyReply`.
 */
object PhoneLink {
  const val CHANNEL_HER = "her_messages"
  const val CHANNEL_LINK = "connection"
  const val ID_HER = 1
  const val ID_LINK = 2
  const val KEY_REPLY = "reply"
  const val EXTRA_NAME = "name"
  private const val TAG = "PhoneLink"
  private const val KEEP = 8
  private const val ASK_NOTIFY = 71
  /** Platform icons: a colored launcher icon would show as a white square in the status bar. */
  val ICON = android.R.drawable.sym_action_chat

  @Volatile var activity: MainActivity? = null
  @Volatile var webView: WebView? = null
  @Volatile private var name = "Rem"

  private data class Line(val text: String, val at: Long, val hers: Boolean)
  private val lines = ArrayDeque<Line>()

  fun channels(context: Context) {
    val nm = context.getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_HER, "Her messages", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "What she says while the app is in the background, with a Reply"
      },
    )
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_LINK, "Connection", NotificationManager.IMPORTANCE_MIN).apply {
        description = "Keeps the phone connected to your computer while the app is in the background"
        setShowBadge(false)
      },
    )
  }

  fun openApp(context: Context): PendingIntent =
    PendingIntent.getActivity(
      context, 0,
      Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

  /** Joined a session: ask for notifications once, and keep the connection open in the background. */
  fun connected(a: MainActivity, who: String) {
    name = who.ifBlank { name }
    channels(a)
    if (Build.VERSION.SDK_INT >= 33 && !canNotify(a)) {
      a.runOnUiThread { ActivityCompat.requestPermissions(a, arrayOf(Manifest.permission.POST_NOTIFICATIONS), ASK_NOTIFY) }
    }
    try {
      ContextCompat.startForegroundService(a, Intent(a, KeepAliveService::class.java).putExtra(EXTRA_NAME, name))
    } catch (e: Exception) {
      // Android won't start one from the background; the next join (in front) does.
      Log.w(TAG, "keep-alive not started: ${e.message}")
    }
  }

  fun disconnected(context: Context) {
    context.stopService(Intent(context, KeepAliveService::class.java))
    clear(context)
  }

  fun herMessage(context: Context, who: String, text: String) {
    name = who.ifBlank { name }
    synchronized(lines) { add(Line(text, System.currentTimeMillis(), true)) }
    show(context, alert = true)
  }

  /** The app is in front again: the conversation is read. */
  fun clear(context: Context) {
    synchronized(lines) { lines.clear() }
    NotificationManagerCompat.from(context).cancel(ID_HER)
  }

  /** A reply typed in the notification: shown in the thread (which also stops its spinner) and sent through the page. */
  fun replied(context: Context, text: String) {
    synchronized(lines) { add(Line(text, System.currentTimeMillis(), false)) }
    val a = activity
    val w = webView
    if (a == null || w == null) {
      synchronized(lines) { add(Line("(Open Waifufy Code to send that: the app was closed.)", System.currentTimeMillis(), true)) }
      return show(context, alert = false)
    }
    show(context, alert = false)
    a.runOnUiThread { w.evaluateJavascript("window.__waifufyReply && window.__waifufyReply(${JSONObject.quote(text)})", null) }
  }

  private fun add(l: Line) {
    lines.addLast(l)
    while (lines.size > KEEP) lines.removeFirst()
  }

  private fun canNotify(context: Context) =
    Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

  @SuppressLint("MissingPermission")
  private fun show(context: Context, alert: Boolean) {
    if (!canNotify(context)) return
    channels(context)
    val her = Person.Builder().setName(name).build()
    val style = NotificationCompat.MessagingStyle(Person.Builder().setName("You").build())
    synchronized(lines) { for (l in lines) style.addMessage(l.text, l.at, if (l.hers) her else null) }
    val reply = PendingIntent.getBroadcast(
      context, 1, Intent(context, ReplyReceiver::class.java),
      PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val action = NotificationCompat.Action.Builder(android.R.drawable.ic_menu_send, "Reply", reply)
      .addRemoteInput(RemoteInput.Builder(KEY_REPLY).setLabel("Reply to $name").build())
      .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
      .setShowsUserInterface(false)
      .build()
    val n = NotificationCompat.Builder(context, CHANNEL_HER)
      .setSmallIcon(ICON)
      .setStyle(style)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setContentIntent(openApp(context))
      .addAction(action)
      .setAutoCancel(true)
      .setOnlyAlertOnce(!alert)
      .build()
    NotificationManagerCompat.from(context).notify(ID_HER, n)
  }
}

/** What the page calls, as `window.WaifufyAndroid`. Called off the UI thread. */
class PhoneBridge(private val activity: MainActivity) {
  @JavascriptInterface fun connected(name: String) = PhoneLink.connected(activity, name)
  @JavascriptInterface fun disconnected() = PhoneLink.disconnected(activity.applicationContext)
  @JavascriptInterface fun notify(name: String, text: String) = PhoneLink.herMessage(activity.applicationContext, name, text)
  @JavascriptInterface fun clear() = PhoneLink.clear(activity.applicationContext)
}
