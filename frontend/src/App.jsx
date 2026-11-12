import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, useMotionValue } from 'framer-motion'
import { Camera, Mic, Sparkles } from 'lucide-react'
import Orb from './components/Orb'
import CameraPanel from './components/CameraPanel'
import ChatPanel from './components/ChatPanel'
import SettingsPanel from './components/SettingsPanel'
import { useCamera } from './hooks/useCamera'
import { useSettings } from './hooks/useSettings'
import { api, backendHost, isRemoteBackend } from './lib/api'
import { BackendSTT, BrowserSTT, chooseEngine, micErrorMessage } from './lib/stt'
import { cancelSpeech, speakBackend, speakBrowser, voicesFor } from './lib/tts'

// "Hey Vision" spotting happens on text from the speech engine, and only while the user has the
// wake-word toggle on (a clearly shown "microphone on" indicator stays visible the whole time).
const WAKE_RE = new RegExp(
  '(?:\\b(?:hey|hi|hay|okay|ok)[\\s,.-]*(?:vision|vishan|vijan|vizhan|vishon)\\b)|' +
    '(?:(?:हे|हेय|हाय)\\s*(?:विज़न|विजन|विजन))|(?:(?:ਹੇ|ਹੈ)\\s*(?:ਵਿਜ਼ਨ|ਵਿਜਨ))',
  'i',
)
const GREETING = {
  en: 'Hello! How can I help you?',
  hi: 'नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?',
  pa: 'ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ! ਮੈਂ ਤੁਹਾਡੀ ਕੀ ਮਦਦ ਕਰ ਸਕਦਾ ਹਾਂ?',
}

