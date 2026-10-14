export default function Brand({ size = 28 }: { size?: number }) {
  return (
    <span className="brand">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="var(--sage)" />
        <path
          d="M16 25c0-6 1.5-10.5 7-14-6 0-9.5 3-10.5 7.5C11 15.5 8.5 13.5 6 13c2 3.5 4.5 7 10 12Z"
          fill="var(--on-accent)"
        />
      </svg>
      <span className="brand-name">Chia</span>
    </span>
  )
}
