import { useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, Key, ShieldAlert, Sparkles, X } from 'lucide-react'
import { API_BASE, backendHost, isRemoteBackend } from '../lib/api'
import { hasBrowserSTT } from '../lib/stt'
import { browserVoices, onVoicesChanged } from '../lib/tts'

export default function SettingsPanel({ open, onClose, settings, update, status, statusError }) {
  const [voices, setVoices] = useState(browserVoices())
  useEffect(() => onVoicesChanged(() => setVoices(browserVoices())), [])
  if (!open) return null

  const lang = settings.language
  const langVoices = voices.filter((v) => v.lang.toLowerCase().startsWith(lang))
  const v = status?.voice
  const d = status?.detector
  const isGeminiLinked = Boolean(status?.llm?.configured)
  const geminiModel = status?.llm?.model || 'gemini-1.5-flash'

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer glass" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div className="panel-title-wrap">
            <h2>Settings &amp; AI Config</h2>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </div>

        {/* --- Google Gemini AI Configuration Card --- */}
        <div className={`gemini-config-card ${isGeminiLinked ? 'linked' : 'unlinked'}`}>
          <div className="gemini-card-header">
            <div className="gemini-badge-icon">
              <Sparkles size={16} />
            </div>
            <div>
              <div className="gemini-card-title">Google Gemini AI Engine</div>
              <div className="gemini-card-status">
                {isGeminiLinked ? (
                  <span className="status-linked">
                    <CheckCircle2 size={13} /> Active ({geminiModel})
                  </span>
                ) : (
                  <span className="status-unlinked">
                    <ShieldAlert size={13} /> Missing GEMINI_API_KEY
                  </span>
                )}
              </div>
            </div>
          </div>

          {!isGeminiLinked ? (
            <div className="gemini-setup-guide">
              <p className="gemini-guide-text">
                To enable conversational intelligence, code generation, and camera visual Q&amp;A, add your Gemini API key to your <b>Render</b> backend:
              </p>
              <ol className="gemini-steps">
                <li>
                  Generate a free key at{' '}
                  <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer noopener" className="ext-link">
                    Google AI Studio <ExternalLink size={11} />
                  </a>
                </li>
                <li>
                  Go to your <b>Render Dashboard</b> &rarr; Web Service &rarr; <b>Environment</b>.
                </li>
                <li>
                  Add environment variable:
                  <div className="env-code-pill">GEMINI_API_KEY = your_key_here</div>
                  <div className="env-code-pill">GEMINI_MODEL = gemini-2.5-flash</div>
                </li>
                <li>Save changes. Render will automatically redeploy!</li>
              </ol>
            </div>
          ) : (
            <p className="gemini-active-note">
              VISION is linked to Google Gemini. All conversations, code explanations, and vision analysis are powered by {geminiModel}.
            </p>
          )}
        </div>

        {/* --- Language & Interaction --- */}
        <h3>Interaction</h3>
        <label className="field">
          Language
          <select value={lang} onChange={(e) => update({ language: e.target.value })}>
            <option value="en">English</option>
            <option value="hi">हिन्दी (Hindi)</option>
            <option value="pa">ਪੰਜਾਬੀ (Punjabi)</option>
          </select>
        </label>

        <label className="toggle block">
          <input type="checkbox" checked={settings.continuous} onChange={(e) => update({ continuous: e.target.checked })} />
          <span>Continuous conversation (keep listening after each answer)</span>
        </label>
        <label className="toggle block">
          <input type="checkbox" checked={settings.liveDetect} onChange={(e) => update({ liveDetect: e.target.checked })} />
          <span>Live object detection while the camera is on</span>
        </label>

        {/* --- Voice Input --- */}
        <h3>Voice Input (Speech-to-Text)</h3>
        <label className="field">
          Speech engine
          <select value={settings.sttEngine} onChange={(e) => update({ sttEngine: e.target.value })}>
            <option value="auto">Automatic (Browser / Web Speech API)</option>
            <option value="browser" disabled={!hasBrowserSTT()}>Browser SpeechRecognition</option>
            <option value="backend" disabled={!v?.stt}>Backend Whisper (Offline)</option>
          </select>
        </label>

        {/* --- Voice Output --- */}
        <h3>Voice Output (Text-to-Speech)</h3>
        <label className="toggle block">
          <input type="checkbox" checked={settings.muted} onChange={(e) => update({ muted: e.target.checked })} />
          <span>Mute spoken responses</span>
        </label>
        <label className="field">
          Voice
          <select
            value={settings.voiceURI}
            onChange={(e) => update({ voiceURI: e.target.value })}
            disabled={settings.muted}
          >
            <option value="">Default system voice</option>
            {langVoices.map((x) => (
              <option key={x.voiceURI} value={x.voiceURI}>
                {x.name} ({x.lang})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Speaking Speed: {settings.speed.toFixed(1)}×
          <input
            type="range"
            min="0.6"
            max="1.5"
            step="0.1"
            value={settings.speed}
            onChange={(e) => update({ speed: Number(e.target.value) })}
          />
        </label>

        {/* --- System Diagnostics --- */}
        <h3>Backend Diagnostics</h3>
        <dl className="kv">
          <dt>API URL</dt>
          <dd>{API_BASE || 'Same origin'} ({backendHost() || 'local'})</dd>
          <dt>Connection</dt>
          <dd>{statusError ? `❌ ${statusError}` : status ? '✅ Connected' : '… Connecting'}</dd>
          <dt>AI Model</dt>
          <dd>{status?.llm?.configured ? `${status.llm.provider} (${status.llm.model})` : 'Not linked (needs GEMINI_API_KEY)'}</dd>
          <dt>Detector</dt>
          <dd>{d?.backend ? `${d.backend}${d.limited ? ' (people only)' : ''}` : d?.loaded === false ? 'Loads on first use' : '—'}</dd>
          <dt>Speech Input</dt>
          <dd>{v?.stt || 'Browser Speech Engine'}</dd>
          <dt>Speech Output</dt>
          <dd>Browser SpeechSynthesis</dd>
        </dl>

        {/* --- Security & Privacy --- */}
        <h3>Security &amp; Privacy</h3>
        <ul className="small muted privacy">
          <li>Camera and microphone are only activated when explicitly requested by you.</li>
          <li>API keys are stored exclusively in the Render backend environment and never exposed to the browser.</li>
          <li>Audio frames and images are processed in memory and never logged to disk.</li>
        </ul>
      </aside>
    </div>
  )
}
