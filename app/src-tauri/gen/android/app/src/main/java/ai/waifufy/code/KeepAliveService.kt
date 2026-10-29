package ai.waifufy.code

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Keeps the app's process in the foreground while the phone is joined to a session, so Android doesn't freeze it in
 * the background and the page's connection to the computer stays open: that's how her messages still arrive. Its
 * one quiet notification is what Android requires for that. Stopped when the phone leaves the session.
 */
class KeepAliveService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    PhoneLink.channels(this)
    val name = intent?.getStringExtra(PhoneLink.EXTRA_NAME)?.ifBlank { null } ?: "her"
    val n = NotificationCompat.Builder(this, PhoneLink.CHANNEL_LINK)
      .setSmallIcon(PhoneLink.ICON)
      .setContentTitle("Connected to $name")
      .setContentText("$name can reach you while the app is in the background")
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setContentIntent(PhoneLink.openApp(this))
      .build()
    val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
    ServiceCompat.startForeground(this, PhoneLink.ID_LINK, n, type)
    return START_NOT_STICKY
  }
}
