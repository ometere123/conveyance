/**
 * The plate mark: an engraver's lozenge with one ink rule across it.
 *
 * Deliberately not the seal. The seal in `conveyance-seal.tsx` means three named proofs
 * landed, and printing it in the running head of every page would be claiming that on pages
 * where nothing has been proved. So the masthead gets a counter shape instead, which is what a
 * security-printed instrument carries when it is blank: the lozenge is guilloche linework, the
 * single rule across it is document ink, and the rule is the conveyance.
 *
 * Colours are CSS variables here and literal hex in `src/app/icon.svg`; the favicon is served
 * as a static file and cannot read the stylesheet. Keep the two geometries in step, and keep
 * every coordinate even: the figure has to halve onto whole pixels at 16px.
 */
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className="inline-block shrink-0 align-[-0.15em]"
    >
      <rect width="32" height="32" fill="var(--plate)" />
      <path
        d="M16 6 26 16 16 26 6 16Z"
        fill="none"
        stroke="var(--guilloche)"
        strokeWidth="4"
      />
      <path d="M10 16h12" stroke="var(--document)" strokeWidth="4" />
    </svg>
  );
}
