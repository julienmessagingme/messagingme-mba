/**
 * Logo MM Business Agent : 3 brins à symétrie parfaite (0/120/240°), un canal par couleur
 * (navy = marque, bleu = action, vert = conversation aboutie). Géométrie du design system.
 * `mono` -> monochrome via currentColor (pour les lockups sobres / header).
 */
export function Logo({ className, mono = false }: { className?: string; mono?: boolean }) {
  const navy = mono ? 'currentColor' : '#181C40';
  const blue = mono ? 'currentColor' : '#009AFE';
  const green = mono ? 'currentColor' : '#17C74E';
  const d = 'M 80 14 L 80 58 Q 80 70 92 70 L 140 70';
  return (
    <svg viewBox="0 0 160 160" className={className} xmlns="http://www.w3.org/2000/svg" role="img" aria-label="MM Business Agent">
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth={15}>
        <path d={d} stroke={navy} />
        <path d={d} transform="rotate(120 80 80)" stroke={blue} />
        <path d={d} transform="rotate(240 80 80)" stroke={green} />
      </g>
    </svg>
  );
}
