'use client';

import { useEffect, useState } from 'react';
import { inputCls } from '@/lib/ui';

/**
 * Un champ texte enregistré à la SORTIE du champ, comme les écrans d'agent et de l'agent de Meta : pas de bouton par
 * champ, pas d'écriture à chaque frappe, et rien n'est envoyé si la valeur n'a pas changé. `multi` en fait une zone de
 * texte de `lignes` lignes (3 par défaut). Un seul exemplaire pour la fiche d'un agent et les réglages d'un outil.
 */
export function ChampSortie({ label, aide, valeur, multi, lignes = 3, onSave, testId, busy }: {
  label: string; aide?: string; valeur: string; multi?: boolean; lignes?: number; testId: string; busy: boolean;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(valeur);
  useEffect(() => { setV(valeur); }, [valeur]);
  const commun = {
    'data-testid': testId,
    className: inputCls,
    value: v,
    disabled: busy,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV(e.target.value),
    onBlur: () => { if (v !== valeur) onSave(v); },
  };
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-ink-900">{label}</label>
      {multi ? <textarea rows={lignes} {...commun} /> : <input {...commun} />}
      {aide && <p className="text-xs leading-relaxed text-ink-500">{aide}</p>}
    </div>
  );
}
