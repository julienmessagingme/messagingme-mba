/**
 * Logo Messaging Me : la bulle navy aux trois points, suivie de deux chevrons (bleu, vert). Géométrie relevée sur
 * le PNG de la marque (2026-10-06), à 1 % près. Les points sont des trous (`evenodd`), ils laissent voir le fond.
 * Le logo est deux fois plus large que haut : on le dimensionne par sa hauteur, avec `w-auto`.
 */
const LOGO_BULLE =
  'M60 2H414L588 216L414 430H60A60 60 0 0 1 0 370V62A60 60 0 0 1 60 2Z' +
  'M57 216a45 45 0 1 0 90 0a45 45 0 1 0-90 0Z' +
  'M206 216a45 45 0 1 0 90 0a45 45 0 1 0-90 0Z' +
  'M355 216a45 45 0 1 0 90 0a45 45 0 1 0-90 0Z';
const LOGO_CHEVRON_BLEU = 'M439 0H550L724 216L550 432H439L613 216Z';
const LOGO_CHEVRON_VERT = 'M573 0H684L858 216L684 432H573L747 216Z';

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 858 432" className={className} xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Messaging Me">
      <path d={LOGO_BULLE} fill="#212551" fillRule="evenodd" />
      <path d={LOGO_CHEVRON_BLEU} fill="#009BFF" />
      <path d={LOGO_CHEVRON_VERT} fill="#17C74E" />
    </svg>
  );
}
