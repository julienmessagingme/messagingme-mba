'use client';

import { useMemo, useState } from 'react';
import type { DailyPoint } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { useT } from '@/lib/i18n';

export interface ChartSeries {
  label: string;
  color: string;
  points: DailyPoint[];
}

/** Dates YYYY-MM-DD de `from` à `to` INCLUS (bornes réelles, PAS ancrées sur aujourd'hui). Arithmétique UTC. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  let cur = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  while (cur <= end) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86400000;
  }
  return out.length > 0 ? out : [from];
}
function fmtDay(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

const W = 560;
const H = 176;
const PAD = { top: 16, right: 14, bottom: 22, left: 8 };

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Courbe lissée (spline Catmull-Rom -> Bézier cubique, tension douce) passant par tous les points.
 *  Points de contrôle en y bornés aux ancres du segment : pas d'overshoot sous 0 sur des pics. */
function smoothLine(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
  const t = 0.18;
  let d = `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const loY = Math.min(p1.y, p2.y);
    const hiY = Math.max(p1.y, p2.y);
    const c1x = p1.x + (p2.x - p0.x) * t;
    const c1y = clamp(p1.y + (p2.y - p0.y) * t, loY, hiY);
    const c2x = p2.x - (p3.x - p1.x) * t;
    const c2y = clamp(p2.y - (p3.y - p1.y) * t, loY, hiY);
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

/**
 * Graphe « 1 point/jour » (aire lissée + ligne), une ou plusieurs séries. SVG maison, tokens MM.
 * En-tête : libellé + grand chiffre + tendance (cumulé) ou Pic/Moyenne (flux) + point courant en fin
 * de courbe. Survol : repère vertical + points + tooltip.
 */
export function DailyChart({
  title,
  series,
  from,
  to,
  subtitle,
  summary = 'sum',
}: {
  title: string;
  series: ChartSeries[];
  /** Bornes de l'axe (YYYY-MM-DD, Europe/Paris), `to` inclus. */
  from: string;
  to: string;
  subtitle?: string;
  /** Grand chiffre : 'sum' = total période (flux) ; 'last' = dernière valeur (séries CUMULÉES). */
  summary?: 'sum' | 'last';
}) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const dates = useMemo(() => daysBetween(from, to), [from, to]);

  const data = useMemo(
    () =>
      series.map((s) => {
        const byDate = new Map(s.points.map((p) => [p.date, p.count]));
        return { ...s, values: dates.map((d) => byDate.get(d) ?? 0) };
      }),
    [series, dates],
  );

  const primary = data[0]?.values ?? [];
  const hero =
    summary === 'last'
      ? primary[primary.length - 1] ?? 0
      : data.reduce((acc, s) => acc + s.values.reduce((a, b) => a + b, 0), 0);

  // Tendance (séries cumulées) : évolution nette sur la période.
  const delta = summary === 'last' ? (primary[primary.length - 1] ?? 0) - (primary[0] ?? 0) : null;
  // Métriques (séries flux, une seule série) : pic + moyenne.
  const peak = primary.length ? Math.max(...primary) : 0;
  const avg = primary.length ? Math.round(primary.reduce((a, b) => a + b, 0) / primary.length) : 0;

  const max = Math.max(1, ...data.flatMap((s) => s.values));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const n = dates.length;
  const x = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;

  function pathFor(values: number[]): { line: string; area: string } {
    const pts = values.map((v, i) => ({ x: x(i), y: y(v) }));
    const line = smoothLine(pts);
    const base = (PAD.top + innerH).toFixed(1);
    const area = pts.length === 0 ? '' : `${line} L ${x(n - 1).toFixed(1)} ${base} L ${x(0).toFixed(1)} ${base} Z`;
    return { line, area };
  }

  const gid = title.replace(/[^a-z0-9]/gi, '');
  const multi = series.length > 1;

  return (
    <div className="rounded-2xl border border-ink-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(11,14,36,0.04),0_12px_28px_-16px_rgba(11,14,36,0.14)]">
      {/* En-tête : libellé + grand chiffre + tendance / métriques */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">{title}</div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-[2.5rem] font-light leading-none tracking-tight text-ink-900 tabular-nums">{fmtNum(hero)}</span>
            {delta !== null && (
              <span
                className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium ${
                  delta > 0 ? 'bg-mint-50 text-mint-700' : delta < 0 ? 'bg-coral/10 text-coral' : 'bg-ink-100 text-ink-500'
                }`}
              >
                {delta > 0 ? '↗' : delta < 0 ? '↘' : '→'} {delta > 0 ? '+' : ''}
                {fmtNum(delta)}
              </span>
            )}
          </div>
          {subtitle && <p className="mt-1 text-xs text-ink-400">{subtitle}</p>}
        </div>

        {multi ? (
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {data.map((s) => (
              <span key={s.label} className="flex items-center gap-1.5 text-xs text-ink-500">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                {s.label}
                <span className="font-semibold text-ink-800 tabular-nums">{fmtNum(s.values[s.values.length - 1] ?? 0)}</span>
              </span>
            ))}
          </div>
        ) : (
          <div className="flex shrink-0 gap-2">
            <MiniStat label={t('Pic', 'Peak')} value={fmtNum(peak)} />
            <MiniStat label={t('Moy.', 'Avg.')} value={fmtNum(avg)} />
          </div>
        )}
      </div>

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ overflow: 'visible' }}>
          <defs>
            {data.map((s, si) => (
              <linearGradient key={si} id={`grad-${gid}-${si}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.20" />
                <stop offset="55%" stopColor={s.color} stopOpacity="0.05" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {/* grille horizontale discrète (4 paliers) */}
          {[0, 0.33, 0.66, 1].map((f) => (
            <line
              key={f}
              x1={PAD.left}
              x2={W - PAD.right}
              y1={PAD.top + innerH * (1 - f)}
              y2={PAD.top + innerH * (1 - f)}
              stroke="#EEF0F5"
              strokeWidth="1"
              strokeDasharray={f === 0 ? '0' : '2 5'}
            />
          ))}

          {data.map((s, si) => {
            const { line, area } = pathFor(s.values);
            const lastY = y(s.values[s.values.length - 1] ?? 0);
            const lastX = x(n - 1);
            return (
              <g key={si}>
                <path d={area} fill={`url(#grad-${gid}-${si})`} />
                <path d={line} fill="none" stroke={s.color} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />
                {/* point courant (fin de courbe) avec halo doux */}
                <circle cx={lastX} cy={lastY} r="5.5" fill={s.color} opacity="0.16" />
                <circle cx={lastX} cy={lastY} r="3" fill="#fff" stroke={s.color} strokeWidth="2" />
              </g>
            );
          })}

          {/* dates extrêmes */}
          <text x={PAD.left} y={H - 4} textAnchor="start" className="fill-ink-300 text-[10px]">{fmtDay(dates[0] ?? '')}</text>
          <text x={W - PAD.right} y={H - 4} textAnchor="end" className="fill-ink-300 text-[10px]">{fmtDay(dates[n - 1] ?? '')}</text>

          {/* survol */}
          {hover !== null && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} stroke="#C7CBDA" strokeWidth="1" strokeDasharray="3 3" />
              {data.map((s, si) => (
                <circle key={si} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r="4" fill="#fff" stroke={s.color} strokeWidth="2.25" />
              ))}
            </>
          )}

          <rect
            x={PAD.left}
            y={PAD.top}
            width={innerW}
            height={innerH}
            fill="transparent"
            onMouseMove={(e) => {
              const rect = (e.target as SVGRectElement).getBoundingClientRect();
              const rel = (e.clientX - rect.left) / rect.width;
              setHover(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
            }}
            onMouseLeave={() => setHover(null)}
          />
        </svg>

        {hover !== null && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg bg-ink-900 px-2.5 py-1.5 text-[11px] text-white shadow-lg"
            style={{ left: `${(x(hover) / W) * 100}%`, top: -4 }}
          >
            <div className="mb-0.5 font-semibold text-white/70">{fmtDay(dates[hover] ?? '')}</div>
            {data.map((s) => (
              <div key={s.label} className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.color }} />
                {multi ? `${s.label} ` : ''}
                <span className="font-semibold tabular-nums">{fmtNum(s.values[hover] ?? 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-ink-50 px-2.5 py-1.5 text-right">
      <div className="text-[10px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className="text-sm font-semibold text-ink-800 tabular-nums">{value}</div>
    </div>
  );
}
