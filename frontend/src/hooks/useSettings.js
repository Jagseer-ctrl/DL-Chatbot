import { useCallback, useState } from 'react'

const KEY = 'vision.settings.v1'
const DEFAULTS = {
  language: 'en', // en | hi | pa
  sttEngine: 'auto', // auto | browser | backend
  ttsEngine: 'auto', // auto | browser | piper
  voiceURI: '',
  speed: 1,
  muted: false,
  continuous: false,
  wakeWord: false,
  liveDetect: false,
}

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}'), wakeWord: false } // wake word always starts off
  } catch {
    return { ...DEFAULTS }
  }
}

// Only preferences are stored. Chat history, audio and camera frames are never persisted.
export function useSettings() {
  const [settings, setSettings] = useState(load)
  const update = useCallback((patch) => {
    setSettings((s) => {
      const next = { ...s, ...patch }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* storage unavailable */
      }
      return next
    })
  }, [])
  return [settings, update]
}
