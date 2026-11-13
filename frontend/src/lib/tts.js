// Text-to-speech: browser speech synthesis (default) or Piper through the backend.
import { api } from './api'
import { LANG_TAG } from './stt'

let currentAudio = null

export const browserVoices = () => window.speechSynthesis?.getVoices?.() || []
export const voicesFor = (lang) => browserVoices().filter((v) => v.lang.toLowerCase().startsWith(lang))

export function onVoicesChanged(cb) {
  if (!window.speechSynthesis) return () => {}
  window.speechSynthesis.addEventListener('voiceschanged', cb)
  return () => window.speechSynthesis.removeEventListener('voiceschanged', cb)
}

export function cancelSpeech() {
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* ignore */
  }
  if (currentAudio) {
    currentAudio.pause()
    currentAudio = null
  }
}

/** Sanitize text for natural speech (strips code blocks, markdown symbols, and limits excessive length) */
export function cleanSpokenText(text) {
  if (!text) return ''
  let spoken = String(text)
  // Strip multi-line code blocks
  spoken = spoken.replace(/```[\s\S]*?```/g, ' [Code provided on screen] ')
  // Strip inline code backticks
  spoken = spoken.replace(/`([^`]+)`/g, '$1')
  // Strip markdown headers, bold, italics, links
  spoken = spoken.replace(/#{1,6}\s+/g, '')
  spoken = spoken.replace(/[*_~]{1,3}/g, '')
  spoken = spoken.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  // Strip bullet markers
  spoken = spoken.replace(/^\s*[-*+]\s+/gm, '')
  // Cap length for voice output if excessively long
  if (spoken.length > 500) {
    const end = spoken.lastIndexOf('.', 450)
    spoken = (end > 150 ? spoken.slice(0, end + 1) : spoken.slice(0, 400)) + ' The full explanation is displayed on screen.'
  }
  return spoken.trim()
}

export function speakBrowser(rawText, { voiceURI, rate = 1, lang = 'en', onPulse }) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve()
    const text = cleanSpokenText(rawText)
    if (!text) return resolve()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = LANG_TAG[lang] || 'en-US'
    u.rate = rate
    const chosen = browserVoices().find((v) => v.voiceURI === voiceURI)
    u.voice = chosen && chosen.lang.toLowerCase().startsWith(lang) ? chosen : voicesFor(lang)[0] || null
    u.onboundary = () => onPulse?.()
    u.onend = () => resolve()
    u.onerror = () => resolve()
    window.speechSynthesis.speak(u)
  })
}

export async function speakBackend(rawText, { speed = 1, language = 'en', onLevel }) {
  const text = cleanSpokenText(rawText)
  if (!text) return
  const blob = await api.speak(text, speed, language)
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  currentAudio = audio
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  const src = ctx.createMediaElementSource(audio)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  src.connect(analyser)
  analyser.connect(ctx.destination)
  const data = new Uint8Array(analyser.fftSize)
  let raf
  const tick = () => {
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const x = (data[i] - 128) / 128
      sum += x * x
    }
    onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 5))
    raf = requestAnimationFrame(tick)
  }
  try {
    await new Promise((resolve, reject) => {
      audio.onended = resolve
      audio.onpause = resolve
      audio.onerror = () => reject(new Error('audio playback failed'))
      audio.play().then(tick, reject)
    })
  } finally {
    cancelAnimationFrame(raf)
    URL.revokeObjectURL(url)
    ctx.close().catch(() => {})
    currentAudio = null
  }
}
