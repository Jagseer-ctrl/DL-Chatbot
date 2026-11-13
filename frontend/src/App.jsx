import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, useMotionValue } from 'framer-motion'
import { Camera, Eye, Mic, Send, Sparkles, StopCircle } from 'lucide-react'
import Orb from './components/Orb'
import CameraPanel from './components/CameraPanel'
import ChatPanel from './components/ChatPanel'
import SettingsPanel from './components/SettingsPanel'
import { useCamera } from './hooks/useCamera'
import { useSettings } from './hooks/useSettings'
import { api, backendHost, isRemoteBackend } from './lib/api'
import { chooseEngine, hasBrowserSTT } from './lib/stt'
import { cancelSpeech, speakBackend, speakBrowser, voicesFor } from './lib/tts'

const WAKE_RE = new RegExp(
  '(?:\\b(?:hey|hi|hay|okay|ok)[\\s,.-]*(?:vision|vishan|vijan|vizhan|vishon)\\b)|' +
    '(?:(?:हे|हेय|हाय)\\s*(?:विज़न|विजन|विजन))|(?:(?:ਹੇ|ਹੈ)\\s*(?:ਵਿਜ਼ਨ|ਵਿਜਨ))',
  'i',
)

const GREETING = {
  en: 'Hello! I am VISION 2.0, your AI desk assistant powered by Google Gemini. How can I assist you today?',
  hi: 'नमस्ते! मैं विज़न 2.0 हूँ, आपका AI डेस्क सहायक। आज मैं आपकी कैसे मदद कर सकता हूँ?',
  pa: 'ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ! ਮੈਂ ਵਿਜ਼ਨ 2.0 ਹਾਂ, Google Gemini ਦੁਆਰਾ ਸੰਚਾਲਿਤ ਤੁਹਾਡਾ AI ਸਹਾਇਕ।',
}

