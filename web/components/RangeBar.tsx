'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { PRESETS, activePreset, presetRange, todayParis, type DateRange } from '@/lib/range';

const inputCls =
  'rounded-md border border-ink-300 bg-white px-2 py-1 text-xs text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

/**
 * Bandeau de periode des ecrans Analytics : titre a gauche, raccourcis 7/30/90 jours et saisie libre a droite.
 *
 * Partage par les deux ecrans (quantitatif et qualitatif) plutot que duplique : les deux doivent proposer
 * EXACTEMENT la meme periode, sinon comparer un chiffre de l'un a une conversation de l'autre devient faux.
 *
 * La plage vit chez le parent (c'est lui qui recharge ses donnees quand elle change) ; seul le brouillon des
 * deux champs de date est local, pour ne rien recharger tant que « Appliquer » n'a pas ete cliquee.
 */
export function RangeBar({ title, range, onChange }: {
  title: string;
  range: DateRange;
  onChange: (range: DateRange) => void;
}) {
  const t = useT();
  const [draftFrom, setDraftFrom] = useState(range.from);
  const [draftTo, setDraftTo] = useState(range.to);
  const today = todayParis();
  const preset = activePreset(range, today);

  function applyPreset(days: number) {
    const r = presetRange(days);
    onChange(r);
    setDraftFrom(r.from);
    setDraftTo(r.to);
  }
  function applyCustom() {
    if (draftFrom && draftTo && draftFrom <= draftTo) onChange({ from: draftFrom, to: draftTo });
  }

  return (
    // FIGE en haut au scroll. top-12 = juste sous la barre de compte AppShell (sticky top-0, ~48px) ;
    // z-20 < z-30 (header) pour ne pas la chevaucher ; bg = fond de page, pour masquer les cartes qui
    // defilent dessous.
    <div className="sticky top-12 z-20 flex flex-wrap items-center justify-between gap-3 bg-[#F7F8FB] py-2">
      <h2 className="text-base font-semibold tracking-tight text-ink-900">{title}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-xs">
          {PRESETS.map((d) => (
            <button
              key={d}
              onClick={() => applyPreset(d)}
              className={`rounded-md px-2.5 py-1 ${preset === d ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
            >
              {d} {t('j', 'd')}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center gap-1.5">
          <input type="date" value={draftFrom} max={draftTo || today} onChange={(e) => setDraftFrom(e.target.value)} className={inputCls} />
          <span className="text-ink-400">→</span>
          <input type="date" value={draftTo} min={draftFrom} max={today} onChange={(e) => setDraftTo(e.target.value)} className={inputCls} />
          <button
            onClick={applyCustom}
            disabled={!draftFrom || !draftTo || draftFrom > draftTo}
            className="rounded-md bg-brand-500 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {t('Appliquer', 'Apply')}
          </button>
        </div>
      </div>
    </div>
  );
}
