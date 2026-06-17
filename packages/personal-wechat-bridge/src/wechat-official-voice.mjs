import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const VOICE_TYPES = new Set(['Audio', 'Voice'])

function clean(value) {
  return String(value || '').trim()
}

function enabled(cfg = {}) {
  return cfg.wechatOfficialVoiceTranscription === true || cfg.officialVoiceTranscription === true
}

function voiceLang(cfg = {}) {
  const lang = clean(cfg.wechatOfficialVoiceLang || cfg.officialVoiceLang || 'zh_CN')
  return lang === 'en_US' ? 'en_US' : 'zh_CN'
}

function apiBase(cfg = {}) {
  return clean(cfg.wechatOfficialVoiceApiBase || cfg.wechatOfficialApiBase || 'https://api.weixin.qq.com').replace(/\/+$/u, '')
}

function requestTimeoutMs(cfg = {}) {
  const n = Number(cfg.wechatOfficialVoiceRequestTimeoutMs || cfg.officialVoiceRequestTimeoutMs || 10000)
  return Number.isFinite(n) && n > 0 ? n : 10000
}

function queryTimeoutMs(cfg = {}) {
  const n = Number(cfg.wechatOfficialVoiceQueryTimeoutMs || cfg.officialVoiceQueryTimeoutMs || 9000)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : 9000
}

function queryIntervalMs(cfg = {}) {
  const n = Number(cfg.wechatOfficialVoiceQueryIntervalMs || cfg.officialVoiceQueryIntervalMs || 1000)
  return Number.isFinite(n) && n > 0 ? n : 1000
}

function ffmpegPath(cfg = {}) {
  return clean(cfg.wechatOfficialVoiceFfmpeg || cfg.ffmpegPath || 'ffmpeg')
}

function maxVoiceBytes(cfg = {}) {
  const n = Number(cfg.wechatOfficialVoiceMaxBytes || cfg.officialVoiceMaxBytes || 1024 * 1024)
  return Number.isFinite(n) && n > 0 ? n : 1024 * 1024
}

function mp3FrameLike(buf) {
  if (buf.length >= 3 && buf.subarray(0, 3).toString('latin1') === 'ID3') return true
  return buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0
}

function safeError(error) {
  return clean(error?.message || String(error)).slice(0, 300)
}

async function fetchJSON(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    const body = await res.text()
    let data = {}
    try {
      data = body ? JSON.parse(body) : {}
    } catch {
      throw new Error(`wechat official voice returned non-json status ${res.status}`)
    }
    if (!res.ok) throw new Error(`wechat official voice http ${res.status}`)
    return data
  } finally {
    clearTimeout(timer)
  }
}

async function accessToken(cfg = {}) {
  const staticToken = clean(cfg.wechatOfficialAccessToken || cfg.wechatOfficialVoiceAccessToken || cfg.officialAccessToken)
  if (staticToken) return staticToken

  const appId = clean(cfg.wechatOfficialAppId || cfg.officialAppId)
  const appSecret = clean(cfg.wechatOfficialAppSecret || cfg.officialAppSecret)
  if (!appId || !appSecret) throw new Error('wechat official voice credentials missing')

  const now = Date.now()
  if (cfg._wechatOfficialTokenCache?.token && cfg._wechatOfficialTokenCache.expiresAt > now + 60000) {
    return cfg._wechatOfficialTokenCache.token
  }
  const url = new URL(`${apiBase(cfg)}/cgi-bin/token`)
  url.searchParams.set('grant_type', 'client_credential')
  url.searchParams.set('appid', appId)
  url.searchParams.set('secret', appSecret)
  const data = await fetchJSON(url, { method: 'GET' }, requestTimeoutMs(cfg))
  if (data.errcode && Number(data.errcode) !== 0) {
    throw new Error(`wechat official token error ${data.errcode}`)
  }
  const token = clean(data.access_token)
  if (!token) throw new Error('wechat official token response missing access_token')
  const expiresIn = Number(data.expires_in || 7200)
  cfg._wechatOfficialTokenCache = {
    token,
    expiresAt: now + Math.max(60, expiresIn - 120) * 1000,
  }
  return token
}

function voiceIdFor(message, attachment) {
  const base = clean(message?.id || attachment?.name || randomUUID()).replace(/[^\w.-]+/gu, '_').slice(0, 64)
  return `${base || 'voice'}_${Date.now()}_${randomUUID().slice(0, 8)}`
}

