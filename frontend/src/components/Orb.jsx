import { useMemo, useState } from 'react'
import { motion, useSpring, useTransform } from 'framer-motion'

// States: idle | listening | thinking | speaking | camera | error
// Level is a Framer Motion value (0..1) fed by Web Audio analyser
const BARS = 32
const SPARKLES = [
  { id: 1, top: '15%', left: '10%', size: 3, delay: 0, dur: 4.2 },
  { id: 2, top: '22%', right: '12%', size: 4, delay: 1.1, dur: 5.0 },
  { id: 3, bottom: '18%', left: '14%', size: 3.5, delay: 2.3, dur: 4.6 },
  { id: 4, bottom: '26%', right: '8%', size: 2.5, delay: 0.7, dur: 3.8 },
  { id: 5, top: '8%', left: '46%', size: 3, delay: 1.8, dur: 5.5 },
  { id: 6, bottom: '10%', left: '52%', size: 4, delay: 3.0, dur: 4.0 },
]

export default function Orb({ state, level }) {
  const spring = useSpring(level, { stiffness: 240, damping: 18 })
  const listenScale = useTransform(spring, (v) => 1 + v * 0.45)
  const ringScale = useTransform(spring, (v) => 1 + v * 0.28)
  const glow = useTransform(
    spring,
    (v) => `0 0 ${40 + v * 80}px ${10 + v * 30}px rgba(255, 255, 255, ${0.25 + v * 0.35})`
  )

  // Interactive mouse tilt for 3D glass parallax
  const [tilt, setTilt] = useState({ x: 0, y: 0 })

  const handleMouseMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width - 0.5) * 22
    const y = ((e.clientY - rect.top) / rect.height - 0.5) * -22
    setTilt({ x, y })
  }

  const handleMouseLeave = () => {
    setTilt({ x: 0, y: 0 })
  }

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
    <div
      className="orb-wrap"
      data-state={state}
      role="img"
      aria-label={`VISION is ${state}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
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

      {/* Floating Micro-Crystal Sparkles (Monochrome Glass Dust) */}
      <div className="orb-sparkles-field" aria-hidden="true">
        {SPARKLES.map((s) => (
          <motion.div
            key={s.id}
            className="orb-sparkle"
            style={{
              top: s.top,
              left: s.left,
              right: s.right,
              bottom: s.bottom,
              width: s.size,
              height: s.size,
            }}
            animate={{
              opacity: [0.15, 0.85, 0.15],
              scale: [0.8, 1.4, 0.8],
              y: [0, -8, 0],
            }}
            transition={{
              duration: s.dur,
              delay: s.delay,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
          />
        ))}
      </div>

      <motion.div
        className="orb-stage-3d"
        animate={{
          rotateX: tilt.y,
          rotateY: tilt.x,
          y: floating ? [0, -10, 0] : 0,
        }}
        transition={{
          rotateX: { type: 'spring', stiffness: 120, damping: 14 },
          rotateY: { type: 'spring', stiffness: 120, damping: 14 },
          y: floating ? { duration: 5.5, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.4 },
        }}
      >
        {/* Unique Gyroscopic 3D Glass Rings System (Celestial Gimbal) */}
        <div className="orb-gimbal" aria-hidden="true">
          {/* Orbital Ring 1: Primary 3D Tilted Glass Ring */}
          <motion.div
            className="orb-gyro-ring ring-primary"
            style={state === 'listening' ? { scale: ringScale } : undefined}
            animate={{
              rotateZ: state === 'thinking' ? 360 : [0, 360],
              scale: state === 'thinking' ? [1, 1.06, 1] : state === 'speaking' ? [1, 1.04, 1] : 1,
            }}
            transition={{
              rotateZ: {
                duration: state === 'thinking' ? 3.5 : 22,
                repeat: Infinity,
                ease: 'linear',
              },
              scale: {
                duration: state === 'thinking' ? 1.4 : 2.5,
                repeat: Infinity,
                ease: 'easeInOut',
              },
            }}
          >
            {/* Travelling Specular Diamond Bead */}
            <div className="gyro-bead bead-primary" />
          </motion.div>

          {/* Orbital Ring 2: Counter-Rotating Secondary Glass Ring */}
          <motion.div
            className="orb-gyro-ring ring-secondary"
            style={state === 'listening' ? { scale: ringScale } : undefined}
            animate={{
              rotateZ: state === 'thinking' ? -360 : [0, -360],
              scale: state === 'thinking' ? [1, 0.94, 1] : state === 'speaking' ? [1, 1.03, 1] : 1,
            }}
            transition={{
              rotateZ: {
                duration: state === 'thinking' ? 4.2 : 28,
                repeat: Infinity,
                ease: 'linear',
              },
              scale: {
                duration: state === 'thinking' ? 1.6 : 3,
                repeat: Infinity,
                ease: 'easeInOut',
              },
            }}
          >
            {/* Travelling Specular Diamond Bead */}
            <div className="gyro-bead bead-secondary" />
          </motion.div>
        </div>

        {/* Thinking State: Extra Fast Liquid Caustic Aura */}
        {state === 'thinking' && (
          <motion.div
            className="orb-thinking-vortex"
            animate={{ rotate: 360, scale: [0.95, 1.08, 0.95] }}
            transition={{
              rotate: { duration: 4, repeat: Infinity, ease: 'linear' },
              scale: { duration: 1.8, repeat: Infinity, ease: 'easeInOut' },
            }}
          />
        )}

        {/* Listening State: Pulsing Sonic Wave Rings */}
        {state === 'listening' && (
          <motion.div
            className="orb-pulse-ring"
            animate={{ scale: [1, 1.4, 1], opacity: [0.65, 0.08, 0.65] }}
            transition={{ duration: 1.7, repeat: Infinity, ease: 'easeOut' }}
          />
        )}

        {/* Core Pure Clear Glass Orb with Dynamic Prismatic Layers */}
        <motion.div
          className="orb-core"
          style={state === 'listening' ? { scale: listenScale, boxShadow: glow } : undefined}
          animate={
            state === 'listening'
              ? undefined
              : state === 'thinking'
              ? { scale: [1, 0.96, 1.03, 1] }
              : state === 'speaking'
              ? { scale: [1, 1.04, 0.98, 1] }
              : state === 'error'
              ? { scale: [1, 1.02, 1] }
              : { scale: [1, 1.025, 1] }
          }
          transition={{
            duration: state === 'thinking' ? 1.8 : state === 'speaking' ? 2.2 : 5,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        >
          {/* Inner Caustics (Monochromatic Dynamic Optical Liquid) */}
          <div className="orb-liquid" style={{ filter: 'url(#liquid)' }} />

          {/* Sweeping Specular Lens Light Flare */}
          <div className="orb-lens-flare" />

          {/* Optical Specular Glare (White Glass Highlight) */}
          <div className="orb-shine" />

          {/* Secondary Ambient Caustic Reflection */}
          <div className="orb-refraction" />

          {/* Bottom Rim Ambient Reflection */}
          <div className="orb-rim-glow" />

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
