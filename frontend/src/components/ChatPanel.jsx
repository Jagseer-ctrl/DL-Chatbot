import { useEffect, useRef } from 'react'

// Doubles as the voice conversation panel: spoken questions are tagged with a mic icon.
export default function ChatPanel({ messages, interim, pending, onClear, onRetry }) {
  const end = useRef(null)
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, interim])

  return (
    <section className="glass panel chat-panel" aria-label="Conversation">
      <div className="panel-head">
        <h2>Conversation</h2>
        {messages.length > 0 && <button className="link" onClick={onClear}>Clear</button>}
      </div>
      <div className="messages" role="log" aria-live="polite">
        {messages.length === 0 && (
          <p className="muted">
            Press the microphone and ask something, or type below. Turn the camera on and ask “What can you see?”
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role} ${m.error ? 'err' : ''}`}>
            <span className="who">{m.role === 'user' ? (m.voice ? '🎤 You' : 'You') : 'VISION'}</span>
            <p>{m.text}</p>
            {m.source && <span className="src">{m.source}</span>}
            {m.references?.map((r) => (
              <a key={r.url} href={r.url} target="_blank" rel="noreferrer noopener" className="ref">Wikipedia: {r.title}</a>
            ))}
            {m.error && m.retry && <button className="retry-btn" onClick={() => onRetry?.(m)}>Try again</button>}
          </div>
        ))}
        {interim && <div className="msg user interim"><span className="who">…</span><p>{interim}</p></div>}
        {pending && <div className="msg assistant pending"><span className="who">VISION</span><p><i /> <i /> <i /><span className="pending-label">Working on your answer</span></p></div>}
        <div ref={end} />
      </div>
    </section>
  )
}
