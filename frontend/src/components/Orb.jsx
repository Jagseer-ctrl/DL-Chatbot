import { useMemo } from 'react'
import { motion, useSpring, useTransform } from 'framer-motion'

// States: idle | listening | thinking | speaking | camera
// `level` is a Framer Motion value (0..1) fed by the Web Audio analyser, so the orb reacts
// to the microphone (listening) or to the speech output (speaking) without re-rendering React.
const BARS = 28

export default function Orb({ state, level }) {
  const spring = useSpring(level, { stiffness: 220, damping: 16 })
  const listenScale = useTransform(spring, (v) => 1 + v * 0.55)
  const glow = useTransform(spring, (v) => `0 0 ${50 + v * 110}px ${10 + v * 40}px rgba(120,140,255,${0.35 + v * 0.4})`)
  const bars = useMemo(() => Array.from({ length: BARS }, (_, i) => ({ i, d: 0.5 + ((i * 37) % 11) / 14, peak: 0.35 + ((i * 53) % 10) / 12 })), [])

  const floating = state === 'idle' || state === 'camera'
  return (
    <div className="orb-wrap" data-state={state} role="img" aria-label={`VISION is ${state}`}>
      <svg width="0" height="0" aria-hidden="true" focusable="false">
        <defs>
          <filter id="liquid" x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves="2" seed="4" result="n">
              <animate attributeName="baseFrequency" dur="16s" values="0.012 0.018;0.02 0.01;0.012 0.018" repeatCount="indefinite" />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="n" scale="22" />
          </filter>
        </defs>
      </svg>

      <motion.div
        className="orb-float"
        animate={floating ? { y: [0, -14, 0] } : { y: 0 }}
        transition={floating ? { duration: 6, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.4 }}
      >
        {state === 'thinking' && (
          <>
            {[0, 1, 2].map((k) => (
              <motion.div
                key={k}
                className="orb-ring"
                style={{ inset: `${-14 - k * 16}px`, filter: 'url(#liquid)' }}
                animate={{ rotate: k % 2 ? -360 : 360 }}
                transition={{ duration: 5 + k * 2.5, repeat: Infinity, ease: 'linear' }}
              />
            ))}
          </>
        )}

        <motion.div
          className="orb-core"
          style={state === 'listening' ? { scale: listenScale, boxShadow: glow } : undefined}
          animate={
            state === 'listening' ? undefined
            : state === 'thinking' ? { scale: [1, 0.94, 1] }
            : state === 'speaking' ? { scale: [1, 1.05, 1] }
            : { scale: [1, 1.03, 1] }
          }
          transition={{ duration: state === 'thinking' ? 1.6 : 4.5, repeat: Infinity, ease: 'easeInOut' }}
        >
          <div className="orb-liquid" style={{ filter: 'url(#liquid)' }} />
          <div className="orb-shine" />
          {state === 'camera' && (
            <>
              <motion.div className="orb-scan" animate={{ y: ['-110%', '110%'] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }} />
              <div className="orb-grid" />
            </>
          )}
        </motion.div>

        {state === 'camera' && <motion.div className="orb-halo" animate={{ opacity: [0.35, 0.9, 0.35], scale: [1, 1.06, 1] }} transition={{ duration: 2.4, repeat: Infinity }} />}
      </motion.div>

      <div className={`waveform ${state === 'speaking' ? 'on' : ''}`} aria-hidden="true">
        {bars.map((b) => (
          <motion.span
            key={b.i}
            animate={state === 'speaking' ? { scaleY: [0.15, b.peak + 0.5, 0.15] } : { scaleY: 0.12 }}
            transition={state === 'speaking' ? { duration: b.d, repeat: Infinity, ease: 'easeInOut', delay: b.i * 0.025 } : { duration: 0.3 }}
          />
        ))}
      </div>
    </div>
  )
}
