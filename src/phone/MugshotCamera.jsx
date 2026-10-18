// The mugshot camera: a selfie, cropped to the mugshot shape and turned into
// a gritty black-and-white JPEG on the phone (small enough to upload
// instantly). Players can retake it or skip and keep their emoji.

import React, { useEffect, useRef, useState } from 'react'
import { Mugshot } from '../components/shared.jsx'
import { PHOTO_MAX } from '../lib/rules.js'

const OUT_W = 250
const OUT_H = 300 // 5:6, the mugshot frame's shape

// Crop the middle of the video frame to 5:6, mirror it for selfies, and turn
// it into a high-contrast black-and-white photo with a little grain.
export function makeMugshot(video, mirror) {
  const vw = video.videoWidth
  const vh = video.videoHeight
  const target = OUT_W / OUT_H
  const cw = vw / vh > target ? vh * target : vw
  const ch = vw / vh > target ? vh : vw / target
  const canvas = document.createElement('canvas')
  canvas.width = OUT_W
  canvas.height = OUT_H
  const ctx = canvas.getContext('2d')
  if (mirror) {
    ctx.translate(OUT_W, 0)
    ctx.scale(-1, 1)
  }
  ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, OUT_W, OUT_H)
  const img = ctx.getImageData(0, 0, OUT_W, OUT_H)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const grey = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    const v = Math.max(0, Math.min(255, (grey - 128) * 1.3 + 132 + (Math.random() - 0.5) * 14))
    d[i] = d[i + 1] = d[i + 2] = v
  }
  ctx.putImageData(img, 0, 0)
  let quality = 0.75
  let url = canvas.toDataURL('image/jpeg', quality)
  while (url.length > PHOTO_MAX && quality > 0.3) {
    quality -= 0.15
    url = canvas.toDataURL('image/jpeg', quality)
  }
  return url
}

export default function MugshotCamera({ player, onDone, onSkip }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [facing, setFacing] = useState('user')
  const [status, setStatus] = useState('starting') // starting | live | taken | error
  const [error, setError] = useState(null)
  const [shot, setShot] = useState(null)

  useEffect(() => {
    if (status === 'taken') return undefined
    let stopped = false
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(window.isSecureContext === false
          ? 'The camera only works on a secure (https) link.'
          : "This browser can't use the camera.")
        setStatus('error')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 960 } },
          audio: false,
        })
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const v = videoRef.current
        v.srcObject = stream
        await v.play().catch(() => {})
        setStatus('live')
      } catch (err) {
        setError(err?.name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow it in your browser settings, or skip.'
          : 'No camera found.')
        setStatus('error')
      }
    }
    start()
    return () => {
      stopped = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [facing, status === 'taken'])

  const snap = () => {
    const v = videoRef.current
    if (!v?.videoWidth) return
    try {
      navigator.vibrate?.(40)
    } catch {
      // no vibration
    }
    setShot(makeMugshot(v, facing === 'user'))
    setStatus('taken')
  }

  const preview = { ...player, photo: shot }

  return (
    <div className="phone mugcam">
      <h2 className="mugcam-title">Step up for your mugshot</h2>
      <p className="mugcam-hint">Face the camera. No smiling. (Smiling is allowed.)</p>

      {status === 'taken' ? (
        <div className="mugcam-preview"><Mugshot player={preview} width={250} /></div>
      ) : (
        <div className="mugcam-view">
          <video ref={videoRef} playsInline muted className={facing === 'user' ? 'mirrored' : ''} />
          <span className="mugshot-chart" aria-hidden="true" />
          <span className="mugcam-guide" aria-hidden="true" />
          {status === 'starting' && <div className="mugcam-msg">Starting camera…</div>}
          {status === 'error' && <div className="mugcam-msg">{error}</div>}
        </div>
      )}

      <div className="mugcam-actions">
        {status === 'taken' ? (
          <>
            <button type="button" className="btn btn-pink btn-block" onClick={() => onDone(shot)}>Use this mugshot</button>
            <button type="button" className="btn btn-ghost btn-block" onClick={() => { setShot(null); setStatus('starting') }}>Retake</button>
          </>
        ) : (
          <div className="mugcam-row">
            <button type="button" className="btn btn-ghost mugcam-flip" aria-label="Switch camera" disabled={status !== 'live'}
              onClick={() => { setFacing((f) => (f === 'user' ? 'environment' : 'user')); setStatus('starting') }}>↻</button>
            <button type="button" className="btn btn-pink mugcam-snap" disabled={status !== 'live'} onClick={snap}>📸 Snap mugshot</button>
          </div>
        )}
        <p className="mugcam-privacy">Your photo is only shown in this room, and is deleted along with old rooms (usually within a day).</p>
        <button type="button" className="mugcam-skip" onClick={onSkip}>Skip, use my emoji instead</button>
      </div>
    </div>
  )
}
