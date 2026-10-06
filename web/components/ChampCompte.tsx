'use client';

import type { InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'maxLength' | 'value'> & { max: number; value: string };

/**
 * Un champ d'une ligne qui montre, dans le champ à droite, les caractères consommés sur le maximum (`3/20`). Le
 * `maxLength` reste posé : le compteur montre la limite, il ne la remplace pas.
 */
export function ChampCompte({ max, value, className = '', ...props }: Props) {
  const plein = value.length >= max;
  return (
    <div className="relative w-full">
      <input {...props} value={value} maxLength={max} className={`${className} pr-12`} />
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs tabular-nums ${plein ? 'font-medium text-danger' : 'text-ink-500'}`}
      >
        {value.length}/{max}
      </span>
    </div>
  );
}
