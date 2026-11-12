import { useCallback, useEffect, useRef, useState } from 'react'

// The camera only starts from start(), which the UI calls from a button press.
export function useCamera() {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [active, setActive] = useState(false)
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState('')
  const [size, setSize] = useState({ w: 4, h: 3 })

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setActive(false)
    setPaused(false)
  }, [])

  const start = useCallback(async () => {
    setError('')
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera access needs HTTPS (or localhost) and a modern browser.')
      return false
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false, // microphone permission is requested separately
      })
      streamRef.current = stream
      const v = videoRef.current
      v.srcObject = stream
      await v.play()
      setSize({ w: v.videoWidth || 4, h: v.videoHeight || 3 })
      setActive(true)
      setPaused(false)
      return true
    } catch (e) {
      const msg =
        e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in your browser/system settings, then try again.'
        : e.name === 'NotFoundError' ? 'No camera was found.'
        : e.name === 'NotReadableError' ? 'The camera is in use by another app.'
        : e.message || 'Could not start the camera.'
      setError(msg)
      return false
    }
  }, [])

  const togglePause = useCallback(() => {
    const v = videoRef.current
    if (!v || !streamRef.current) return
    if (v.paused) {
      v.play()
      setPaused(false)
    } else {
      v.pause() // freezes the preview; analysis of live frames stops while paused
      setPaused(true)
    }
  }, [])

  // JPEG of the current frame, max 960px on the long side. Held in memory only.
  const capture = useCallback(() => {
    const v = videoRef.current
    if (!v || !streamRef.current || !v.videoWidth) return Promise.reject(new Error('Camera is not active.'))
    const scale = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight))
    const c = document.createElement('canvas')
    c.width = Math.round(v.videoWidth * scale)
    c.height = Math.round(v.videoHeight * scale)
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height)
    return new Promise((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not capture a frame.'))), 'image/jpeg', 0.85),
    )
  }, [])

  useEffect(() => stop, [stop])

  return { videoRef, active, paused, error, size, start, stop, togglePause, capture }
}
