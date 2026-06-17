import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectMention, detectReplyToBot, extractReply, normalizeMessage } from './normalize.mjs'
import { findNativeVoiceTranscript } from './voice-transcription.mjs'

test('extractReply uses explicit raw quote fields', () => {
  const { reply, text } = extractReply(
    {
      referMsg: {
        msgId: 'quoted-id',
        title: 'Alice',
        content: 'quoted body',
      },
    },
    'reply body',
  )
  assert.equal(text, 'reply body')
  assert.equal(reply.messageId, 'quoted-id')
  assert.equal(reply.sender, 'Alice')
  assert.equal(reply.preview, 'quoted body')
  assert.equal(reply.raw.source, 'referMsg')
})

test('extractReply falls back to WeChat visible quote text', () => {
  const { reply, text } = extractReply({}, '「Bob：hello」\n- - - - - - - - - - - - - - -\nlook at this')
  assert.equal(text, 'look at this')
  assert.equal(reply.sender, 'Bob')
  assert.equal(reply.preview, 'hello')
  assert.equal(reply.raw.source, 'text_fallback')
})

test('normalizeMessage maps sender, room, quote and image attachment', async () => {
  const message = {
    id: 'msg-1',
    payload: { roomId: 'room-1', talkerId: 'wxid-a' },
    type: () => 6,
    toFileBox: async () => ({
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      toFile: async (filePath) => {
        await import('node:fs/promises').then((fs) => fs.writeFile(filePath, 'jpeg-data'))
      },
    }),
  }
  const room = { id: 'room-1' }
  const talker = { id: 'wxid-a', self: () => false }
  const normalized = await normalizeMessage(
    message,
    { bot: { Message: { Type: { 6: 'Image' } } }, room, roomTopic: 'Room', talker, talkerName: 'Alice', talkerAlias: 'A' },
    { mediaDir: await import('node:os').then((os) => os.tmpdir()) },
  )
  assert.equal(normalized.sender.id, 'wxid-a')
  assert.equal(normalized.conversation.type, 'group')
  assert.equal(normalized.replyTarget, 'room:room-1')
  assert.equal(normalized.attachments[0].type, 'image')
  assert.equal(normalized.attachments[0].mime, 'image/jpeg')
})

