// One API client for both deployment modes.
// Desktop: Electron's preload exposes window.visionDesktop.apiBase (local Flask, or a remote server).
// Web:     VITE_API_URL at build time, or same origin when empty.
const desktop = typeof window !== 'undefined' ? window.visionDesktop : undefined

export const API_BASE = String(desktop?.apiBase ?? import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')
const TOKEN = desktop?.apiToken || import.meta.env.VITE_API_TOKEN || ''

export function backendHost() {
  try {
    return new URL(API_BASE || window.location.origin, window.location.href).hostname
  } catch {
    return ''
  }
}

/** True when camera frames / audio leave this machine for another host. */
export function isRemoteBackend() {
  return !['localhost', '127.0.0.1', '::1', ''].includes(backendHost())
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'error', fallback } = {}) {
    super(message)
    this.status = status
    this.code = code
    this.fallback = fallback
  }
}

async function request(path, { method = 'GET', json, form, signal, blob = false, timeout = 20000 } = {}) {
  const headers = {}
  let body
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(json)
  } else if (form) {
    body = form
  }
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`
  let res
  const controller = new AbortController()
  let timedOut = false
  const forwardAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', forwardAbort, { once: true })
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  try {
    res = await fetch(API_BASE + path, { method, headers, body, signal: controller.signal })
  } catch (e) {
    if (timedOut) throw new ApiError('The request took too long. Check the model and retry.', { code: 'timeout' })
    if (e.name === 'AbortError') throw e
    throw new ApiError('Cannot reach the VISION backend. Is it running?', { code: 'unreachable' })
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', forwardAbort)
  }
  if (!res.ok) {
    let err = {}
    try {
      err = (await res.json()).error || {}
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(err.message || `Request failed (${res.status})`, { status: res.status, code: err.code, fallback: err.fallback })
  }
  if (blob) return res.blob()
  const data = await res.json()
  if (data && typeof data === 'object' && typeof data.answer !== 'string') {
    const answer = data.response ?? data.reply
    if (typeof answer === 'string') return { ...data, answer }
  }
  return data
}

export const api = {
  status: (signal) => request('/vision/status', { signal }),
  chat: (message, history, language, signal) => request('/chat', { method: 'POST', json: { message, history, language }, signal, timeout: 120000 }),
  detect: (imageBlob, signal) => {
    const form = new FormData()
    form.append('image', imageBlob, 'frame.jpg')
    return request('/vision/detect', { method: 'POST', form, signal })
  },
  ask: (imageBlob, question, history, language, signal) => {
    const form = new FormData()
    form.append('image', imageBlob, 'frame.jpg')
    form.append('question', question)
    form.append('language', language)
    form.append('history', JSON.stringify(history))
    return request('/vision/ask', { method: 'POST', form, signal, timeout: 180000 })
  },
  transcribe: (wavBlob, language, signal) => {
    const form = new FormData()
    form.append('audio', wavBlob, 'speech.wav')
    form.append('language', language)
    return request('/voice/transcribe', { method: 'POST', form, signal, timeout: 180000 })
  },
  speak: (text, speed, language, signal) => request('/voice/speak', { method: 'POST', json: { text, speed, language }, blob: true, signal, timeout: 60000 }),
}
