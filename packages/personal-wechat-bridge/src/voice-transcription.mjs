const VOICE_TYPES = new Set(['Audio', 'Voice'])

function clean(value) {
  return String(value || '').trim()
}

function decodeXmlEntities(value) {
  return clean(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function stripCdata(value) {
  return clean(value).replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim()
}

function cleanTranscript(value) {
  const text = stripCdata(decodeXmlEntities(value))
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!text) return ''
  if (/^(@@?|wxid_|gh_|filehelper)/u.test(text)) return ''
  return text
}

function transcriptKey(key) {
  const normalized = clean(key).replace(/[_\-\s]/g, '').toLowerCase()
  if (!normalized) return false
  const explicit = new Set([
    'recognition',
    'recognitiontext',
    'recognizedtext',
    'speechtext',
    'transcontent',
    'transcript',
    'transcription',
    'transcriptiontext',
    'translatedtext',
    'translatecontent',
    'voicerecognition',
    'voicerecognitiontext',
    'voicespeechtext',
    'voicetext',
    'voicetranscontent',
    'voicetranscript',
    'voicetranscription',
    'voicetranscriptiontext',
    'voicetranslatecontent',
    'voicetranslatetext',
    'voicetranstext',
  ])
  if (explicit.has(normalized)) return true
  if (normalized.includes('voice') && (normalized.includes('text') || normalized.includes('trans') || normalized.includes('recogn'))) return true
  if ((normalized.includes('trans') || normalized.includes('recogn')) && (normalized.includes('text') || normalized.includes('content'))) return true
  return false
}

function extractTranscriptFromXml(value) {
  const xml = decodeXmlEntities(value)
  if (!xml.includes('<')) return null

  const attr = xml.match(/\b(?:voice)?(?:trans|recogn)[\w-]*(?:text|content)?\s*=\s*"([^"]+)"/iu)
  if (attr) {
    const text = cleanTranscript(attr[1])
    if (text) return { text, source: 'xml_attribute' }
  }

  const tagPattern = /<([\w:-]*(?:voice|trans|recogn)[\w:-]*(?:text|content)?)[^>]*>([\s\S]*?)<\/\1>/giu
  for (const match of xml.matchAll(tagPattern)) {
    const text = cleanTranscript(match[2])
    if (text) return { text, source: `xml:${match[1]}` }
  }
  return null
}

export function findNativeVoiceTranscript(payload, path = [], seen = new Set()) {
  if (!payload || typeof payload !== 'object') return null
  if (seen.has(payload)) return null
  seen.add(payload)

  for (const [key, value] of Object.entries(payload)) {
    const nextPath = [...path, key]
    if (typeof value === 'string') {
      if (transcriptKey(key)) {
        const text = cleanTranscript(value)
        if (text) return { text, source: nextPath.join('.') }
      }
      const fromXml = extractTranscriptFromXml(value)
      if (fromXml) return { ...fromXml, source: `${nextPath.join('.')}.${fromXml.source}` }
      continue
    }
    if (value && typeof value === 'object') {
      const nested = findNativeVoiceTranscript(value, nextPath, seen)
      if (nested) return nested
    }
  }
  return null
}

async function optionalRawPayloadFromPuppet(message, context) {
  const puppet = context?.bot?.puppet
  const messageId = clean(message?.id || message?.payload?.id)
  if (!puppet || !messageId) return null
  for (const methodName of ['messageRawPayload', 'messagePayload']) {
    const method = puppet?.[methodName]
    if (typeof method !== 'function') continue
    try {
      const payload = await method.call(puppet, messageId)
      if (payload && typeof payload === 'object') return payload
    } catch {
      // Raw payload access is best-effort; normal attachment handling must continue.
    }
  }
  return null
}

export async function extractNativeVoiceTranscription(message, context = {}, cfg = {}, msgType = '') {
  if (cfg.nativeVoiceTranscription === false) return null
  if (!VOICE_TYPES.has(clean(msgType))) return null

  const payloads = []
  if (message?.payload && typeof message.payload === 'object') payloads.push(message.payload)
  const raw = await optionalRawPayloadFromPuppet(message, context)
  if (raw) payloads.push(raw)

  for (const payload of payloads) {
    const found = findNativeVoiceTranscript(payload)
    if (found) {
      return {
        text: found.text,
        source: found.source,
        provider: 'wechat_native',
      }
    }
  }
  return null
}
