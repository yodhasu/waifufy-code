// The Slack app each workspace creates for Waifufy Code. Pure (no Node imports), so the app's Settings shows the
// same manifest and redirect URL the link signs in with.
//
// Why each workspace makes its own app: Slack limits conversations.history to 1 request a minute for apps
// distributed outside the Marketplace, which would make the unread inbox useless. An app a workspace builds for
// itself keeps the normal limits (50+ a minute). Sign-in uses PKCE, so the app ships no client secret.

/** The fixed port of the sign-in callback: Slack only redirects to a URL the app lists. */
export const SLACK_REDIRECT_PORT = 47917
export const SLACK_REDIRECT_URL = `http://localhost:${SLACK_REDIRECT_PORT}/slack/callback`

/** User scopes only: everything happens as the signed-in person, never as a bot. */
export const SLACK_USER_SCOPES = [
  // The inbox and reading: conversations, their history, and people's names.
  'channels:read', 'groups:read', 'im:read', 'mpim:read',
  'channels:history', 'groups:history', 'im:history', 'mpim:history',
  'users:read',
  // Mark as read (conversations.mark) and opening a DM with someone (conversations.open).
  'channels:write', 'groups:write', 'im:write', 'mpim:write',
  'chat:write',
  'search:read',
]

/** Paste into api.slack.com/apps → Create New App → From a manifest. */
export const SLACK_MANIFEST = `display_information:
  name: Waifufy Code
  description: Read and answer your unread Slack messages from Waifufy Code.
oauth_config:
  redirect_urls:
    - ${SLACK_REDIRECT_URL}
  scopes:
    user:
${SLACK_USER_SCOPES.map((s) => `      - ${s}`).join('\n')}
  pkce_enabled: true
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`
