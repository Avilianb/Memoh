# Personal WeChat Channel

`personal_wechat` is a Memoh-native channel for personal WeChat accounts. It does not call Memoh's web message API. The Go adapter owns channel registration, configuration, lifecycle, routing and Memoh message normalization. A Node sidecar owns Wechaty login, WeChat events, media download and outbound delivery.

## Architecture

- Go adapter: `internal/channel/adapters/personalwechat`
- Sidecar: `packages/personal-wechat-bridge`
- Protocol: newline-delimited JSON over sidecar stdout/stdin
- Channel type: `personal_wechat`

Inbound sidecar event:

```json
{"type":"message","message":{"id":"...","text":"...","sender":{"id":"..."},"conversation":{"id":"...","type":"group"},"replyTarget":"room:...","isMentioned":false,"isReplyToBot":true,"reply":{"messageId":"...","sender":"...","preview":"..."},"attachments":[{"type":"image","path":"/data/media/a.jpg","mime":"image/jpeg"}]}}
```

Outbound Go command:

```json
{"type":"send","target":"contact:wxid_xxx","message":{"text":"hello"}}
```

## Configuration

- `bridgeExecutable`: executable for the sidecar, default `node`
- `bridgeScript`: sidecar script, default `packages/personal-wechat-bridge/bin/personal-wechat-bridge.mjs`
- `dataDir`: persistent Wechaty session and diagnostics directory
- `mediaDir`: inbound media directory
- `sessionName`: Wechaty memory-card name
- `botMentionName`: bot display name used for group mention and quote-sender fallback detection
- `allowPrivate`, `allowGroups`: coarse inbound switches
- `nativeVoiceTranscription`: reads WeChat voice-to-text fields when they already exist on the incoming message
- `wechatOfficialVoiceTranscription`: enables fallback voice-to-text through WeChat's official intelligent voice API
- `wechatOfficialAppId`, `wechatOfficialAppSecret`: credentials used to fetch `access_token` for the official API
- `wechatOfficialAccessToken`: optional static `access_token`; AppID/AppSecret are preferred for automatic refresh
- `wechatOfficialVoiceLang`: `zh_CN` or `en_US`, default `zh_CN`
- `wechatOfficialVoiceApiBase`: default `https://api.weixin.qq.com`
- `wechatOfficialVoiceFfmpeg`: executable used to convert voice attachments to `mp3`, `16k`, mono
- `contactWhitelist`, `groupWhitelist`: comma-separated IDs or display names; empty means allow all for the enabled chat type
- `diagnosticRawPayload`: includes sanitized raw payload fields for quote/media verification

## Capability Notes

Sender identity is mapped from Wechaty `talker()` and room context into `channel.Identity` and `channel.Conversation`.

Quote support is evidence-based. The sidecar first checks raw payload fields such as `quote`, `referMsg`, `refMsg`, `reply`, `source`, and `appmsg`. If they are absent, it parses WeChat's visible quote text form as a fallback and marks `reply.raw.source = "text_fallback"`. If neither raw fields nor text fallback are present, `Message.Reply` is omitted.

Group quote triggering uses Memoh's native `is_reply_to_bot` directed-message path. The sidecar keeps a bounded, persisted set of recently observed outbound bot message IDs under `dataDir` and marks inbound quote messages as `isReplyToBot` when the quoted `messageId` is in that set. If WeChat does not expose a stable quoted message ID, it falls back to matching the quoted sender against `botMentionName`, `sessionName`, the receiver name, or the receiver ID.

Images and generic files are received through Wechaty `message.toFileBox()`, saved under `mediaDir`, and passed to Memoh as attachments with `Path`, `Mime`, `Name`, and `Size`. Image/audio/video/gif files are classified by Wechaty type, MIME, or extension; Office documents (`.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`), PDF, text, CSV, JSON, Markdown, and archives fall back to `Attachment{Type:file}` with extension metadata. Outbound attachments are evaluated through the same sidecar protocol, but real WeChat file sending still depends on the account and `wechaty-puppet-wechat4u` filebox behavior.

Voice handling has two layers. First, the sidecar reads native WeChat transcript fields if the payload already contains them. If `wechatOfficialVoiceTranscription` is enabled and native transcript fields are absent, the sidecar uploads the saved voice attachment to WeChat's official intelligent voice-to-text API: it converts the attachment to `mp3`, `16k`, mono with FFmpeg, calls `/cgi-bin/media/voice/addvoicetorecofortext`, then polls `/cgi-bin/media/voice/queryrecoresultfortext` within the documented 10-second window. This is the public Service Account/Mini Program/Open Platform API path, not the private PC client MMTLS "convert to text" button path.

## Verification

Run unit tests:

```bash
go test ./internal/channel/adapters/personalwechat
pnpm --filter @memohai/personal-wechat-bridge test
```

For real WeChat verification, enable `diagnosticRawPayload`, start the channel, scan the QR code printed by the sidecar, then send:

1. A private text message and a group mention.
2. A WeChat quote/reply message mentioning the bot.
3. A WeChat quote/reply message that quotes a recent bot message without an @ mention.
4. An image.
5. A generic file such as `.xlsx`, `.docx`, or `.pdf`.
6. A voice message with `wechatOfficialVoiceTranscription` enabled and official WeChat credentials configured.

Check logs for `message.raw` keys and media files in `mediaDir`. Report quote as verified only when raw quote fields are present; otherwise report text-fallback only.
