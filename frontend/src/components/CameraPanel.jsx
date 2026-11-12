// Live preview + detection overlay + results. The <video> element is always mounted so the
// camera hook keeps a stable ref; it is hidden until the user starts the camera.
export default function CameraPanel({ cam, scene, liveDetect, onToggleLive, onCapture, busy, remote, host }) {
  const { videoRef, active, paused, error, size, start, stop, togglePause } = cam
  const img = scene?.image
  const fs = img ? Math.max(12, img.width * 0.028) : 14

  return (
    <section className="glass panel camera-panel" aria-label="Camera">
      <div className="panel-head">
        <h2>Camera</h2>
        {active && <span className="pill live">{paused ? 'Paused' : 'Camera on'}</span>}
      </div>

      <div className="viewport" style={{ aspectRatio: `${size.w} / ${size.h}` }} hidden={!active}>
        <video ref={videoRef} playsInline muted aria-label="Live camera preview" />
        {scene && img && (
          <svg className="overlay" viewBox={`0 0 ${img.width} ${img.height}`} preserveAspectRatio="none" aria-hidden="true">
            {scene.objects.map((o, i) => {
              const { x1, y1, x2, y2 } = o.box
              const label = `${o.name} ${Math.round(o.confidence * 100)}%`
              const w = label.length * fs * 0.58 + 10
              return (
                <g key={i}>
                  <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} className="box" strokeWidth={Math.max(2, img.width * 0.004)} />
                  <rect x={x1} y={Math.max(0, y1 - fs - 8)} width={w} height={fs + 8} className="tag" rx="4" />
                  <text x={x1 + 5} y={Math.max(fs, y1 - 6)} fontSize={fs} className="tagtext">{label}</text>
                </g>
              )
            })}
          </svg>
        )}
        {active && !paused && <div className="scanline" aria-hidden="true" />}
      </div>

      {!active && (
        <div className="placeholder">
          <p>The camera is off.</p>
          <p className="muted">VISION only uses it after you press <b>Start camera</b> and allow access.</p>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      <div className="row wrap">
        {!active ? (
          <button className="btn primary" onClick={start}>Start camera</button>
        ) : (
          <>
            <button className="btn" onClick={togglePause}>{paused ? 'Resume' : 'Pause'}</button>
            <button className="btn" onClick={onCapture} disabled={busy}>Capture &amp; analyse</button>
            <button className="btn danger" onClick={stop}>Stop camera</button>
            <label className="toggle">
              <input type="checkbox" checked={liveDetect} onChange={(e) => onToggleLive(e.target.checked)} />
              <span>Live detection</span>
            </label>
          </>
        )}
      </div>

      {active && remote && (
        <p className="warn">Frames are sent to <b>{host}</b> for analysis, not processed on this device.</p>
      )}

      {scene && (
        <div className="results" aria-live="polite">
          <h3>{scene.count} object{scene.count === 1 ? '' : 's'} detected</h3>
          {scene.limited && <p className="warn">Limited mode: only people can be detected. Install the YOLO packages for everyday objects.</p>}
          {scene.count === 0 && <p className="muted">None of the object types my model knows are visible in this frame.</p>}
          <ul>
            {scene.objects.map((o, i) => (
              <li key={i}>
                <span className="name">{o.name}</span>
                <span className="meter"><i style={{ width: `${Math.round(o.confidence * 100)}%` }} /></span>
                <span className="conf">{Math.round(o.confidence * 100)}%</span>
                <span className="muted small">{o.position}{o.color ? ` · ${o.color.name}` : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
