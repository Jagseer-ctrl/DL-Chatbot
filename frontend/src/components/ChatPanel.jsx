import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Sparkles, Trash2 } from 'lucide-react'

// Code Block with Copy Button
function CodeBlock({ code, language }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard?.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="code-block-container">
      <div className="code-block-header">
        <span className="code-block-lang">{language || 'code'}</span>
        <button className="code-copy-btn" onClick={handleCopy} aria-label="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="code-block-pre">
        <code>{code}</code>
      </pre>
    </div>
  )
}

// Formats Markdown-style text: code blocks, inline code, bold, lists
function FormattedMessage({ text }) {
  if (!text) return null

  // Split by code blocks: ```lang ... ```
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g
  const parts = []
  let lastIndex = 0
  let match

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: text.slice(lastIndex, match.index) })
    }
    parts.push({ type: 'code', lang: match[1] || '', content: match[2].trimEnd() })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    parts.push({ type: 'text', content: text.slice(lastIndex) })
  }

  return (
    <div className="formatted-msg">
      {parts.map((p, idx) => {
        if (p.type === 'code') {
          return <CodeBlock key={idx} code={p.content} language={p.lang} />
        }
        // Format text paragraphs, bold, inline code, lists
        const paragraphs = p.content.split(/\n{2,}/)
        return (
          <div key={idx} className="msg-text-group">
            {paragraphs.map((para, pIdx) => {
              const lines = para.split('\n')
              return (
                <p key={pIdx}>
                  {lines.map((line, lIdx) => {
                    const isBullet = /^\s*[-*•]\s+(.*)$/.test(line)
                    const cleanLine = isBullet ? line.replace(/^\s*[-*•]\s+/, '') : line
                    return (
                      <span key={lIdx} className={isBullet ? 'bullet-item' : 'line-item'}>
                        {isBullet && <span className="bullet-dot">•</span>}
                        {renderInlineFormatted(cleanLine)}
                        {lIdx < lines.length - 1 && !isBullet && <br />}
                      </span>
                    )
                  })}
                </p>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function renderInlineFormatted(str) {
  // Matches inline code `...` and bold **...**
  const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g
  const chunks = str.split(regex)

  return chunks.map((chunk, i) => {
    if (chunk.startsWith('`') && chunk.endsWith('`') && chunk.length > 2) {
      return <code key={i} className="inline-code">{chunk.slice(1, -1)}</code>
    }
    if (chunk.startsWith('**') && chunk.endsWith('**') && chunk.length > 4) {
      return <strong key={i}>{chunk.slice(2, -2)}</strong>
    }
    return chunk
  })
}

export default function ChatPanel({ messages, interim, pending, onClear, onRetry }) {
  const end = useRef(null)

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, interim, pending])

  return (
    <section className="glass panel chat-panel" aria-label="Conversation">
      <div className="panel-head">
        <div className="panel-title-wrap">
          <h2>Conversation</h2>
          <span className="badge-gemini">
            <Sparkles size={11} /> Gemini 2.5
          </span>
        </div>
        {messages.length > 0 && (
          <button className="btn-icon" onClick={onClear} title="Clear conversation" aria-label="Clear conversation">
            <Trash2 size={14} />
            <span>Clear</span>
          </button>
        )}
      </div>

      <div className="messages" role="log" aria-live="polite">
        {messages.length === 0 && (
          <div className="empty-chat-placeholder">
            <div className="empty-chat-icon">
              <Sparkles size={24} />
            </div>
            <p className="empty-title">VISION Intelligence Desk</p>
            <p className="muted small">
              Ask anything: technical questions, programming in Python/JS, reasoning, or turn on the camera and ask “What can you see?”.
            </p>
            <div className="suggestion-chips">
              <span className="chip">Explain CNN and RNN</span>
              <span className="chip">Write a Python script</span>
              <span className="chip">Explain quantum computing</span>
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role} ${m.error ? 'err' : ''}`}>
            <div className="msg-header">
              <span className="who">
                {m.role === 'user' ? (m.voice ? '🎤 You' : 'You') : 'VISION'}
              </span>
              {m.role === 'assistant' && (
                <span className="src">
                  {m.source?.startsWith('gemini') ? 'Google Gemini' : m.source || 'AI'}
                </span>
              )}
            </div>

            <FormattedMessage text={m.text} />

            {m.references?.map((r) => (
              <a
                key={r.url}
                href={r.url}
                target="_blank"
                rel="noreferrer noopener"
                className="ref"
              >
                Reference: {r.title}
              </a>
            ))}

            {m.error && m.retry && (
              <button className="retry-btn" onClick={() => onRetry?.(m)}>
                Try again
              </button>
            )}
          </div>
        ))}

        {interim && (
          <div className="msg user interim">
            <span className="who">Transcribing…</span>
            <p>{interim}</p>
          </div>
        )}

        {pending && (
          <div className="msg assistant pending">
            <div className="msg-header">
              <span className="who">VISION</span>
              <span className="src">Gemini</span>
            </div>
            <div className="pending-bubble">
              <span className="liquid-dot" />
              <span className="liquid-dot" />
              <span className="liquid-dot" />
              <span className="pending-label">Generating response…</span>
            </div>
          </div>
        )}

        <div ref={end} />
      </div>
    </section>
  )
}
