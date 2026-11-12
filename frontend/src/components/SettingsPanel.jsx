import { useEffect, useState } from 'react'
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

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer glass" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Settings</h2>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        <label className="field">Language
          <select value={lang} onChange={(e) => update({ language: e.target.value })}>
            <option value="en">English</option>
            <option value="hi">हिन्दी (Hindi)</option>
            <option value="pa">ਪੰਜਾਬੀ (Punjabi)</option>
          </select>
        </label>

        <label className="toggle block"><input type="checkbox" checked={settings.continuous} onChange={(e) => update({ continuous: e.target.checked })} />
          <span>Continuous conversation (keep listening after each answer)</span></label>
        <label className="toggle block"><input type="checkbox" checked={settings.liveDetect} onChange={(e) => update({ liveDetect: e.target.checked })} />
          <span>Live object detection while the camera is on</span></label>

        <h3>Voice input</h3>
        <label className="field">Speech engine
          <select value={settings.sttEngine} onChange={(e) => update({ sttEngine: e.target.value })}>
            <option value="auto">Automatic</option>
            <option value="browser" disabled={!hasBrowserSTT()}>Browser (needs internet)</option>
            <option value="backend" disabled={!v?.stt}>Backend Whisper (offline)</option>
          </select>
        </label>

        <h3>Voice output</h3>
        <label className="toggle block"><input type="checkbox" checked={settings.muted} onChange={(e) => update({ muted: e.target.checked })} />
          <span>Mute spoken responses</span></label>
        <label className="field">Speech engine
          <select value={settings.ttsEngine} onChange={(e) => update({ ttsEngine: e.target.value })}>
            <option value="auto">Automatic</option>
            <option value="browser">Browser voices</option>
            <option value="piper" disabled={!v?.tts}>Piper (backend)</option>
          </select>
        </label>
        <label className="field">Voice
          <select value={settings.voiceURI} onChange={(e) => update({ voiceURI: e.target.value })} disabled={settings.ttsEngine === 'piper'}>
            <option value="">Default for language</option>
            {langVoices.map((x) => <option key={x.voiceURI} value={x.voiceURI}>{x.name} ({x.lang})</option>)}
          </select>
          {langVoices.length === 0 && settings.ttsEngine !== 'piper' && (
            <small className="warn">No browser voice for this language is installed on this device.</small>
          )}
        </label>
        <label className="field">Speed: {settings.speed.toFixed(1)}×
          <input type="range" min="0.6" max="1.6" step="0.1" value={settings.speed} onChange={(e) => update({ speed: Number(e.target.value) })} />
        </label>

        <h3>Backend</h3>
        <dl className="kv">
          <dt>Address</dt><dd>{API_BASE || 'same origin'} ({backendHost() || 'unknown'})</dd>
          <dt>Connection</dt><dd>{statusError ? `❌ ${statusError}` : status ? '✅ connected' : '… connecting'}</dd>
          <dt>Detector</dt><dd>{d?.backend ? `${d.backend}${d.limited ? ' (people only)' : ''}` : d?.loaded === false ? 'loads on first use' : '—'}</dd>
          <dt>Speech-to-text</dt><dd>{v?.stt || 'not installed (browser engine only)'}</dd>
          <dt>Text-to-speech</dt><dd>{v?.tts || 'browser voices'}</dd>
          <dt>Language model</dt><dd>{status?.llm?.configured ? status.llm.provider : 'none (local answers only)'}</dd>
          <dt>Online knowledge</dt><dd>{status?.rag?.enabled ? 'Wikipedia' : 'off'}</dd>
        </dl>
        {d?.error && <p className="warn small">YOLO unavailable: {d.error}</p>}

        <h3>Privacy</h3>
        <ul className="small muted privacy">
          <li>Camera and microphone start only when you press their buttons, and the browser asks permission for each separately.</li>
          <li>Indicators at the top show when either is on; “Stop assistant” turns everything off.</li>
          <li>Camera frames and audio are processed in memory and never saved. Chat history is not stored.</li>
          <li>VISION never identifies people from their faces.</li>
          {isRemoteBackend() && <li className="warn">This session uses a remote backend ({backendHost()}): frames and speech audio are sent there.</li>}
        </ul>
      </aside>
    </div>
  )
}
