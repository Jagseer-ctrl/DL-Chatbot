import { useMemo } from 'react'
import { motion, useSpring, useTransform } from 'framer-motion'

// States: idle | listening | thinking | speaking | camera | error
// Level is a Framer Motion value (0..1) fed by Web Audio analyser
const BARS = 32

export default function Orb({ state, level }) {
  const spring = useSpring(level, { stiffness: 240, damping: 18 })
  const listenScale = useTransform(spring, (v) => 1 + v * 0.45)
  const glow = useTransform(
    spring,
    (v) => `0 0 ${40 + v * 80}px ${10 + v * 30}px rgba(255, 255, 255, ${0.25 + v * 0.35})`
  )
  const bars = useMemo(
    () =>
      Array.from({ length: BARS }, (_, i) => ({
        i,
        d: 0.45 + ((i * 37) % 13) / 14,
        peak: 0.35 + ((i * 53) % 11) / 12,
      })),
    []
  )

  const floating = state === 'idle' || state === 'camera'

  return (
    <div className="orb-wrap" data-state={state} role="img" aria-label={`VISION is ${state}`}>
      {/* SVG Liquid caustics & refraction filters */}
      <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
        <defs>
          <filter id="liquid" x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence type="fractalNoise" baseFrequency="0.014 0.02" numOctaves="3" seed="5" result="noise">
              <animate
                attributeName="baseFrequency"
                dur="18s"
                values="0.014 0.02;0.02 0.012;0.014 0.02"
                repeatCount="indefinite"
              />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="20" />
          </filter>
        </defs>
      </svg>

      <motion.div
        className="orb-float"
        animate={floating ? { y: [0, -12, 0] } : { y: 0 }}
        transition={floating ? { duration: 5.5, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.4 }}
      >
        {/* Thinking State: dual rotating liquid clear glass rings */}
        {state === 'thinking' && (
          <>
            {[0, 1, 2].map((k) => (
              <motion.div
                key={k}
                className="orb-ring"
                style={{
                  inset: `${-16 - k * 18}px`,
                  filter: 'url(#liquid)',
                  borderColor: k === 0 ? 'rgba(255, 255, 255, 0.45)' : 'rgba(255, 255, 255, 0.22)',
                }}
                animate={{ rotate: k % 2 ? -360 : 360, scale: [0.97, 1.03, 0.97] }}
                transition={{
                  rotate: { duration: 6 + k * 2.5, repeat: Infinity, ease: 'linear' },
                  scale: { duration: 2.2 + k, repeat: Infinity, ease: 'easeInOut' },
                }}
              />
            ))}
          </>
        )}

        {/* Listening State: pulsing wave rings */}
        {state === 'listening' && (
          <motion.div
            className="orb-pulse-ring"
            animate={{ scale: [1, 1.35, 1], opacity: [0.6, 0.1, 0.6] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
          />
        )}

        {/* Core Pure Clear Glass Orb */}
        <motion.div
          className="orb-core"
          style={state === 'listening' ? { scale: listenScale, boxShadow: glow } : undefined}
          animate={
            state === 'listening'
              ? undefined
              : state === 'thinking'
              ? { scale: [1, 0.95, 1.02, 1] }
              : state === 'speaking'
              ? { scale: [1, 1.05, 0.98, 1] }
              : state === 'error'
              ? { scale: [1, 1.02, 1] }
              : { scale: [1, 1.03, 1] }
          }
          transition={{
            duration: state === 'thinking' ? 1.8 : state === 'speaking' ? 2.2 : 5,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        >
          {/* Inner Caustics (monochromatic transparent liquid) */}
          <div className="orb-liquid" style={{ filter: 'url(#liquid)' }} />

          {/* Optical Specular Glare (White Glass Highlight) */}
          <div className="orb-shine" />

          {/* Secondary ambient reflection */}
          <div className="orb-refraction" />

          {/* Camera Scanning Grid */}
          {state === 'camera' && (
            <>
              <motion.div
                className="orb-scan"
                animate={{ y: ['-110%', '110%'] }}
                transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
              />
              <div className="orb-grid" />
            </>
          )}
        </motion.div>

        {state === 'camera' && (
          <motion.div
            className="orb-halo"
            animate={{ opacity: [0.25, 0.65, 0.25], scale: [1, 1.08, 1] }}
            transition={{ duration: 2.4, repeat: Infinity }}
          />
        )}
      </motion.div>

      {/* Synchronized Waveform in Pure White/Silver Glass */}
      <div className={`waveform ${state === 'speaking' ? 'on' : ''}`} aria-hidden="true">
        {bars.map((b) => (
          <motion.span
            key={b.i}
            animate={state === 'speaking' ? { scaleY: [0.15, b.peak + 0.55, 0.15] } : { scaleY: 0.12 }}
            transition={
              state === 'speaking'
                ? { duration: b.d, repeat: Infinity, ease: 'easeInOut', delay: b.i * 0.02 }
                : { duration: 0.3 }
            }
          />
        ))}
      </div>
    </div>
  )
}
