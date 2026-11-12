// Tiny PCM -> WAV encoder so we can send speech to the backend without needing ffmpeg.
export function downsample(buf, from, to) {
  if (to >= from) return buf
  const ratio = from / to
  const len = Math.floor(buf.length / ratio)
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    const s = Math.floor(i * ratio)
    const e = Math.min(buf.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = s; j < e; j++) sum += buf[j]
    out[i] = sum / Math.max(1, e - s)
  }
  return out
}

export function encodeWav(chunks, sampleRate, targetRate = 16000) {
  let total = 0
  for (const c of chunks) total += c.length
  const merged = new Float32Array(total)
  let o = 0
  for (const c of chunks) {
    merged.set(c, o)
    o += c.length
  }
  const pcm = downsample(merged, sampleRate, targetRate)
  const rate = Math.min(sampleRate, targetRate)
  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(buffer)
  const str = (off, s) => [...s].forEach((ch, i) => v.setUint8(off + i, ch.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length * 2, true)
  str(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
