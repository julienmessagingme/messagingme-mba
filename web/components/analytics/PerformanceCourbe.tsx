'use client';

import { useMemo, useState } from 'react';
import { useT, useLocale } from '@/lib/i18n';
import { brand, ink, navy } from '@/lib/couleurs';
import { fmtDuree, type JourPerformance } from '@/lib/performance';

/**
 * Quantitatif > Performance : les deux médianes, réponse et résolution, jour par jour. SVG maison, comme les autres
 * cartes (`DailyChart`).
 *
 * 🔴 UN JOUR SANS DEMANDE EST UN TROU, PAS UN ZÉRO, et c'est pourquoi `DailyChart` ne sert pas ici : il comble les
 * jours absents par 0, ce qui est juste pour un volume et faux pour une durée. Tracer 0 dirait « ce jour-là, l'équipe
 * a répondu instantanément ». La ligne s'interrompt donc sur un jour sans mesure, et un point isolé reste un point.
 */

const W = 560;
const H = 176;
const PAD = { top: 16, right: 14, bottom: 22, left: 8 };

/** Dates YYYY-MM-DD de `from` à `to` INCLUS. Arithmétique UTC. */
function joursEntre(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  for (let cur = Date.UTC(fy, fm - 1, fd), fin = Date.UTC(ty, tm - 1, td); cur <= fin; cur += 86400000) {
    out.push(new Date(cur).toISOString().slice(0, 10));
  }
  return out.length > 0 ? out : [from];
}

const jj = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

export function PerformanceCourbe({ parJour, from, to }: { parJour: JourPerformance[]; from: string; to: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [survol, setSurvol] = useState<number | null>(null);
  const jours = useMemo(() => joursEntre(from, to), [from, to]);
  const series = useMemo(() => {
    const parDate = new Map(parJour.map((j) => [j.jour, j]));
    return [
      { cle: 'reponse', libelle: t('Réponse (médiane)', 'Response (median)'), couleur: brand[500], valeurs: jours.map((d) => parDate.get(d)?.reponseMediane ?? null) },
      { cle: 'resolution', libelle: t('Résolution (médiane)', 'Resolution (median)'), couleur: navy[400], valeurs: jours.map((d) => parDate.get(d)?.resolutionMediane ?? null) },
    ];
  }, [parJour, jours, t]);

  const max = Math.max(1, ...series.flatMap((s) => s.valeurs.filter((v): v is number => v !== null)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const n = jours.length;
  const x = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;

  /** Les tronçons continus d'une série : une ligne ne traverse jamais un jour sans mesure. */
  const troncons = (valeurs: Array<number | null>): string[] => {
    const out: string[] = [];
    let courant: string[] = [];
    valeurs.forEach((v, i) => {
      if (v === null) { if (courant.length > 1) out.push(courant.join(' ')); courant = []; return; }
      courant.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    });
    if (courant.length > 1) out.push(courant.join(' '));
    return out;
  };

  return (
    <div className="relative" data-testid="perf-courbe">
      <div className="mb-2 flex flex-wrap gap-3 text-xs text-ink-500">
        {series.map((s) => (
          <span key={s.cle} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.couleur }} />
            {s.libelle}
          </span>
        ))}
        <span>{t(`Échelle : jusqu’à ${fmtDuree(max, locale)}`, `Scale: up to ${fmtDuree(max, locale)}`)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ overflow: 'visible' }} role="img"
        aria-label={t('Médianes de réponse et de résolution, par jour', 'Median response and resolution times, by day')}>
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH * (1 - f)} y2={PAD.top + innerH * (1 - f)}
            stroke={ink[100]} strokeWidth="1" strokeDasharray={f === 0 ? '0' : '2 5'} />
        ))}
        {series.map((s) => (
          <g key={s.cle}>
            {troncons(s.valeurs).map((pts, i) => (
              <polyline key={i} points={pts} fill="none" stroke={s.couleur} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {s.valeurs.map((v, i) => (v === null ? null : (
              <circle key={i} cx={x(i)} cy={y(v)} r={survol === i ? 4 : 2.5} fill="#fff" stroke={s.couleur} strokeWidth="2" />
            )))}
          </g>
        ))}
        <text x={PAD.left} y={H - 4} textAnchor="start" className="fill-ink-300 text-[10px]">{jj(jours[0] ?? '')}</text>
        <text x={W - PAD.right} y={H - 4} textAnchor="end" className="fill-ink-300 text-[10px]">{jj(jours[n - 1] ?? '')}</text>
        {survol !== null && (
          <line x1={x(survol)} x2={x(survol)} y1={PAD.top} y2={PAD.top + innerH} stroke={ink[200]} strokeWidth="1" strokeDasharray="3 3" />
        )}
        <rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} fill="transparent"
          onMouseMove={(e) => {
            const r = (e.target as SVGRectElement).getBoundingClientRect();
            setSurvol(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
          }}
          onMouseLeave={() => setSurvol(null)} />
      </svg>
      {survol !== null && (
        <div className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-controle bg-ink-900 px-2.5 py-1.5 text-xs text-white shadow-mm-md"
          style={{ left: `${(x(survol) / W) * 100}%`, top: 0 }}>
          <div className="mb-0.5 font-semibold text-white/70">{jj(jours[survol] ?? '')}</div>
          {series.map((s) => (
            <div key={s.cle} className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.couleur }} />
              {s.libelle} <span className="font-semibold tabular-nums">{fmtDuree(s.valeurs[survol] ?? null, locale)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
