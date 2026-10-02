// Generated from schema/openapi.json. Do not edit. Upstream schema: AGPL-3.0.
export const routes = {
  "GET /.well-known/fluxer": {
    "authenticated": false
  },
  "GET /applications/@me": {
    "authenticated": true
  },
  "POST /attachments/refresh-urls": {
    "authenticated": true
  },
  "POST /auth/authorize-ip": {
    "authenticated": false
  },
  "POST /auth/email-revert": {
    "authenticated": false
  },
  "POST /auth/forgot": {
    "authenticated": false
  },
  "POST /auth/handoff/complete": {
    "authenticated": false
  },
  "POST /auth/handoff/initiate": {
    "authenticated": false
  },
  "DELETE /auth/handoff/{code}": {
    "authenticated": false
  },
  "GET /auth/handoff/{code}/info": {
    "authenticated": false
  },
  "GET /auth/handoff/{code}/status": {
    "authenticated": false
  },
  "POST /auth/handoff/{code}/status": {
    "authenticated": false
  },
  "GET /auth/ip-authorization/poll": {
    "authenticated": false
  },
  "POST /auth/ip-authorization/resend": {
    "authenticated": false
  },
  "POST /auth/login": {
    "authenticated": false
  },
  "POST /auth/login/mfa/totp": {
    "authenticated": false
  },
  "POST /auth/login/mfa/webauthn": {
    "authenticated": false
  },
  "POST /auth/login/mfa/webauthn/authentication-options": {
    "authenticated": false
  },
  "POST /auth/logout": {
    "authenticated": true
  },
  "POST /auth/origin-handoff": {
    "authenticated": true
  },
  "POST /auth/origin-handoff/redeem": {
    "authenticated": false
  },
  "POST /auth/passkey-bridge": {
    "authenticated": false
  },
  "POST /auth/passkey-bridge/{ceremony_id}/cancel": {
    "authenticated": false
  },
  "POST /auth/passkey-bridge/{ceremony_id}/complete": {
    "authenticated": false
  },
  "POST /auth/passkey-bridge/{ceremony_id}/options": {
    "authenticated": false
  },
  "POST /auth/passkey-bridge/{ceremony_id}/redeem": {
    "authenticated": false
  },
  "POST /auth/register": {
    "authenticated": false
  },
  "POST /auth/reset": {
    "authenticated": false
  },
  "GET /auth/reset/{token}": {
    "authenticated": false
  },
  "GET /auth/sessions": {
    "authenticated": true
  },
  "POST /auth/sessions/logout": {
    "authenticated": true
  },
  "POST /auth/sso/complete": {
    "authenticated": false
  },
  "POST /auth/sso/start": {
    "authenticated": false
  },
  "GET /auth/sso/status": {
    "authenticated": false
  },
  "POST /auth/username-suggestions": {
    "authenticated": false
  },
  "POST /auth/verify": {
    "authenticated": false
  },
  "POST /auth/verify/resend": {
    "authenticated": true
  },
  "POST /auth/webauthn/authenticate": {
    "authenticated": false
  },
  "POST /auth/webauthn/authentication-options": {
    "authenticated": false
  },
  "POST /channels/messages/bulk": {
    "authenticated": true
  },
  "GET /channels/{channel_id}": {
    "authenticated": true
  },
  "PATCH /channels/{channel_id}": {
    "authenticated": true
  },
  "DELETE /channels/{channel_id}": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/attachments": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/attachments/complete": {
    "authenticated": true
  },
  "GET /channels/{channel_id}/call": {
    "authenticated": true
  },
  "PATCH /channels/{channel_id}/call": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/call/end": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/call/ring": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/call/stop-ringing": {
    "authenticated": true
  },
  "GET /channels/{channel_id}/follower-stats": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/followers": {
    "authenticated": true
  },
  "GET /channels/{channel_id}/invites": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/invites": {
    "authenticated": true
  },
  "GET /channels/{channel_id}/messages": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/messages": {
    "authenticated": true
  },
  "DELETE /channels/{channel_id}/messages/ack": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/messages/bulk-delete": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/messages/bulk-delete-mine": {
    "authenticated": true
  },
  "GET /channels/{channel_id}/messages/pins": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/messages/purge": {
    "authenticated": true
  },
  "GET /channels/{channel_id}/messages/{message_id}": {
    "authenticated": true
  },
  "PATCH /channels/{channel_id}/messages/{message_id}": {
    "authenticated": true
  },
  "DELETE /channels/{channel_id}/messages/{message_id}": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/messages/{message_id}/ack": {
    "authenticated": true
  },
  "DELETE /channels/{channel_id}/messages/{message_id}/attachments/{attachment_id}": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/messages/{message_id}/crosspost": {
    "authenticated": true
  },
  "GET /channels/{channel_id}/messages/{message_id}/crosspost-source": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/messages/{message_id}/memes": {
    "authenticated": true
  },
  "DELETE /channels/{channel_id}/messages/{message_id}/reactions": {
    "authenticated": true
  },
  "GET /channels/{channel_id}/messages/{message_id}/reactions/{emoji}": {
    "authenticated": true
  },
  "DELETE /channels/{channel_id}/messages/{message_id}/reactions/{emoji}": {
    "authenticated": true
  },
  "PUT /channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me": {
    "authenticated": true
  },
  "DELETE /channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me": {
    "authenticated": true
  },
  "GET /channels/{channel_id}/messages/{message_id}/reactions/{emoji}/users": {
    "authenticated": true
  },
  "DELETE /channels/{channel_id}/messages/{message_id}/reactions/{emoji}/{target_id}": {
    "authenticated": true
  },
  "PUT /channels/{channel_id}/permissions/{overwrite_id}": {
    "authenticated": true
  },
  "DELETE /channels/{channel_id}/permissions/{overwrite_id}": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/pins/ack": {
    "authenticated": true
  },
  "PUT /channels/{channel_id}/pins/{message_id}": {
    "authenticated": true
  },
  "DELETE /channels/{channel_id}/pins/{message_id}": {
    "authenticated": true
  },
  "PUT /channels/{channel_id}/recipients/{user_id}": {
    "authenticated": true
  },
  "DELETE /channels/{channel_id}/recipients/{user_id}": {
    "authenticated": true
  },
  "GET /channels/{channel_id}/rtc-regions": {
    "authenticated": true
  },
  "GET /channels/{channel_id}/slowmode": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/typing": {
    "authenticated": true
  },
  "GET /channels/{channel_id}/webhooks": {
    "authenticated": true
  },
  "POST /channels/{channel_id}/webhooks": {
    "authenticated": true
  },
  "GET /discovery/categories": {
    "authenticated": true
  },
  "GET /discovery/guilds": {
    "authenticated": true
  },
  "POST /discovery/guilds/{guild_id}/join": {
    "authenticated": true
  },
  "POST /donations/checkout": {
    "authenticated": false
  },
  "GET /donations/manage": {
    "authenticated": false
  },
  "POST /donations/manage": {
    "authenticated": false
  },
  "POST /donations/request-link": {
    "authenticated": false
  },
  "GET /emojis/{emoji_id}/metadata": {
    "authenticated": true
  },
  "GET /emojis/{emoji_id}/source": {
    "authenticated": true
  },
  "GET /experiments": {
    "authenticated": true
  },
  "GET /gateway/bot": {
    "authenticated": true
  },
  "GET /gifs/featured": {
    "authenticated": true
  },
  "POST /gifs/register-share": {
    "authenticated": true
  },
  "GET /gifs/search": {
    "authenticated": true
  },
  "GET /gifs/suggest": {
    "authenticated": true
  },
  "GET /gifs/trending": {
    "authenticated": true
  },
  "GET /gifts/{code}": {
    "authenticated": false
  },
  "POST /gifts/{code}/redeem": {
    "authenticated": true
  },
  "POST /guilds": {
    "authenticated": true
  },
  "GET /guilds/{guild_id}": {
    "authenticated": true
  },
  "PATCH /guilds/{guild_id}": {
    "authenticated": true
  },
  "GET /guilds/{guild_id}/audit-logs": {
    "authenticated": true
  },
  "GET /guilds/{guild_id}/bans": {
    "authenticated": true
  },
  "PUT /guilds/{guild_id}/bans/{user_id}": {
    "authenticated": true
  },
  "DELETE /guilds/{guild_id}/bans/{user_id}": {
    "authenticated": true
  },
  "GET /guilds/{guild_id}/channels": {
    "authenticated": true
  },
  "POST /guilds/{guild_id}/channels": {
    "authenticated": true
  },
  "PATCH /guilds/{guild_id}/channels": {
    "authenticated": true
  },
  "POST /guilds/{guild_id}/delete": {
    "authenticated": true
  },
  "GET /guilds/{guild_id}/discovery": {
    "authenticated": true
  },
  "POST /guilds/{guild_id}/discovery": {
    "authenticated": true
  },
  "PATCH /guilds/{guild_id}/discovery": {
    "authenticated": true
  },
  "DELETE /guilds/{guild_id}/discovery": {
    "authenticated": true
  },
  "GET /guilds/{guild_id}/emojis": {
    "authenticated": true
  },
  "POST /guilds/{guild_id}/emojis": {
    "authenticated": true
  },
  "POST /guilds/{guild_id}/emojis/bulk": {
    "authenticated": true
  },
  "POST /guilds/{guild_id}/emojis/clone": {
    "authenticated": true
  },
  "PATCH /guilds/{guild_id}/emojis/{emoji_id}": {
    "authenticated": true
  },
  "DELETE /guilds/{guild_id}/emojis/{emoji_id}": {
    "authenticated": true
  },
  "GET /guilds/{guild_id}/invites": {
    "authenticated": true
  },
  "GET /guilds/{guild_id}/members": {
    "authenticated": true
  },
  "POST /guilds/{guild_id}/members-search": {
    "authenticated": true
  },
  "GET /guilds/{guild_id}/members/@me": {
    "authenticated": true
  },
  "PATCH /guilds/{guild_id}/members/@me": {
    "authenticated": true
  },
  "GET /guilds/{guild_id}/members/{user_id}": {
    "authenticated": true
  },
  "PATCH /guilds/{guild_id}/members/{user_id}": {
    "authenticated": true
  },
  "DELETE /guilds/{guild_id}/members/{user_id}": {
    "authenticated": true
  },
  "PUT /guilds/{guild_id}/members/{user_id}/roles/{role_id}": {
    "authenticated": true
  },
  "DELETE /guilds/{guild_id}/members/{user_id}/roles/{role_id}": {
    "authenticated": true
  },
  "GET /guilds/{guild_id}/roles": {
    "authenticated": true
  },
  "POST /guilds/{guild_id}/roles": {
    "authenticated": true
  },
  "PATCH /guilds/{guild_id}/roles": {
    "authenticated": true
  },
  "PATCH /guilds/{guild_id}/roles/hoist-positions": {
    "authenticated": true
  },
  "DELETE /guilds/{guild_id}/roles/hoist-positions": {
    "authenticated": true
  },
  "PATCH /guilds/{guild_id}/roles/{role_id}": {
    "authenticated": true
  },
  "DELETE /guilds/{guild_id}/roles/{role_id}": {
    "authenticated": true
  },
  "GET /guilds/{guild_id}/stickers": {
    "authenticated": true
  },
  "POST /guilds/{guild_id}/stickers": {
    "authenticated": true
  },
  "POST /guilds/{guild_id}/stickers/bulk": {
    "authenticated": true
  },
  "POST /guilds/{guild_id}/stickers/clone": {
    "authenticated": true
  },
  "PATCH /guilds/{guild_id}/stickers/{sticker_id}": {
    "authenticated": true
  },
  "DELETE /guilds/{guild_id}/stickers/{sticker_id}": {
    "authenticated": true
  },
  "POST /guilds/{guild_id}/transfer-ownership": {
    "authenticated": true
  },
  "GET /guilds/{guild_id}/vanity-url": {
    "authenticated": true
  },
  "PATCH /guilds/{guild_id}/vanity-url": {
    "authenticated": true
  },
  "GET /guilds/{guild_id}/webhooks": {
    "authenticated": true
  },
  "GET /harvest-downloads/{harvestId}": {
    "authenticated": false
  },
  "GET /invites/{invite_code}": {
    "authenticated": false
  },
  "POST /invites/{invite_code}": {
    "authenticated": true
  },
  "DELETE /invites/{invite_code}": {
    "authenticated": true
  },
  "GET /ip": {
    "authenticated": false
  },
  "GET /klipy/featured": {
    "authenticated": true
  },
  "POST /klipy/register-share": {
    "authenticated": true
  },
  "GET /klipy/search": {
    "authenticated": true
  },
  "GET /klipy/suggest": {
    "authenticated": true
  },
  "GET /klipy/trending-gifs": {
    "authenticated": true
  },
  "GET /oauth2/@me": {
    "authenticated": true
  },
  "GET /oauth2/@me/authorizations": {
    "authenticated": true
  },
  "POST /oauth2/@me/authorizations/revoke": {
    "authenticated": true
  },
  "DELETE /oauth2/@me/authorizations/{applicationId}": {
    "authenticated": true
  },
  "POST /oauth2/applications": {
    "authenticated": true
  },
  "GET /oauth2/applications/@me": {
    "authenticated": true
  },
  "GET /oauth2/applications/{id}": {
    "authenticated": true
  },
  "PATCH /oauth2/applications/{id}": {
    "authenticated": true
  },
  "DELETE /oauth2/applications/{id}": {
    "authenticated": true
  },
  "PATCH /oauth2/applications/{id}/bot": {
    "authenticated": true
  },
  "POST /oauth2/applications/{id}/bot/reset-token": {
    "authenticated": true
  },
  "POST /oauth2/applications/{id}/client-secret/reset": {
    "authenticated": true
  },
  "GET /oauth2/applications/{id}/public": {
    "authenticated": false
  },
  "POST /oauth2/authorize/consent": {
    "authenticated": true
  },
  "POST /oauth2/introspect": {
    "authenticated": false
  },
  "POST /oauth2/token": {
    "authenticated": false
  },
  "POST /oauth2/token/revoke": {
    "authenticated": false
  },
  "GET /oauth2/userinfo": {
    "authenticated": true
  },
  "POST /premium/cancel-pending-subscription-change": {
    "authenticated": true
  },
  "POST /premium/cancel-subscription": {
    "authenticated": true
  },
  "POST /premium/change-subscription": {
    "authenticated": true
  },
  "GET /premium/current-subscription-price": {
    "authenticated": true
  },
  "POST /premium/customer-portal": {
    "authenticated": true
  },
  "POST /premium/grace/end": {
    "authenticated": true
  },
  "PATCH /premium/perks-disabled": {
    "authenticated": true
  },
  "GET /premium/price-ids": {
    "authenticated": false
  },
  "POST /premium/reactivate-subscription": {
    "authenticated": true
  },
  "GET /premium/refund-eligibility": {
    "authenticated": true
  },
  "POST /premium/refund-latest": {
    "authenticated": true
  },
  "GET /premium/state": {
    "authenticated": true
  },
  "GET /premium/store": {
    "authenticated": true
  },
  "POST /premium/store/app-store/transactions": {
    "authenticated": true
  },
  "POST /premium/store/google-play/purchases": {
    "authenticated": true
  },
  "GET /premium/store/purchases": {
    "authenticated": true
  },
  "DELETE /premium/store/purchases/{purchase_id}": {
    "authenticated": true
  },
  "POST /premium/switch-to-list-price": {
    "authenticated": true
  },
  "POST /premium/visionary/rejoin": {
    "authenticated": true
  },
  "POST /read-states/ack": {
    "authenticated": true
  },
  "POST /read-states/ack-bulk": {
    "authenticated": true
  },
  "POST /reports/dsa": {
    "authenticated": false
  },
  "POST /reports/dsa/email/send": {
    "authenticated": false
  },
  "POST /reports/dsa/email/verify": {
    "authenticated": false
  },
  "POST /reports/guild": {
    "authenticated": true
  },
  "POST /reports/message": {
    "authenticated": true
  },
  "POST /reports/user": {
    "authenticated": true
  },
  "POST /search/messages": {
    "authenticated": true
  },
  "GET /stickers/{sticker_id}/metadata": {
    "authenticated": true
  },
  "GET /stickers/{sticker_id}/source": {
    "authenticated": true
  },
  "GET /streams/{stream_key}/preview": {
    "authenticated": true
  },
  "POST /streams/{stream_key}/preview": {
    "authenticated": true
  },
  "DELETE /streams/{stream_key}/preview": {
    "authenticated": true
  },
  "POST /streams/{stream_key}/preview/upload-url": {
    "authenticated": true
  },
  "PATCH /streams/{stream_key}/stream": {
    "authenticated": true
  },
  "POST /stripe/checkout/gift": {
    "authenticated": true
  },
  "POST /stripe/checkout/subscription": {
    "authenticated": true
  },
  "POST /stripe/checkout/subscription/preapproval": {
    "authenticated": true
  },
  "POST /stripe/checkout/subscription/preapproval/continue": {
    "authenticated": false
  },
  "POST /stripe/webhook": {
    "authenticated": false
  },
  "GET /tenor/featured": {
    "authenticated": true
  },
  "POST /tenor/register-share": {
    "authenticated": true
  },
  "GET /tenor/search": {
    "authenticated": true
  },
  "GET /tenor/suggest": {
    "authenticated": true
  },
  "GET /tenor/trending-gifs": {
    "authenticated": true
  },
  "POST /unfurl": {
    "authenticated": true
  },
  "GET /users/@me": {
    "authenticated": true
  },
  "PATCH /users/@me": {
    "authenticated": true
  },
  "POST /users/@me/age-verification": {
    "authenticated": true
  },
  "GET /users/@me/applications": {
    "authenticated": true
  },
  "DELETE /users/@me/authorized-ips": {
    "authenticated": true
  },
  "GET /users/@me/channels": {
    "authenticated": true
  },
  "POST /users/@me/channels": {
    "authenticated": true
  },
  "POST /users/@me/channels/messages/preload": {
    "authenticated": true
  },
  "PUT /users/@me/channels/{channel_id}/pin": {
    "authenticated": true
  },
  "DELETE /users/@me/channels/{channel_id}/pin": {
    "authenticated": true
  },
  "GET /users/@me/connections": {
    "authenticated": true
  },
  "POST /users/@me/connections": {
    "authenticated": true
  },
  "POST /users/@me/connections/bluesky/authorize": {
    "authenticated": true
  },
  "PATCH /users/@me/connections/reorder": {
    "authenticated": true
  },
  "POST /users/@me/connections/verify": {
    "authenticated": true
  },
  "PATCH /users/@me/connections/{type}/{connection_id}": {
    "authenticated": true
  },
  "DELETE /users/@me/connections/{type}/{connection_id}": {
    "authenticated": true
  },
  "POST /users/@me/delete": {
    "authenticated": true
  },
  "POST /users/@me/disable": {
    "authenticated": true
  },
  "POST /users/@me/email-change/apply": {
    "authenticated": true
  },
  "POST /users/@me/email-change/bounced/request-new": {
    "authenticated": true
  },
  "POST /users/@me/email-change/bounced/resend-new": {
    "authenticated": true
  },
  "POST /users/@me/email-change/bounced/verify-new": {
    "authenticated": true
  },
  "POST /users/@me/email-change/request-new": {
    "authenticated": true
  },
  "POST /users/@me/email-change/resend-new": {
    "authenticated": true
  },
  "POST /users/@me/email-change/resend-original": {
    "authenticated": true
  },
  "POST /users/@me/email-change/start": {
    "authenticated": true
  },
  "POST /users/@me/email-change/verify-new": {
    "authenticated": true
  },
  "POST /users/@me/email-change/verify-original": {
    "authenticated": true
  },
  "PUT /users/@me/entrance-sound-selections": {
    "authenticated": true
  },
  "GET /users/@me/entrance-sounds": {
    "authenticated": true
  },
  "POST /users/@me/entrance-sounds": {
    "authenticated": true
  },
  "PATCH /users/@me/entrance-sounds/{sound_id}": {
    "authenticated": true
  },
  "DELETE /users/@me/entrance-sounds/{sound_id}": {
    "authenticated": true
  },
  "POST /users/@me/favorite-gifs/resolve": {
    "authenticated": true
  },
  "GET /users/@me/gifts": {
    "authenticated": true
  },
  "GET /users/@me/guilds": {
    "authenticated": true
  },
  "PATCH /users/@me/guilds/@me/settings": {
    "authenticated": true
  },
  "DELETE /users/@me/guilds/{guild_id}": {
    "authenticated": true
  },
  "POST /users/@me/guilds/{guild_id}/messages/bulk-delete-mine": {
    "authenticated": true
  },
  "PATCH /users/@me/guilds/{guild_id}/settings": {
    "authenticated": true
  },
  "POST /users/@me/harvest": {
    "authenticated": true
  },
  "POST /users/@me/harvest/filtered": {
    "authenticated": true
  },
  "GET /users/@me/harvest/latest": {
    "authenticated": true
  },
  "GET /users/@me/harvest/{harvestId}": {
    "authenticated": true
  },
  "GET /users/@me/harvest/{harvestId}/download": {
    "authenticated": true
  },
  "GET /users/@me/memes": {
    "authenticated": true
  },
  "POST /users/@me/memes": {
    "authenticated": true
  },
  "GET /users/@me/memes/{meme_id}": {
    "authenticated": true
  },
  "PATCH /users/@me/memes/{meme_id}": {
    "authenticated": true
  },
  "DELETE /users/@me/memes/{meme_id}": {
    "authenticated": true
  },
  "GET /users/@me/mentions": {
    "authenticated": true
  },
  "POST /users/@me/mentions/read": {
    "authenticated": true
  },
  "DELETE /users/@me/mentions/{message_id}": {
    "authenticated": true
  },
  "POST /users/@me/messages/bulk-delete-mine": {
    "authenticated": true
  },
  "POST /users/@me/messages/delete": {
    "authenticated": true
  },
  "DELETE /users/@me/messages/delete": {
    "authenticated": true
  },
  "POST /users/@me/mfa/backup-codes": {
    "authenticated": true
  },
  "POST /users/@me/mfa/backup-codes/challenge": {
    "authenticated": true
  },
  "POST /users/@me/mfa/backup-codes/challenge/regenerate": {
    "authenticated": true
  },
  "POST /users/@me/mfa/backup-codes/challenge/resend": {
    "authenticated": true
  },
  "POST /users/@me/mfa/backup-codes/challenge/verify": {
    "authenticated": true
  },
  "POST /users/@me/mfa/totp/disable": {
    "authenticated": true
  },
  "POST /users/@me/mfa/totp/enable": {
    "authenticated": true
  },
  "GET /users/@me/mfa/webauthn/credentials": {
    "authenticated": true
  },
  "POST /users/@me/mfa/webauthn/credentials": {
    "authenticated": true
  },
  "POST /users/@me/mfa/webauthn/credentials/registration-options": {
    "authenticated": true
  },
  "PATCH /users/@me/mfa/webauthn/credentials/{credential_id}": {
    "authenticated": true
  },
  "DELETE /users/@me/mfa/webauthn/credentials/{credential_id}": {
    "authenticated": true
  },
  "GET /users/@me/mfa/webauthn/migration": {
    "authenticated": true
  },
  "POST /users/@me/mfa/webauthn/migration": {
    "authenticated": true
  },
  "POST /users/@me/mfa/webauthn/migration/registration-options": {
    "authenticated": true
  },
  "PUT /users/@me/mfa/webauthn/two-factor": {
    "authenticated": true
  },
  "GET /users/@me/mobile-devices": {
    "authenticated": true
  },
  "POST /users/@me/mobile-devices": {
    "authenticated": true
  },
  "POST /users/@me/mobile-devices/unregister": {
    "authenticated": true
  },
  "DELETE /users/@me/mobile-devices/{device_id}": {
    "authenticated": true
  },
  "GET /users/@me/notes": {
    "authenticated": true
  },
  "GET /users/@me/notes/{target_id}": {
    "authenticated": true
  },
  "PUT /users/@me/notes/{target_id}": {
    "authenticated": true
  },
  "POST /users/@me/passkey-bridge": {
    "authenticated": true
  },
  "POST /users/@me/passkey-bridge/{ceremony_id}/redeem": {
    "authenticated": true
  },
  "POST /users/@me/password-change/complete": {
    "authenticated": true
  },
  "POST /users/@me/password-change/resend": {
    "authenticated": true
  },
  "POST /users/@me/password-change/start": {
    "authenticated": true
  },
  "POST /users/@me/password-change/verify": {
    "authenticated": true
  },
  "POST /users/@me/phone/inbound-challenge": {
    "authenticated": true
  },
  "POST /users/@me/phone/send-verification": {
    "authenticated": true
  },
  "POST /users/@me/phone/verify": {
    "authenticated": true
  },
  "POST /users/@me/preload-messages": {
    "authenticated": true
  },
  "POST /users/@me/premium/reset": {
    "authenticated": true
  },
  "POST /users/@me/push/rotate": {
    "authenticated": true
  },
  "POST /users/@me/push/subscribe": {
    "authenticated": true
  },
  "GET /users/@me/push/subscriptions": {
    "authenticated": true
  },
  "DELETE /users/@me/push/subscriptions/{subscription_id}": {
    "authenticated": true
  },
  "GET /users/@me/relationships": {
    "authenticated": true
  },
  "POST /users/@me/relationships": {
    "authenticated": true
  },
  "POST /users/@me/relationships/bulk-ignore": {
    "authenticated": true
  },
  "POST /users/@me/relationships/{user_id}": {
    "authenticated": true
  },
  "PUT /users/@me/relationships/{user_id}": {
    "authenticated": true
  },
  "PATCH /users/@me/relationships/{user_id}": {
    "authenticated": true
  },
  "DELETE /users/@me/relationships/{user_id}": {
    "authenticated": true
  },
  "GET /users/@me/required-actions/phone-gate-escape": {
    "authenticated": true
  },
  "POST /users/@me/required-actions/phone-gate-escape": {
    "authenticated": true
  },
  "GET /users/@me/saved-messages": {
    "authenticated": true
  },
  "POST /users/@me/saved-messages": {
    "authenticated": true
  },
  "DELETE /users/@me/saved-messages/{message_id}": {
    "authenticated": true
  },
  "GET /users/@me/settings": {
    "authenticated": true
  },
  "PATCH /users/@me/settings": {
    "authenticated": true
  },
  "PUT /users/@me/settings/voice-activity-sharing": {
    "authenticated": true
  },
  "GET /users/@me/sudo/mfa-methods": {
    "authenticated": true
  },
  "POST /users/@me/sudo/webauthn/authentication-options": {
    "authenticated": true
  },
  "POST /users/@me/terms-acceptance": {
    "authenticated": true
  },
  "POST /users/@me/themes": {
    "authenticated": true
  },
  "GET /users/check-tag": {
    "authenticated": true
  },
  "GET /users/{target_id}/profile": {
    "authenticated": true
  },
  "GET /users/{user_id}": {
    "authenticated": true
  },
  "POST /voice/channels/{channel_id}/entrance-sound": {
    "authenticated": true
  },
  "GET /webhooks/{webhook_id}": {
    "authenticated": true
  },
  "PATCH /webhooks/{webhook_id}": {
    "authenticated": true
  },
  "DELETE /webhooks/{webhook_id}": {
    "authenticated": true
  },
  "GET /webhooks/{webhook_id}/{token}": {
    "authenticated": false
  },
  "POST /webhooks/{webhook_id}/{token}": {
    "authenticated": false
  },
  "PATCH /webhooks/{webhook_id}/{token}": {
    "authenticated": false
  },
  "DELETE /webhooks/{webhook_id}/{token}": {
    "authenticated": false
  },
  "POST /webhooks/{webhook_id}/{token}/github": {
    "authenticated": false
  },
  "POST /webhooks/{webhook_id}/{token}/instatus": {
    "authenticated": false
  },
  "GET /webhooks/{webhook_id}/{token}/messages/{message_id}": {
    "authenticated": false
  },
  "PATCH /webhooks/{webhook_id}/{token}/messages/{message_id}": {
    "authenticated": false
  },
  "DELETE /webhooks/{webhook_id}/{token}/messages/{message_id}": {
    "authenticated": false
  },
  "POST /webhooks/{webhook_id}/{token}/slack": {
    "authenticated": false
  }
} as const;