const VISUAL_QUERY = /\b(what is this|what's this|what is that|read (this|the text)|what can you see|what do you see|in front of me|this object|what color is this|what colour is this)\b|(?:यह क्या है|इसे पढ़|इसमें क्या|ਇਹ ਕੀ ਹੈ|ਇਸਨੂੰ ਪੜ੍ਹ|ਇਸ ਵਿੱਚ ਕੀ)/i

function LiquidMetricCard({ title, value, detail, icon: Icon, tint, onClick }) {
  return (
    <motion.div
      whileHover={{ y: -4, scale: 1.01 }}
      transition={{ type: 'spring', stiffness: 280, damping: 20 }}
      className="liquid-card"
      style={{ '--card-tint': tint }}
      onClick={onClick}
    >
      <div className="liquid-card__blur" />
      <div className="liquid-card__content">
        <div className="liquid-card__meta">
          <span>{title}</span>
          <div className="liquid-card__icon" aria-hidden="true">
            <Icon size={16} />
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
    S.current.messages
      .filter((m) => !m.error)
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.text }))

  // Backend status check (with smooth retry)
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
          timer = setTimeout(load, 3500)
        }
      }
    }
    load()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])

  // Speech output
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
            /* fall back to browser */
          }
        }
        decay()
        await speakBrowser(msg, {
          voiceURI: s.voiceURI,
          rate: s.speed,
          lang: s.language,
          onPulse: () => level.set(0.85),
        })
      } finally {
        cancelAnimationFrame(raf)
        level.set(0)
      }
    },
    [level],
  )

  // Speech listening
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

  // Core Question Dispatcher (Text, Voice, Camera)
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
          // Send camera frame to Gemini Multimodal Vision API
          const frame = await c.capture()
          res = await api.ask(frame, q, prior, s.language, ctrl.signal)
          if (res.scene) setScene(res.scene)
          if (!S.current.status?.detector?.loaded) api.status().then(setStatus).catch(() => {})
        } else {
          res = await api.chat(q, prior, s.language, ctrl.signal)
        }

        const answer = res.reply ?? res.answer ?? res.response
        if (typeof answer !== 'string' || !answer.trim()) {
          throw new Error('The backend returned an empty answer. Please retry.')
        }

        addMessage({
          role: 'assistant',
          text: answer,
          source: res.source || (res.model ? `gemini:${res.model}` : 'Gemini'),
          references: res.references,
        })
        await speak(answer)
      } catch (e) {
        if (e.name !== 'AbortError') {
          addMessage({ role: 'assistant', text: e.message, error: true, retry: { question: q, voice } })
        }
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
    [addMessage, refreshAwake, speak],
  )

  const retryMessage = (message) => {
    setMessages((items) => items.filter((item) => item.id !== message.id))
    handleQuestion(message.retry.question, message.retry.voice, true)
  }

  const greet = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    const msg = GREETING[S.current.settings.language] || GREETING.en
    addMessage({ role: 'assistant', text: msg, source: 'gemini' })
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
        if (!m) return
        const rest = t.slice(m.index + m[0].length).replace(/^[\s,.:;!?-]+/, '')
        refreshAwake()
        if (rest.length > 2) handleQuestion(rest, true)
        else greet()
        return
      }
      if (!s.wakeWord && !s.continuous) stopListening()
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
      notify('Speech recognition is not available in this browser. You can type questions below.')
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
    try {
      const l = new engine(opts)
      await l.start()
      listenerRef.current = l
      setListening(true)
      if (s.wakeWord) refreshAwake()
      return true
    } catch (e) {
      notify(e.message || 'Microphone access denied.')
      return false
    }
  }, [level, notify, refreshAwake, stopListening])

  const toggleMic = useCallback(() => {
    if (listening) stopListening()
    else startListening()
  }, [listening, startListening, stopListening])

  const stopAll = useCallback(() => {
    abortRef.current?.abort()
    stopListening()
    cancelSpeech()
    cam.stop()
    busyRef.current = false
    setPhase('idle')
    setInterim('')
    level.set(0)
  }, [cam, level, stopListening])

  const submit = (e) => {
    e?.preventDefault()
    const t = text.trim()
    if (!t || phase !== 'idle') return
    setText('')
    handleQuestion(t, false)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  // Live detector loop
  useEffect(() => {
    if (!cam.active || cam.paused || !settings.liveDetect) return
    let stop = false
    let inflight = false
    const id = setInterval(async () => {
      if (inflight || busyRef.current || document.hidden) return
      inflight = true
      try {
        const r = await api.detect(await cam.capture())
        if (!stop) setScene(r)
      } catch {
        /* retry next tick */
      } finally {
        inflight = false
      }
    }, 1400)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [cam.active, cam.paused, cam.capture, settings.liveDetect])

  const orbState =
    phase === 'thinking' || transcribing
      ? 'thinking'
      : phase === 'speaking'
      ? 'speaking'
      : listening
      ? 'listening'
      : cam.active
      ? 'camera'
      : 'idle'

  const caption =
    phase === 'thinking'
      ? 'Gemini is thinking…'
      : transcribing
      ? 'Transcribing speech…'
      : phase === 'speaking'
      ? 'Speaking answer…'
      : listening && settings.wakeWord && !awake
      ? 'Waiting for “Hey Vision”…'
      : listening
      ? 'Listening to you…'
      : cam.active
      ? 'Camera active — Ask about what is in view'
      : 'Tap the microphone, or type any question'

  const remote = isRemoteBackend()
  const isGeminiLinked = Boolean(status?.llm?.configured)
  const geminiModel = status?.llm?.model || 'gemini-1.5-flash'

  return (
    <div className="app">
      {/* Liquid Glass Navigation Bar */}
      <header className="top">
        <div className="brand-wrap">
          <div className="logo" aria-label="VISION 2.0">
            VIS<span>I</span>ON <span className="logo-ver">2.0</span>
          </div>
          <span className="brand-tag">Ambient AI Desk</span>
        </div>

        <div className="indicators" aria-live="polite">
          {listening && (
            <span className="pill rec">
              <i className="dot" /> Mic active
            </span>
          )}
          {cam.active && (
            <span className="pill live">
              <i className="dot green" /> Camera {cam.paused ? 'paused' : 'on'}
            </span>
          )}
          {isGeminiLinked ? (
            <span className="pill aipill">
              <Sparkles size={12} /> {geminiModel}
            </span>
          ) : (
            <button className="pill warnpill pill-btn" onClick={() => setShowSettings(true)}>
              <Sparkles size={12} /> Configure GEMINI_API_KEY
            </button>
          )}
          {remote && <span className="pill glasspill">Render: {backendHost()}</span>}
        </div>

        <div className="top-actions">
          <button className="btn" onClick={() => setShowSettings(true)}>Settings</button>
          <button className="btn danger" onClick={stopAll} title="Turn off microphone, camera and speech">
            <StopCircle size={15} /> Stop
          </button>
        </div>
      </header>

      {(statusError || toast) && (
        <div className={`banner ${statusError && !toast ? 'bad' : ''}`} role="status">
          <span>{toast || `${statusError} Retrying connection…`}</span>
          {toast && <button className="link" onClick={() => setToast('')}>Dismiss</button>}
        </div>
      )}

      {/* Main Workspace Layout */}
      <main className="layout">
        {/* Left Column: Interactive Orb Stage & Controls */}
        <section className="glass stage" data-state={orbState}>
          <Orb state={orbState} level={level} />

          <p className="caption" aria-live="polite">{caption}</p>

          {/* Quick Voice & Camera Circular Triggers */}
          <div className="controls control-dock">
            <button
              className={`round mic ${listening ? 'on' : ''}`}
              onClick={toggleMic}
              aria-pressed={listening}
              aria-label={listening ? 'Stop listening' : 'Start listening'}
              title={listening ? 'Stop listening' : 'Voice chat'}
            >
              <Mic size={24} />
            </button>
            <button
              className={`round cam ${cam.active ? 'on' : ''}`}
              onClick={() => (cam.active ? cam.stop() : cam.start())}
              aria-pressed={cam.active}
              aria-label={cam.active ? 'Stop camera' : 'Start camera'}
              title={cam.active ? 'Stop camera' : 'Start camera vision'}
            >
              <Camera size={24} />
            </button>
          </div>

          {/* Quick Settings Bar */}
          <div className="row wrap center control-dock settings-dock">
            <label className="toggle">
              <input type="checkbox" checked={settings.continuous} onChange={(e) => update({ continuous: e.target.checked })} />
              <span>Continuous</span>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={settings.muted} onChange={(e) => update({ muted: e.target.checked })} />
              <span>Mute voice</span>
            </label>
            <select aria-label="Language" value={settings.language} onChange={(e) => update({ language: e.target.value })}>
              <option value="en">English</option>
              <option value="hi">हिन्दी</option>
              <option value="pa">ਪੰਜਾਬੀ</option>
            </select>
          </div>

          {/* Liquid Metric Cards */}
          <div className="metrics-row">
            <LiquidMetricCard
              title="AI Engine"
              value={isGeminiLinked ? 'Gemini 2.5' : 'Key Needed'}
              detail={isGeminiLinked ? 'Google GenAI Ready' : 'Click to configure'}
              icon={Sparkles}
              tint="linear-gradient(135deg, rgba(120, 142, 255, 0.8), rgba(168, 108, 255, 0.75))"
              onClick={() => setShowSettings(true)}
            />
            <LiquidMetricCard
              title="Voice Input"
              value={listening ? 'Listening' : hasBrowserSTT() ? 'Ready' : 'Text Only'}
              detail={`Language: ${settings.language.toUpperCase()}`}
              icon={Mic}
              tint="linear-gradient(135deg, rgba(82, 209, 255, 0.8), rgba(85, 106, 255, 0.75))"
              onClick={toggleMic}
            />
            <LiquidMetricCard
              title="Camera Vision"
              value={cam.active ? (cam.paused ? 'Paused' : 'Active') : 'Off'}
              detail={cam.active ? 'Gemini Multimodal' : 'Click to start'}
              icon={Camera}
              tint="linear-gradient(135deg, rgba(99, 236, 198, 0.8), rgba(67, 135, 255, 0.75))"
              onClick={() => (cam.active ? cam.stop() : cam.start())}
            />
          </div>

          {/* Multimodal Camera Action Pill */}
          {cam.active && (
            <button
              className="frame-ask-pill"
              onClick={() => handleQuestion('What can you see in front of me? Describe the objects and scene in detail.', false)}
              disabled={phase !== 'idle'}
            >
              <Eye size={14} /> Ask Gemini to analyze current frame
            </button>
          )}

          {/* Modern Chat Input with Enter to send & Shift+Enter for new line */}
          <form className="inputrow glass-input-wrap" onSubmit={submit}>
            <textarea
              className="chat-textarea"
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={cam.active ? 'Ask Gemini about what the camera sees… (Enter to send)' : 'Ask Gemini anything… (Enter to send, Shift+Enter for new line)'}
              aria-label="Ask VISION AI"
              maxLength={2000}
            />
            <button
              className="btn-send primary"
              type="submit"
              disabled={!text.trim() || phase !== 'idle'}
              title="Send message"
              aria-label="Send message"
            >
              <Send size={16} />
            </button>
          </form>
        </section>

        {/* Right Column: Camera Viewport & Liquid Glass Chat Panel */}
        <div className="side">
          <CameraPanel
            cam={cam}
            scene={scene}
            liveDetect={settings.liveDetect}
            onToggleLive={(v) => update({ liveDetect: v })}
            onCapture={() => handleQuestion('What can you see in front of me? Describe the objects and scene.', false)}
            busy={phase !== 'idle'}
            remote={remote}
            host={backendHost()}
          />
          <ChatPanel
            messages={messages}
            interim={interim}
            pending={phase === 'thinking' || transcribing}
            onClear={() => setMessages([])}
            onRetry={retryMessage}
          />
        </div>
      </main>

      <SettingsPanel
        open={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        update={update}
        status={status}
        statusError={statusError}
      />
    </div>
  )
}
