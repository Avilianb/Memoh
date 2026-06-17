import fs from 'node:fs'
import path from 'node:path'

function clean(value) {
  return String(value || '').trim()
}

export class RecentOutboundStore {
  constructor({ filePath, maxEntries = 500, maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    this.filePath = filePath
    this.maxEntries = maxEntries
    this.maxAgeMs = maxAgeMs
    this.items = new Map()
    this.load()
  }

  add(id, metadata = {}) {
    const value = clean(id)
    if (!value) return false
    this.items.set(value, { id: value, timestamp: Date.now(), ...metadata })
    this.prune()
    this.save()
    return true
  }

  addMessage(message, metadata = {}) {
    const id = clean(message?.id || message?.payload?.id)
    return this.add(id, metadata)
  }

  has(id) {
    this.prune()
    return this.items.has(clean(id))
  }

  load() {
    if (!this.filePath) return
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      const items = Array.isArray(parsed?.items) ? parsed.items : []
      this.items = new Map(items.map((item) => [clean(item.id), item]).filter(([id]) => id))
      this.prune(false)
    } catch {
      this.items = new Map()
    }
  }

  save() {
    if (!this.filePath) return
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
      fs.writeFileSync(this.filePath, JSON.stringify({ items: [...this.items.values()] }, null, 2), { mode: 0o600 })
    } catch {
      // The bridge can still run without persisted outbound ids; sender-name fallback remains available.
    }
  }

  prune(save = true) {
    const cutoff = Date.now() - this.maxAgeMs
    for (const [id, item] of this.items) {
      if (!item?.timestamp || item.timestamp < cutoff) this.items.delete(id)
    }
    while (this.items.size > this.maxEntries) {
      const first = this.items.keys().next().value
      if (!first) break
      this.items.delete(first)
    }
    if (save) this.save()
  }
}
