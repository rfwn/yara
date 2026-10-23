/** Yara's mark (public/yara-logo.svg, the designer's Asset 2), drawn in currentColor on the accent tile. */
export function LogoGlyph({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 108.57) / 101.68} viewBox="0 0 101.68 108.57" fill="currentColor" aria-hidden>
      <path d="M78.6,61.9l21.98-.06c.99,21.63-9.78,43.42-33.12,45.83-11.48,1.19-23.01,1.2-34.48-.02C12.28,105.46.14,86.67.12,67.53l-.03-6.41,21.93.03.46,6.2c.16,8.72,6.53,15.72,15.3,16.41,8.28.65,16.61.65,24.85.02s14.3-6.65,15.16-14.48l.82-7.4Z" />
      <path d="M79.15,24.27c-5.81.07-7.5,5.95-6.71,11.52l-21.92.21C47.35,18.06,59.43.3,78.68.16l22.98-.16.03,24.02-22.53.25Z" />
      <rect y=".04" width="35.3" height="24.07" />
    </svg>
  );
}

export function LogoMark({ size = 24, className = "logo-mark" }: { size?: number; className?: string }) {
  return (
    <span className={className} style={{ width: size, height: size }} aria-hidden>
      <LogoGlyph size={Math.round(size * 0.54)} />
    </span>
  );
}
