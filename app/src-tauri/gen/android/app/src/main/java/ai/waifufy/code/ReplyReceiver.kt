package ai.waifufy.code

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput

/** The inline Reply on her notification: the typed text goes back through the page as a normal message. */
class ReplyReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(PhoneLink.KEY_REPLY)?.toString()?.trim().orEmpty()
    if (text.isNotEmpty()) PhoneLink.replied(context, text)
  }
}
