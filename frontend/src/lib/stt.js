// Speech-to-text engines. Both only run after the user presses the mic button / wake toggle,
// and both expose a live level meter so the UI can show that the microphone is open.
//
//  * BrowserSTT  - Web Speech API (Chrome/Edge/Safari). Needs internet (the browser vendor's service).
//  * BackendSTT  - records speech segments locally (energy-based voice detection), encodes WAV and sends
//                  each segment to POST /voice/transcribe (Whisper). Works offline and inside Electron,
//                  where the Web Speech API is not available.
import { encodeWav } from './wav'

export const LANG_TAG = { en: 'en-US', hi: 'hi-IN', pa: 'pa-IN' }

const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition
export const hasBrowserSTT = () => !!SR()

export function chooseEngine(pref, status) {
  const backendOk = !!status?.voice?.stt
  if (pref === 'browser') return hasBrowserSTT() ? 'browser' : null
  if (pref === 'backend') return backendOk ? 'backend' : null
  if (window.visionDesktop?.isDesktop) return backendOk ? 'backend' : null // Electron has no Web Speech service
  if (hasBrowserSTT()) return 'browser'
  return backendOk ? 'backend' : null
}

export function micErrorMessage(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError')
    return 'Microphone permission was denied. Allow it in your browser/system settings, then try again.'
  if (e?.name === 'NotFoundError') return 'No microphone was found.'
  if (e?.name === 'NotReadableError') return 'The microphone is in use by another app.'
  return e?.message || 'Could not start the microphone.'
}

class MicSession {
  constructor(onLevel) {
    this.onLevel = onLevel
  }
  async open() {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('Microphone access needs HTTPS (or localhost) and a modern browser.')
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.ctx = new (window.AudioContext || window.webkitAudioContext)()
    await this.ctx.resume()
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 512
    this.source.connect(this.analyser)
    const data = new Uint8Array(this.analyser.fftSize)
    const tick = () => {
      this.analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const x = (data[i] - 128) / 128
        sum += x * x
      }
      this.onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 5))
      this.raf = requestAnimationFrame(tick)
    }
    tick()
  }
  close() {
    cancelAnimationFrame(this.raf)
    this.stream?.getTracks().forEach((t) => t.stop())
    this.ctx?.close().catch(() => {})
    this.onLevel?.(0)
  }
}

export class BrowserSTT {
  constructor(opts) {
    this.o = opts
    this.mic = new MicSession(opts.onLevel)
    this.running = false
  }
  async start() {
    await this.mic.open() // explicit mic permission + level meter
    const Rec = SR()
    this.rec = new Rec()
    this.rec.lang = LANG_TAG[this.o.lang] || 'en-US'
    this.rec.continuous = true
    this.rec.interimResults = true
    this.rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal && !this.o.isBusy()) {
          const t = e.results[i][0].transcript.trim()
          if (t) this.o.onText(t)
        } else if (!e.results[i].isFinal) interim += e.results[i][0].transcript
      }
      this.o.onInterim?.(interim.trim())
    }
    this.rec.onerror = (e) => {
      if (['not-allowed', 'service-not-allowed'].includes(e.error)) {
        this.running = false
        this.o.onError('Speech recognition permission was denied.')
      } else if (e.error === 'network') {
        this.running = false
        this.o.onError('Browser speech recognition needs an internet connection. Switch the speech engine to "Backend (Whisper)" for offline use.')
      } else if (e.error === 'language-not-supported') {
        this.running = false
        this.o.onError('This browser does not support speech recognition for the selected language.')
      }
    }
    this.rec.onend = () => {
      if (this.running) setTimeout(() => this.running && this.safeStart(), 250)
    }
    this.running = true
    this.safeStart()
  }
  safeStart() {
    try {
      this.rec.start()
    } catch {
      /* already started */
    }
  }
  stop() {
    this.running = false
    try {
      this.rec?.abort()
    } catch {
      /* ignore */
    }
    this.mic.close()
  }
}

const WORKLET = `
class Cap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true }
}
registerProcessor('vision-capture', Cap)
`

export class BackendSTT {
  constructor(opts) {
    this.o = opts
    this.mic = new MicSession(opts.onLevel)
    this.floor = 0.005
    this.resetState()
  }
  resetState() {
    this.speaking = false
    this.pre = []
    this.preMs = 0
    this.voicedMs = 0
    this.silenceMs = 0
    this.totalMs = 0
    this.voiceTotal = 0
    this.buf = []
  }
  async start() {
    await this.mic.open()
    const { ctx, source } = this.mic
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
    await ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    this.node = new AudioWorkletNode(ctx, 'vision-capture')
    const mute = ctx.createGain()
    mute.gain.value = 0 // keep the graph alive without playing the mic back
    source.connect(this.node)
    this.node.connect(mute)
    mute.connect(ctx.destination)
    this.node.port.onmessage = (e) => this.feed(e.data)
    this.running = true
  }
  feed(chunk) {
    if (!this.running) return
    const sr = this.mic.ctx.sampleRate
    const ms = (chunk.length / sr) * 1000
    if (this.o.isBusy()) {
      this.resetState()
      return
    }
    let sum = 0
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i]
    const rms = Math.sqrt(sum / chunk.length)
    const voiced = rms > Math.max(0.012, this.floor * 3)
    if (!this.speaking) {
      this.floor = this.floor * 0.99 + rms * 0.01
      this.pre.push(chunk)
      this.preMs += ms
      while (this.preMs > 300 && this.pre.length) this.preMs -= (this.pre.shift().length / sr) * 1000
      this.voicedMs = voiced ? this.voicedMs + ms : 0
      if (this.voicedMs >= 100) {
        this.speaking = true
        this.buf = [...this.pre]
        this.pre = []
        this.preMs = 0
        this.silenceMs = 0
        this.totalMs = this.voicedMs
        this.voiceTotal = this.voicedMs
      }
    } else {
      this.buf.push(chunk)
      this.totalMs += ms
      if (voiced) {
        this.silenceMs = 0
        this.voiceTotal += ms
      } else this.silenceMs += ms
      if (this.silenceMs >= 900 || this.totalMs >= 12000) this.finish()
    }
  }
  finish() {
    const chunks = this.buf
    const voiced = this.voiceTotal
    this.resetState()
    if (voiced < 300) return // a click or cough, not speech
    const wav = encodeWav(chunks, this.mic.ctx.sampleRate)
    this.o.onTranscribing?.(true)
    this.o
      .transcribe(wav)
      .then((r) => {
        const t = (r?.text || '').trim()
        if (t && this.running) this.o.onText(t)
      })
      .catch((e) => this.o.onError(e.message || 'Transcription failed.'))
      .finally(() => this.o.onTranscribing?.(false))
  }
  stop() {
    this.running = false
    try {
      this.node?.disconnect()
    } catch {
      /* ignore */
    }
    this.resetState()
    this.mic.close()
  }
}