async function convertToOfficialMP3(inputPath, cfg = {}) {
  const input = path.resolve(inputPath)
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memoh-wechat-voice-'))
  const output = path.join(tmpDir, 'voice.mp3')
  await execFileAsync(ffmpegPath(cfg), [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-b:a',
    '32k',
    output,
  ])
  const stat = await fs.stat(output)
  if (stat.size > maxVoiceBytes(cfg)) {
    throw new Error(`wechat official voice mp3 exceeds ${maxVoiceBytes(cfg)} bytes`)
  }
  return { path: output, cleanupDir: tmpDir }
}

async function preparedVoiceMP3(attachment, cfg = {}) {
  const inputPath = clean(attachment?.path)
  if (!inputPath) throw new Error('voice attachment has no local path')
  const head = await fs.readFile(inputPath).then((buf) => buf.subarray(0, 16))
  const stat = await fs.stat(inputPath)
  const mime = clean(attachment?.mime).toLowerCase()
  if ((mime === 'audio/mpeg' || mime === 'audio/mp3' || path.extname(inputPath).toLowerCase() === '.mp3' || mp3FrameLike(head)) && stat.size <= maxVoiceBytes(cfg)) {
    return { path: inputPath, cleanupDir: '' }
  }
  return convertToOfficialMP3(inputPath, cfg)
}

async function uploadVoice(filePath, token, voiceId, cfg = {}) {
  const url = new URL(`${apiBase(cfg)}/cgi-bin/media/voice/addvoicetorecofortext`)
  url.searchParams.set('access_token', token)
  url.searchParams.set('format', 'mp3')
  url.searchParams.set('voice_id', voiceId)
  url.searchParams.set('lang', voiceLang(cfg))

  const bytes = await fs.readFile(filePath)
  const form = new FormData()
  form.append('media', new Blob([bytes], { type: 'audio/mpeg' }), 'voice.mp3')
  const data = await fetchJSON(url, { method: 'POST', body: form }, requestTimeoutMs(cfg))
  if (data.errcode !== undefined && Number(data.errcode) !== 0) {
    throw new Error(`wechat official voice upload error ${data.errcode}`)
  }
  return data
}

async function queryVoice(token, voiceId, cfg = {}) {
  const started = Date.now()
  let last = null
  while (Date.now() - started <= queryTimeoutMs(cfg)) {
    const url = new URL(`${apiBase(cfg)}/cgi-bin/media/voice/queryrecoresultfortext`)
    url.searchParams.set('access_token', token)
    url.searchParams.set('voice_id', voiceId)
    url.searchParams.set('lang', voiceLang(cfg))
    const data = await fetchJSON(url, { method: 'POST' }, requestTimeoutMs(cfg))
    if (data.errcode !== undefined && Number(data.errcode) !== 0) {
      throw new Error(`wechat official voice query error ${data.errcode}`)
    }
    const result = clean(data.result)
    if (result) return result
    last = data
    await new Promise((resolve) => setTimeout(resolve, queryIntervalMs(cfg)))
  }
  throw new Error(`wechat official voice query timeout${last ? '' : ''}`)
}

export async function transcribeWithWeChatOfficialVoice(message, attachment, cfg = {}, context = {}) {
  if (typeof cfg.wechatOfficialVoiceTranscriber === 'function') {
    return cfg.wechatOfficialVoiceTranscriber({ message, attachment, cfg, context })
  }
  const token = await accessToken(cfg)
  const voiceId = voiceIdFor(message, attachment)
  const prepared = await preparedVoiceMP3(attachment, cfg)
  try {
    await uploadVoice(prepared.path, token, voiceId, cfg)
    const text = await queryVoice(token, voiceId, cfg)
    return {
      text,
      source: 'wechat_official_voice',
      provider: 'wechat_official',
      voiceId,
    }
  } finally {
    if (prepared.cleanupDir) {
      await fs.rm(prepared.cleanupDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

export async function extractWeChatOfficialVoiceTranscription(message, context = {}, cfg = {}, msgType = '', attachments = []) {
  if (!enabled(cfg)) return null
  if (!VOICE_TYPES.has(clean(msgType))) return null
  const attachment = attachments.find((item) => clean(item?.type).toLowerCase() === 'audio' || clean(item?.mime).toLowerCase().startsWith('audio/'))
  if (!attachment) return null
  try {
    const result = await transcribeWithWeChatOfficialVoice(message, attachment, cfg, context)
    const text = clean(result?.text)
    if (!text) return null
    return {
      text,
      source: clean(result.source || 'wechat_official_voice'),
      provider: 'wechat_official',
      voiceId: clean(result.voiceId),
    }
  } catch (error) {
    return {
      text: '',
      source: 'wechat_official_voice',
      provider: 'wechat_official',
      error: safeError(error),
    }
  }
}
