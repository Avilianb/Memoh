import fs from 'node:fs'
import path from 'node:path'
import { extractNativeVoiceTranscription } from './voice-transcription.mjs'
import { extractWeChatOfficialVoiceTranscription } from './wechat-official-voice.mjs'

const MIME_BY_EXT = {
  '.amr': 'audio/amr',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rar': 'application/vnd.rar',
  '.rtf': 'application/rtf',
  '.sil': 'audio/silk',
  '.tar': 'application/x-tar',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
}

const TYPE_NAMES = {
  2: 'Attachment',
  3: 'Audio',
  4: 'Contact',
  5: 'Emoticon',
  6: 'Image',
  7: 'Text',
  8: 'Video',
  9: 'Url',
  10: 'MiniProgram',
}

function clean(value) {
  return String(value || '').trim()
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentionNameCandidates(context, cfg) {
  const values = [cfg?.botMentionName, context?.receiverName]
  const out = []
  const seen = new Set()
  for (const value of values) {
    const name = clean(value).replace(/^@+/, '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

function identityCandidates(context, cfg) {
  return [
    cfg?.botMentionName,
    cfg?.sessionName,
    context?.receiverName,
    context?.receiver?.id,
  ]
}

function canonicalIdentity(value) {
  return clean(value)
    .replace(/^@+/, '')
    .replace(/\s+/gu, ' ')
    .toLowerCase()
}

export function detectMention(text, context = {}, cfg = {}) {
  const value = String(text || '')
  for (const name of mentionNameCandidates(context, cfg)) {
    const escaped = escapeRegExp(name)
    const token = new RegExp(`(^|\\s)@${escaped}(?=$|\\s)`, 'u')
    if (!token.test(value)) continue

    const prefix = new RegExp(`^\\s*@${escaped}\\s*`, 'u')
    return {
      isMentioned: true,
      text: value.replace(prefix, '').trim(),
    }
  }
  return { isMentioned: false, text: value }
}

function safeName(value, fallback) {
  const name = clean(value || fallback).replace(/[^\w.\-()\u4e00-\u9fff]+/g, '_')
  return name || fallback
}

function typeName(message, bot) {
  const numeric = message.type?.()
  return bot?.Message?.Type?.[numeric] || TYPE_NAMES[numeric] || String(numeric || 'Unknown')
}

function extensionFromName(name) {
  return path.extname(clean(name)).toLowerCase()
}

function inferMime(name, provided = '') {
  const mime = clean(provided)
  if (mime && mime !== 'application/octet-stream') return mime
  return MIME_BY_EXT[extensionFromName(name)] || mime || 'application/octet-stream'
}

function attachmentKind(msgType, fileName, mime) {
  const normalizedType = clean(msgType).toLowerCase()
  const normalizedMime = clean(mime).toLowerCase()
  const ext = extensionFromName(fileName)
  if (normalizedType === 'image' || normalizedMime.startsWith('image/')) return normalizedMime === 'image/gif' ? 'gif' : 'image'
  if (normalizedType === 'emoticon') return 'gif'
  if (normalizedType === 'audio' || normalizedMime.startsWith('audio/')) return 'audio'
  if (normalizedType === 'video' || normalizedMime.startsWith('video/')) return 'video'
  if (ext === '.gif') return 'gif'
  return 'file'
}

function pickReplyCandidate(payload = {}) {
  const keys = ['quote', 'quoted', 'refer', 'referMsg', 'refMsg', 'reply', 'source', 'appmsg', 'appMsg']
  for (const key of keys) {
    const value = payload?.[key]
    if (value && typeof value === 'object') return { key, value }
  }
  return null
}

function extractTextFallbackQuote(text) {
  const value = String(text || '')
  const marker = '- - - - - - - - - - - - - - -'
  if (!value.includes(marker)) return null
  const [quotedBlock, ...rest] = value.split(marker)
  const body = rest.join(marker).trim()
  const match = quotedBlock.match(/「([^:：\n]+)[:：]([\s\S]*?)」/)
  if (!match) return null
  return {
    reply: {
      sender: match[1].trim(),
      preview: match[2].trim(),
      raw: { source: 'text_fallback' },
    },
    text: body,
  }
}

export function extractReply(payload, text) {
  const candidate = pickReplyCandidate(payload)
  if (candidate) {
    const value = candidate.value
    return {
      reply: {
        messageId: clean(value.id || value.msgId || value.msgid || value.messageId || value.newMsgId),
        sender: clean(value.sender || value.fromUserName || value.from || value.title),
        preview: clean(value.text || value.content || value.message || value.displayContent || value.description),
        raw: { source: candidate.key },
      },
      text,
    }
  }
  return extractTextFallbackQuote(text) || { reply: null, text }
}

export function detectReplyToBot(reply, context = {}, cfg = {}, outboundStore = null) {
  if (!reply) return false
  if (reply.messageId && outboundStore?.has?.(reply.messageId)) return true
  const sender = canonicalIdentity(reply.sender)
  if (!sender) return false
  return identityCandidates(context, cfg).some((candidate) => canonicalIdentity(candidate) === sender)
}

function rawPayload(message, cfg) {
  if (!cfg.diagnosticRawPayload) return undefined
  const payload = message.payload || {}
  const allowed = [
    'id',
    'type',
    'filename',
    'text',
    'talkerId',
    'listenerId',
    'roomId',
    'timestamp',
    'Content',
    'OriContent',
    'VoiceLength',
    'VoiceTransText',
    'VoiceTranslateText',
    'VoiceTransContent',
    'TransContent',
    'TranslateContent',
    'Recognition',
    'RecognitionText',
    'SpeechText',
    'quote',
    'quoted',
    'refer',
    'referMsg',
    'refMsg',
    'reply',
    'source',
    'appmsg',
    'appMsg',
  ]
  return Object.fromEntries(allowed.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]))
}

async function saveFileBox(fileBox, cfg, messageId, msgType) {
  if (!fileBox) return null
  const name = safeName(fileBox.name, `${messageId}-attachment`)
  const mime = inferMime(name, fileBox.mimeType || fileBox.mediaType)
  const kind = attachmentKind(msgType, name, mime)
  const extension = extensionFromName(name)
  const dir = path.resolve(cfg.mediaDir, new Date().toISOString().slice(0, 10))
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const filePath = path.join(dir, `${messageId}-${name}`)
  await fileBox.toFile(filePath, true)
  const stat = fs.statSync(filePath)
  const fileBoxMetadata = fileBox.metadata && typeof fileBox.metadata === 'object' ? fileBox.metadata : {}
  return {
    type: kind || 'file',
    path: filePath,
    name,
    size: stat.size,
    mime,
    metadata: {
      ...fileBoxMetadata,
      extension,
      wechatType: msgType,
    },
  }
}

export async function extractAttachments(message, cfg, msgType) {
  if (msgType === 'Text') return []
  if (typeof message.toFileBox !== 'function') return []
  try {
    const fileBox = await message.toFileBox()
    const att = await saveFileBox(fileBox, cfg, message.id, msgType)
    return att ? [{ ...att, variant: 'wechaty_filebox' }] : []
  } catch (error) {
    return [
      {
        type: 'file',
        name: `${message.id}.unresolved`,
        base64: `data:text/plain;base64,${Buffer.from(error?.message || String(error)).toString('base64')}`,
        mime: 'text/plain',
        metadata: { error: 'filebox_unavailable' },
      },
    ]
  }
}

export async function normalizeMessage(message, context, cfg) {
  const msgType = typeName(message, context.bot)
  const nativeVoiceTranscript = await extractNativeVoiceTranscription(message, context, cfg, msgType)
  const attachments = await extractAttachments(message, cfg, msgType)
  const officialVoiceTranscript = nativeVoiceTranscript
    ? null
    : await extractWeChatOfficialVoiceTranscription(message, context, cfg, msgType, attachments)
  const voiceTranscript = nativeVoiceTranscript || (officialVoiceTranscript?.text ? officialVoiceTranscript : null)
  const rawText = msgType === 'Text' ? message.text?.() || '' : voiceTranscript?.text || ''
  const { reply, text: replyText } = extractReply(message.payload || {}, rawText)
  const mention = detectMention(replyText, context, cfg)
  const isReplyToBot = Boolean(context.room && detectReplyToBot(reply, context, cfg, context.outboundStore))
  if (!clean(mention.text) && attachments.length === 0 && !reply) return null
  const room = context.room
  const conversation = room
    ? { id: clean(room.id || message.payload?.roomId), type: 'group', name: context.roomTopic }
    : { id: clean(context.talker?.id || message.payload?.talkerId), type: 'private', name: context.talkerAlias || context.talkerName }
  return {
    id: clean(message.id || message.payload?.id),
    type: msgType,
    text: mention.text,
    timestamp: new Date().toISOString(),
    replyTarget: room ? `room:${conversation.id}` : `contact:${clean(context.talker?.id || message.payload?.talkerId)}`,
    isMentioned: Boolean(room && mention.isMentioned),
    isReplyToBot,
    sender: {
      id: clean(context.talker?.id || message.payload?.talkerId),
      name: context.talkerName,
      alias: context.talkerAlias,
      remark: context.talkerAlias,
      displayName: context.talkerAlias || context.talkerName,
      self: Boolean(context.talker?.self?.()),
    },
    conversation,
    reply,
    attachments,
    raw: {
      ...rawPayload(message, cfg),
      ...(nativeVoiceTranscript ? { nativeVoiceTranscription: { provider: nativeVoiceTranscript.provider, source: nativeVoiceTranscript.source } } : {}),
      ...(officialVoiceTranscript
        ? {
            officialVoiceTranscription: {
              provider: officialVoiceTranscript.provider,
              source: officialVoiceTranscript.source,
              ...(officialVoiceTranscript.voiceId ? { voiceId: officialVoiceTranscript.voiceId } : {}),
              ...(officialVoiceTranscript.error ? { error: officialVoiceTranscript.error } : {}),
            },
          }
        : {}),
    },
  }
}
