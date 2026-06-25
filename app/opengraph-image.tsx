import { ImageResponse } from 'next/og'

/**
 * Dynamically generated Open Graph image (also used by Twitter via og:image
 * fallback). Branded card shown when getgrantify.com is shared.
 */
export const alt = 'Grantify — AI-assisted grant management for nonprofits'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '80px',
          background: 'linear-gradient(135deg, #022c22 0%, #064e3b 55%, #047857 100%)',
          color: 'white',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ fontSize: 40, fontWeight: 700, color: '#6ee7b7' }}>Grantify</div>
        <div style={{ fontSize: 68, fontWeight: 700, lineHeight: 1.1, marginTop: 24 }}>
          From grant discovery to submission — in a week
        </div>
        <div style={{ fontSize: 32, opacity: 0.8, marginTop: 28 }}>
          AI-assisted grant management for nonprofits
        </div>
      </div>
    ),
    size
  )
}
