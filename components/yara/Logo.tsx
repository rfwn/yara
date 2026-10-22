/** Yara's mark: a check inside a rounded square, the approval at the heart of the product. */
export function LogoMark({ size = 24, className = "logo-mark" }: { size?: number; className?: string }) {
  return (
    <span className={className} style={{ width: size, height: size }} aria-hidden>
      <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24">
        <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
