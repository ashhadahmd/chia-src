/* Google's "G" in its 2025 blended style: the four colours flow into each other around the
   letter instead of sitting in hard-edged blocks. A conic gradient painted through the G's
   shape (a CSS mask) gives that blend, which an SVG fill alone can't. */
const G_SHAPE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Cpath d='M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5zM46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65zM10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19zM24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z'/%3E%3C/svg%3E\")"

// The crossbar is solid blue; the conic gradient blends the colours around the bowl.
const BLEND =
  'linear-gradient(#3186ff 0 0) 100% 51.2% / 52% 19% no-repeat, conic-gradient(from 0deg at 50% 50%, #ff4131 0deg, #ff4131 38deg, #3186ff 82deg, #3186ff 128deg, #00a94f 168deg, #00a94f 205deg, #ffcc00 245deg, #ffcc00 278deg, #ff4131 322deg, #ff4131 360deg)'

export default function GoogleMark({ size = 18 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        flex: 'none',
        width: size,
        height: size,
        background: BLEND,
        WebkitMask: `${G_SHAPE} center / contain no-repeat`,
        mask: `${G_SHAPE} center / contain no-repeat`,
      }}
    />
  )
}