test('normalizeMessage saves Office files as file attachments with inferred mime', async () => {
  const message = {
    id: 'msg-file',
    payload: { talkerId: 'wxid-a' },
    type: () => 2,
    toFileBox: async () => ({
      name: 'report.xlsx',
      mimeType: 'application/octet-stream',
      toFile: async (filePath) => {
        await import('node:fs/promises').then((fs) => fs.writeFile(filePath, 'xlsx-data'))
      },
    }),
  }
  const talker = { id: 'wxid-a', self: () => false }
  const normalized = await normalizeMessage(
    message,
    { bot: { Message: { Type: { 2: 'Attachment' } } }, talker, talkerName: 'Alice', talkerAlias: 'A' },
    { mediaDir: await import('node:os').then((os) => os.tmpdir()) },
  )
  assert.equal(normalized.attachments[0].type, 'file')
  assert.equal(normalized.attachments[0].name, 'report.xlsx')
  assert.equal(normalized.attachments[0].mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.equal(normalized.attachments[0].metadata.extension, '.xlsx')
  assert.equal(normalized.attachments[0].metadata.wechatType, 'Attachment')
})

test('normalizeMessage saves Word files as file attachments with inferred mime', async () => {
  const message = {
    id: 'msg-word',
    payload: { talkerId: 'wxid-a' },
    type: () => 2,
    toFileBox: async () => ({
      name: 'notes.docx',
      toFile: async (filePath) => {
        await import('node:fs/promises').then((fs) => fs.writeFile(filePath, 'docx-data'))
      },
    }),
  }
  const talker = { id: 'wxid-a', self: () => false }
  const normalized = await normalizeMessage(
    message,
    { bot: { Message: { Type: { 2: 'Attachment' } } }, talker, talkerName: 'Alice', talkerAlias: 'A' },
    { mediaDir: await import('node:os').then((os) => os.tmpdir()) },
  )
  assert.equal(normalized.attachments[0].type, 'file')
  assert.equal(normalized.attachments[0].mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(normalized.attachments[0].metadata.extension, '.docx')
})

test('detectMention accepts WeChat mention spacing and strips leading bot mention', () => {
  const result = detectMention("@Netr0's Bot\u2005我的名字是什么", {}, { botMentionName: "Netr0's Bot" })
  assert.equal(result.isMentioned, true)
  assert.equal(result.text, '我的名字是什么')
})

test('normalizeMessage marks group bot mention', async () => {
  const message = {
    id: 'msg-mention',
    payload: { roomId: 'room-1', talkerId: 'wxid-a' },
    type: () => 7,
    text: () => "@Netr0's Bot\u2005ping",
  }
  const room = { id: 'room-1' }
  const talker = { id: 'wxid-a', self: () => false }
  const normalized = await normalizeMessage(
    message,
    { bot: { Message: { Type: { 7: 'Text' } } }, room, roomTopic: 'Room', talker, talkerName: 'Alice', talkerAlias: 'A' },
    { botMentionName: "Netr0's Bot", mediaDir: await import('node:os').then((os) => os.tmpdir()) },
  )
  assert.equal(normalized.isMentioned, true)
  assert.equal(normalized.text, 'ping')
})

test('detectReplyToBot uses outbound ids and sender names', () => {
  assert.equal(
    detectReplyToBot({ messageId: 'bot-msg-1', sender: 'Alice' }, {}, {}, { has: (id) => id === 'bot-msg-1' }),
    true,
  )
  assert.equal(
    detectReplyToBot({ sender: "Netr0's Bot" }, { receiverName: "Netr0's Bot" }, {}, null),
    true,
  )
  assert.equal(
    detectReplyToBot({ sender: 'Alice' }, { receiverName: "Netr0's Bot" }, {}, null),
    false,
  )
})

test('normalizeMessage marks group quote of bot message as reply to bot', async () => {
  const message = {
    id: 'msg-quote-bot',
    payload: {
      roomId: 'room-1',
      talkerId: 'wxid-a',
      referMsg: { msgId: 'bot-msg-1', title: 'Alice', content: 'bot answer' },
    },
    type: () => 7,
    text: () => 'follow up',
  }
  const room = { id: 'room-1' }
  const talker = { id: 'wxid-a', self: () => false }
  const normalized = await normalizeMessage(
    message,
    {
      bot: { Message: { Type: { 7: 'Text' } } },
      room,
      roomTopic: 'Room',
      talker,
      talkerName: 'Alice',
      talkerAlias: 'A',
      outboundStore: { has: (id) => id === 'bot-msg-1' },
    },
    { botMentionName: "Netr0's Bot", mediaDir: await import('node:os').then((os) => os.tmpdir()) },
  )
  assert.equal(normalized.isMentioned, false)
  assert.equal(normalized.isReplyToBot, true)
  assert.equal(normalized.reply.messageId, 'bot-msg-1')
})

test('findNativeVoiceTranscript reads WeChat native raw fields', () => {
  const found = findNativeVoiceTranscript({
    MsgType: 34,
    VoiceLength: 2600,
    VoiceTransText: '帮我看一下这个表',
  })
  assert.equal(found.text, '帮我看一下这个表')
  assert.equal(found.source, 'VoiceTransText')
})

test('findNativeVoiceTranscript reads WeChat native XML payloads', () => {
  const found = findNativeVoiceTranscript({
    MsgType: 34,
    Content: '<msg><voicetranstext><![CDATA[今晚几点开会]]></voicetranstext></msg>',
  })
  assert.equal(found.text, '今晚几点开会')
  assert.equal(found.source, 'Content.xml:voicetranstext')
})

test('normalizeMessage maps native voice transcription to text', async () => {
  const message = {
    id: 'msg-voice',
    payload: {
      talkerId: 'wxid-a',
      VoiceLength: 3200,
      VoiceTransText: '总结一下这个语音',
    },
    type: () => 3,
    toFileBox: async () => ({
      name: 'message-msg-voice-audio.sil',
      metadata: { voiceLength: 3200 },
      toFile: async (filePath) => {
        await import('node:fs/promises').then((fs) => fs.writeFile(filePath, 'silk-data'))
      },
    }),
  }
  const talker = { id: 'wxid-a', self: () => false }
  const normalized = await normalizeMessage(
    message,
    { bot: { Message: { Type: { 3: 'Audio' } } }, talker, talkerName: 'Alice', talkerAlias: 'A' },
    { mediaDir: await import('node:os').then((os) => os.tmpdir()), diagnosticRawPayload: true },
  )
  assert.equal(normalized.type, 'Audio')
  assert.equal(normalized.text, '总结一下这个语音')
  assert.equal(normalized.raw.nativeVoiceTranscription.provider, 'wechat_native')
  assert.equal(normalized.raw.nativeVoiceTranscription.source, 'VoiceTransText')
  assert.equal(normalized.raw.suppressedAudioAttachments, 1)
  assert.deepEqual(normalized.attachments, [])
})

test('normalizeMessage falls back to WeChat official voice transcription', async () => {
  const message = {
    id: 'msg-official-voice',
    payload: {
      talkerId: 'wxid-a',
      VoiceLength: 3200,
    },
    type: () => 3,
    toFileBox: async () => ({
      name: 'message-msg-official-voice-audio.mp3',
      mimeType: 'audio/mpeg',
      metadata: { voiceLength: 3200 },
      toFile: async (filePath) => {
        await import('node:fs/promises').then((fs) => fs.writeFile(filePath, 'mp3-data'))
      },
    }),
  }
  const talker = { id: 'wxid-a', self: () => false }
  const normalized = await normalizeMessage(
    message,
    { bot: { Message: { Type: { 3: 'Audio' } } }, talker, talkerName: 'Alice', talkerAlias: 'A' },
    {
      mediaDir: await import('node:os').then((os) => os.tmpdir()),
      diagnosticRawPayload: true,
      wechatOfficialVoiceTranscription: true,
      wechatOfficialVoiceTranscriber: async ({ attachment }) => {
        assert.equal(attachment.mime, 'audio/mpeg')
        return { text: '这是官方接口识别出的语音', source: 'test_stub', voiceId: 'voice-test' }
      },
    },
  )
  assert.equal(normalized.type, 'Audio')
  assert.equal(normalized.text, '这是官方接口识别出的语音')
  assert.equal(normalized.raw.suppressedAudioAttachments, 1)
  assert.deepEqual(normalized.attachments, [])
  assert.equal(normalized.raw.officialVoiceTranscription.provider, 'wechat_official')
  assert.equal(normalized.raw.officialVoiceTranscription.source, 'test_stub')
  assert.equal(normalized.raw.officialVoiceTranscription.voiceId, 'voice-test')
})
