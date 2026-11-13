// Centralized API client for VISION 2.0 Web (Vercel) and Desktop (Electron).
const desktop = typeof window !== 'undefined' ? window.visionDesktop : undefined

function normalizeUrl(url) {
  if (!url) return ''
  const trimmed = String(url).trim().replace(/\/$/, '')
  if (!trimmed) return ''
  if (!/^https?:\/\//i.test(trimmed)) {
    return 'https://' + trimmed
  }
  return trimmed
}

// Accepts both VITE_API_BASE_URL and VITE_API_URL for convenience
export const API_BASE = normalizeUrl(
  desktop?.apiBase ?? import.meta.env.VITE_API_BASE_URL ?? import.meta.env.VITE_API_URL ?? ''
)
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

async function request(path, { method = 'GET', json, form, signal, blob = false, timeout = 25000 } = {}) {
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
    if (timedOut) throw new ApiError('The request took too long. Check the backend connection and retry.', { code: 'timeout' })
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
    throw new ApiError(err.message || `Request failed (${res.status})`, {
      status: res.status,
      code: err.code,
      fallback: err.fallback,
    })
  }

  if (blob) return res.blob()
  const data = await res.json()
  if (data && typeof data === 'object') {
    const answer = data.reply ?? data.response ?? data.answer
    if (typeof answer === 'string' && typeof data.answer !== 'string') {
      data.answer = answer
    }
  }
  return data
}

export const api = {
  health: (signal) => request('/health', { signal, timeout: 8000 }),
  status: (signal) => request('/vision/status', { signal, timeout: 15000 }),
  chat: async (message, history, language, signal) => {
    try {
      return await request('/api/chat', {
        method: 'POST',
        json: { message, history, language },
        signal,
        timeout: 120000,
      })
    } catch (e) {
      if (e.status === 404) {
        return await request('/chat', {
          method: 'POST',
          json: { message, history, language },
          signal,
          timeout: 120000,
        })
      }
      throw e
    }
  },
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
  speak: (text, speed, language, signal) =>
    request('/voice/speak', { method: 'POST', json: { text, speed, language }, blob: true, signal, timeout: 60000 }),
}