const VISUAL_QUERY = /\b(what is this|what's this|what is that|read (this|the text)|what can you see|what do you see|in front of me|this object|what color is this|what colour is this)\b|(?:यह क्या है|इसे पढ़|इसमें क्या|ਇਹ ਕੀ ਹੈ|ਇਸਨੂੰ ਪੜ੍ਹ|ਇਸ ਵਿੱਚ ਕੀ)/i

function LiquidMetricCard({ title, value, detail, icon: Icon, tint }) {
  return (
    <motion.div
      whileHover={{ y: -6, scale: 1.01 }}
      transition={{ type: 'spring', stiffness: 260, damping: 18 }}
      className="liquid-card"
      style={{ '--card-tint': tint }}
    >
      <div className="liquid-card__blur" />
      <div className="liquid-card__content">
        <div className="liquid-card__meta">
          <span>{title}</span>
          <div className="liquid-card__icon" aria-hidden="true">
            <Icon size={18} />
          </div>
        </div>
        <div className="liquid-card__value">{value}</div>
        <div className="liquid-card__delta">{detail}</div>
      </div>
    </motion.div>
  )
}

export default function App() {
  const [settings, update] = useSettings()
  const cam = useCamera()
  const level = useMotionValue(0)

  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState('')
  const [messages, setMessages] = useState([])
  const [phase, setPhase] = useState('idle') // idle | thinking | speaking
  const [listening, setListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [awake, setAwake] = useState(false)
  const [scene, setScene] = useState(null)
  const [toast, setToast] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [text, setText] = useState('')
  const [interim, setInterim] = useState('')

  // Latest values for callbacks that outlive a render (speech engines, timers).
  const S = useRef({})
  S.current = { settings, status, messages, cam }
  const idRef = useRef(0)
  const busyRef = useRef(false)
  const awakeRef = useRef(false)
  const listenerRef = useRef(null)
  const abortRef = useRef(null)
  const awakeTimer = useRef(null)
  const toastTimer = useRef(null)

  const notify = useCallback((msg) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 8000)
  }, [])

  const addMessage = useCallback((m) => setMessages((p) => [...p, { id: ++idRef.current, ...m }]), [])
  const history = () =>
    S.current.messages.filter((m) => !m.error).slice(-8).map((m) => ({ role: m.role, content: m.text }))

  // ---------------------------------------------------------------- backend status (retries while it boots)
  useEffect(() => {
    let alive = true
    let timer
    const load = async () => {
      try {
        const s = await api.status()
        if (alive) {
          setStatus(s)
          setStatusError('')
        }
      } catch (e) {
        if (alive) {
          setStatusError(e.message)
          timer = setTimeout(load, 3000)
        }
      }
    }
    load()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])

  // ---------------------------------------------------------------- speaking
  const speak = useCallback(
    async (msg) => {
      const { settings: s, status: st } = S.current
      if (s.muted) return
      setPhase('speaking')
      let raf
      const decay = () => {
        level.set(level.get() * 0.88)
        raf = requestAnimationFrame(decay)
      }
      try {
        let engine = s.ttsEngine
        if (engine === 'auto') engine = voicesFor(s.language).length || !st?.voice?.tts ? 'browser' : 'piper'
        if (engine === 'piper') {
          try {
            await speakBackend(msg, { speed: s.speed, language: s.language, onLevel: (v) => level.set(v) })
            return
          } catch {
            /* fall back to browser voice below */
          }
        }
        if (s.language !== 'en' && !voicesFor(s.language).length)
          notify('No voice for this language is installed on this device, so the answer may be silent. It is shown as text.')
        decay()
        await speakBrowser(msg, { voiceURI: s.voiceURI, rate: s.speed, lang: s.language, onPulse: () => level.set(0.85) })
      } finally {
        cancelAnimationFrame(raf)
        level.set(0)
      }
    },
    [level, notify],
  )

  // ---------------------------------------------------------------- listening
  const stopListening = useCallback(() => {
    listenerRef.current?.stop()
    listenerRef.current = null
    setListening(false)
    setTranscribing(false)
    awakeRef.current = false
    setAwake(false)
    level.set(0)
  }, [level])

  const refreshAwake = useCallback(() => {
    awakeRef.current = true
    setAwake(true)
    clearTimeout(awakeTimer.current)
    awakeTimer.current = setTimeout(() => {
      awakeRef.current = false
      setAwake(false)
    }, 30000)
  }, [])

  const handleQuestion = useCallback(
    async (q, voice = false, retry = false) => {
      q = q.trim()
      if (!q || busyRef.current) return
      busyRef.current = true
      setPhase('thinking')
      const prior = history()
      if (retry && prior.at(-1)?.role === 'user' && prior.at(-1).content === q) prior.pop()
      if (!retry) addMessage({ role: 'user', text: q, voice })
      const ctrl = new AbortController()
      abortRef.current = ctrl
      try {
        const { settings: s, cam: c } = S.current
        let res
        if (c.active) {
          const frame = await c.capture() // fresh frame at question time, kept in memory only
          res = await api.ask(frame, q, prior, s.language, ctrl.signal)
          setScene(res.scene)
          if (!S.current.status?.detector?.loaded) api.status().then(setStatus).catch(() => {})
        } else {
          if (VISUAL_QUERY.test(q)) throw new Error('Turn on the camera to answer questions about an image or your surroundings, then retry.')
          res = await api.chat(q, prior, s.language, ctrl.signal)
        }
        const answer = res.answer ?? res.response ?? res.reply
        if (typeof answer !== 'string' || !answer.trim()) throw new Error('The backend returned an empty answer. Please retry.')
        addMessage({ role: 'assistant', text: answer, source: res.source, references: res.references })
        await speak(answer)
      } catch (e) {
        if (e.name !== 'AbortError') addMessage({ role: 'assistant', text: e.message, error: true, retry: { question: q, voice } })
      } finally {
        setInterim('')
        busyRef.current = false
        setPhase('idle')
        if (S.current.settings.wakeWord) {
          if (S.current.settings.continuous) refreshAwake()
          else {
            awakeRef.current = false
            setAwake(false)
          }
        }
      }
    },
    [addMessage, refreshAwake, speak], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const retryMessage = (message) => {
    setMessages((items) => items.filter((item) => item.id !== message.id))
    handleQuestion(message.retry.question, message.retry.voice, true)
  }

  const greet = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    const msg = GREETING[S.current.settings.language] || GREETING.en
    addMessage({ role: 'assistant', text: msg, source: 'wake-word' })
    try {
      await speak(msg)
    } finally {
      busyRef.current = false
      setPhase('idle')
    }
  }, [addMessage, speak])

  const onSpeech = useCallback(
    (raw) => {
      if (busyRef.current) return
      const t = raw.trim()
      if (!t) return
      const s = S.current.settings
      if (s.wakeWord && !awakeRef.current) {
        const m = WAKE_RE.exec(t)
        if (!m) return // not addressed to VISION: ignored, never answered or stored
        const rest = t.slice(m.index + m[0].length).replace(/^[\s,.:;!?-]+/, '')
        refreshAwake()
        if (rest.length > 2) handleQuestion(rest, true)
        else greet()
        return
      }
      if (!s.wakeWord && !s.continuous) stopListening() // one question, then the mic closes
      if (s.wakeWord) refreshAwake()
      handleQuestion(t, true)
    },
    [greet, handleQuestion, refreshAwake, stopListening],
  )
  const onSpeechRef = useRef(onSpeech)
  onSpeechRef.current = onSpeech

  const startListening = useCallback(async () => {
    if (listenerRef.current) return
    const { settings: s, status: st } = S.current
    const engine = chooseEngine(s.sttEngine, st)
    if (!engine) {
      notify(
        window.visionDesktop?.isDesktop
          ? 'Offline speech recognition is not installed on the backend. Run: pip install -r backend/requirements-voice.txt'
          : 'Speech recognition is not available in this browser. Use Chrome, Edge or Safari, or install faster-whisper on the backend. You can still type.',
      )
      return false
    }
    const opts = {
      lang: s.language,
      isBusy: () => busyRef.current,
      onText: (t) => onSpeechRef.current(t),
      onInterim: setInterim,
      onLevel: (v) => level.set(v),
      onTranscribing: setTranscribing,
      transcribe: (wav) => api.transcribe(wav, s.language),
      onError: (msg) => {
        notify(msg)
        stopListening()
      },
    }
    const L = engine === 'browser' ? new BrowserSTT(opts) : new BackendSTT(opts)
    try {
      await L.start()
      listenerRef.current = L
      setListening(true)
      return true
    } catch (e) {
      L.stop()
      notify(micErrorMessage(e))
      return false
    }
  }, [level, notify, stopListening])

  const toggleMic = () => {
    if (listenerRef.current) {
      if (S.current.settings.wakeWord) update({ wakeWord: false })
      stopListening()
    } else startListening()
  }

  const toggleWake = async (on) => {
    update({ wakeWord: on })
    if (on) {
      if (!listenerRef.current) {
        const ok = await startListening()
        if (!ok) update({ wakeWord: false })
      }
    } else stopListening()
  }

  // restart the engine when the language changes mid-listen
  const lastLang = useRef(settings.language)
  useEffect(() => {
    if (lastLang.current === settings.language) return
    lastLang.current = settings.language
    if (listenerRef.current) {
      stopListening()
      setTimeout(startListening, 200)
    }
  }, [settings.language, startListening, stopListening])

  // ---------------------------------------------------------------- stop everything
  const stopAll = useCallback(() => {
    abortRef.current?.abort()
    cancelSpeech()
    stopListening()
    S.current.cam.stop()
    update({ wakeWord: false })
    busyRef.current = false
    setPhase('idle')
    clearTimeout(awakeTimer.current)
  }, [stopListening, update])
  const stopAllRef = useRef(stopAll)
  stopAllRef.current = stopAll
  useEffect(() => window.visionDesktop?.onStopAll?.(() => stopAllRef.current()), [])
  useEffect(() => () => stopAllRef.current(), [])

  // ---------------------------------------------------------------- camera extras
  useEffect(() => {
    if (!cam.active) setScene(null)
  }, [cam.active])

  useEffect(() => {
    if (!cam.active || cam.paused || !settings.liveDetect) return undefined
    let stop = false
    let inflight = false
    const id = setInterval(async () => {
      if (inflight || busyRef.current || document.hidden) return
      inflight = true
      try {
        const r = await api.detect(await cam.capture())
        if (!stop) setScene(r)
      } catch {
        /* transient: try again next tick */
      } finally {
        inflight = false
      }
    }, 1200)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [cam.active, cam.paused, cam.capture, settings.liveDetect])

  // ---------------------------------------------------------------- render
  const orbState =
    phase === 'thinking' || transcribing ? 'thinking'
    : phase === 'speaking' ? 'speaking'
    : listening ? 'listening'
    : cam.active ? 'camera'
    : 'idle'

  const caption =
    phase === 'thinking' ? 'Thinking…'
    : transcribing ? 'Transcribing…'
    : phase === 'speaking' ? 'Speaking…'
    : listening && settings.wakeWord && !awake ? 'Waiting for “Hey Vision”…'
    : listening ? 'Listening…'
    : 'Tap the microphone, or type a question'

  const remote = isRemoteBackend()
  const submit = (e) => {
    e.preventDefault()
    const t = text
    setText('')
    handleQuestion(t, false)
  }

  return (
    <div className="app">
      <svg className="glass-defs" aria-hidden="true" focusable="false">
        <filter id="glass-warp" x="-10%" y="-30%" width="120%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.035" numOctaves="2" seed="8" result="ripple">
            <animate attributeName="baseFrequency" dur="18s" values="0.012 0.035;0.02 0.018;0.012 0.035" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="ripple" scale="12" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      <header className="top">
        <div className="brand-wrap">
          <div className="logo" aria-label="VISION">VIS<span>I</span>ON</div>
          <span className="brand-tag">ambient AI desk</span>
        </div>
        <div className="indicators" aria-live="polite">
          {listening && (
            <span className="pill rec">
              <i className="dot" /> Microphone on{settings.wakeWord ? (awake ? ' · awake' : ' · say “Hey Vision”') : ''}
            </span>
          )}
          {cam.active && <span className="pill rec"><i className="dot" /> Camera {cam.paused ? 'paused' : 'on'}</span>}
          {remote && <span className="pill warnpill">Remote backend: {backendHost()}</span>}
        </div>
        <div className="top-actions">
          <button className="btn" onClick={() => setShowSettings(true)}>Settings</button>
          <button className="btn danger" onClick={stopAll} title="Turn off microphone, camera and speech">Stop assistant</button>
        </div>
      </header>

      {(statusError || toast) && (
        <div className={`banner ${statusError && !toast ? 'bad' : ''}`} role="status">
          {toast || `${statusError} Retrying…`}
          {toast && <button className="link" onClick={() => setToast('')}>Dismiss</button>}
        </div>
      )}

      <main className="layout">
        <section className="glass stage" data-state={orbState}>
          <Orb state={orbState} level={level} />
          <p className="caption" aria-live="polite">{caption}</p>

          <div className="controls control-dock">
            <button className={`round mic ${listening ? 'on' : ''}`} onClick={toggleMic} aria-pressed={listening}
              aria-label={listening ? 'Stop listening' : 'Start listening'} title={listening ? 'Stop listening' : 'Speak'}>
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            </button>
            <button className={`round cam ${cam.active ? 'on' : ''}`} onClick={() => (cam.active ? cam.stop() : cam.start())} aria-pressed={cam.active}
              aria-label={cam.active ? 'Stop camera' : 'Start camera'} title={cam.active ? 'Stop camera' : 'Start camera'}>
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><circle cx="12" cy="13" r="3.5" />
              </svg>
            </button>
          </div>

          <div className="row wrap center control-dock settings-dock">
            <label className="toggle"><input type="checkbox" checked={settings.wakeWord} onChange={(e) => toggleWake(e.target.checked)} /><span>Wake word “Hey Vision”</span></label>
            <label className="toggle"><input type="checkbox" checked={settings.continuous} onChange={(e) => update({ continuous: e.target.checked })} /><span>Continuous</span></label>
            <label className="toggle"><input type="checkbox" checked={settings.muted} onChange={(e) => update({ muted: e.target.checked })} /><span>Mute voice</span></label>
            <select aria-label="Language" value={settings.language} onChange={(e) => update({ language: e.target.value })}>
              <option value="en">English</option><option value="hi">हिन्दी</option><option value="pa">ਪੰਜਾਬੀ</option>
            </select>
          </div>

          <div className="metrics-row">
            <LiquidMetricCard title="AI engine" value={status?.llm?.configured ? status.llm.provider : 'Not linked'} detail={status?.llm?.configured ? 'Open questions ready' : 'Configure a model key'} icon={Sparkles} tint="linear-gradient(135deg, rgba(120, 142, 255, 0.9), rgba(168, 108, 255, 0.8))" />
            <LiquidMetricCard title="Voice input" value={listening ? 'Listening' : status?.voice?.stt || (window.SpeechRecognition || window.webkitSpeechRecognition ? 'Browser ready' : 'Unavailable')} detail={transcribing ? 'Transcribing audio' : `Language: ${settings.language.toUpperCase()}`} icon={Mic} tint="linear-gradient(135deg, rgba(82, 209, 255, 0.9), rgba(85, 106, 255, 0.8))" />
            <LiquidMetricCard title="Camera" value={cam.active ? (cam.paused ? 'Paused' : 'Live') : 'Off'} detail={cam.active ? 'Frame context enabled' : 'Turn on when needed'} icon={Camera} tint="linear-gradient(135deg, rgba(99, 236, 198, 0.9), rgba(67, 135, 255, 0.8))" />
          </div>

          <form className="inputrow" onSubmit={submit}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={cam.active ? 'Ask about what the camera sees…' : 'Type a question…'}
              aria-label="Type a question" maxLength={500} />
            <button className="btn primary" type="submit" disabled={!text.trim() || phase !== 'idle'}>Send</button>
          </form>
        </section>

        <div className="side">
          <CameraPanel cam={cam} scene={scene} liveDetect={settings.liveDetect} onToggleLive={(v) => update({ liveDetect: v })}
            onCapture={() => handleQuestion('What can you see in front of me?', false)} busy={phase !== 'idle'} remote={remote} host={backendHost()} />
          <ChatPanel messages={messages} interim={interim} pending={phase === 'thinking' || transcribing} onClear={() => setMessages([])} onRetry={retryMessage} />
        </div>
      </main>

      <SettingsPanel open={showSettings} onClose={() => setShowSettings(false)} settings={settings} update={update} status={status} statusError={statusError} />
    </div>
  )
}
