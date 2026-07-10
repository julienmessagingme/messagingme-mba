'use client';

import { useMemo, useState } from 'react';
import type { DailyPoint } from '@/lib/api';

export interface ChartSeries {
  label: string;
  color: string;
  points: DailyPoint[];
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function lastNDays(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(ymd(d));
  }
  return out;
}
function fmtDay(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

const W = 520;
const H = 150;
const PAD = { top: 12, right: 12, bottom: 20, left: 28 };

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Courbe lissée (spline Catmull-Rom -> Bézier cubique, tension douce) passant par tous les points.
 *  Rend des lignes moins « cassées » que des segments droits, sans dépendance externe. Les points de
 *  contrôle en y sont bornés à l'intervalle des deux ancres du segment : pas d'overshoot de la spline
 *  sous 0 (ou au-dessus du max) sur des données en pic — l'aire ne déborde jamais sous la ligne du 0. */
function smoothLine(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
  const t = 0.18; // tension : 0 = segments droits, plus haut = plus courbe (0.18 = doux)
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

/** Graphique « 1 point/jour » (aire + ligne), 1 ou plusieurs séries superposées. SVG maison. */
export function DailyChart({
  title,
  series,
  days,
  subtitle,
  summary = 'sum',
}: {
  title: string;
  series: ChartSeries[];
  days: number;
  subtitle?: string;
  /** Grand chiffre affiché : 'sum' = total de la période (séries en flux) ; 'last' = dernière valeur
   *  (séries CUMULÉES, ex. contacts — sommer les snapshots journaliers n'aurait aucun sens). */
  summary?: 'sum' | 'last';
}) {
  const [hover, setHover] = useState<number | null>(null);
  const dates = useMemo(() => lastNDays(days), [days]);

  const data = useMemo(
    () =>
      series.map((s) => {
        const byDate = new Map(s.points.map((p) => [p.date, p.count]));
        return { ...s, values: dates.map((d) => byDate.get(d) ?? 0) };
      }),
    [series, dates],
  );

  const lastVals = data[0]?.values ?? [];
  const total =
    summary === 'last'
      ? lastVals[lastVals.length - 1] ?? 0
      : data.reduce((acc, s) => acc + s.values.reduce((a, b) => a + b, 0), 0);
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

  return (
    <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold tracking-tight text-ink-900">{title}</h3>
        <span className="text-2xl font-bold tracking-tight text-ink-900">{total}</span>
      </div>
      {subtitle && <p className="mb-2 text-xs text-ink-400">{subtitle}</p>}
      {series.length > 1 && (
        <div className="mb-1 flex gap-3">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1 text-xs text-ink-500">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ overflow: 'visible' }}>
          <defs>
            {data.map((s, si) => (
              <linearGradient key={si} id={`grad-${gid}-${si}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.22" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {/* grille horizontale */}
          {[0, 0.5, 1].map((f) => (
            <line key={f} x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH * (1 - f)} y2={PAD.top + innerH * (1 - f)} stroke="#E7E9F0" strokeWidth="1" />
          ))}
          <text x={PAD.left - 6} y={PAD.top + 4} textAnchor="end" className="fill-ink-300 text-[9px]">{max}</text>
          <text x={PAD.left - 6} y={PAD.top + innerH} textAnchor="end" className="fill-ink-300 text-[9px]">0</text>

          {data.map((s, si) => {
            const { line, area } = pathFor(s.values);
            return (
              <g key={si}>
                <path d={area} fill={`url(#grad-${gid}-${si})`} />
                <path d={line} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}

          {/* dates extrêmes */}
          <text x={PAD.left} y={H - 5} textAnchor="start" className="fill-ink-300 text-[9px]">{fmtDay(dates[0] ?? '')}</text>
          <text x={W - PAD.right} y={H - 5} textAnchor="end" className="fill-ink-300 text-[9px]">{fmtDay(dates[n - 1] ?? '')}</text>

          {/* survol */}
          {hover !== null && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} stroke="#A6ABC6" strokeWidth="1" strokeDasharray="3 3" />
              {data.map((s, si) => (
                <circle key={si} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r="3.5" fill="#fff" stroke={s.color} strokeWidth="2" />
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
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-lg bg-ink-900 px-2 py-1 text-[11px] text-white shadow-lg"
            style={{ left: `${(x(hover) / W) * 100}%`, top: 0 }}
          >
            <div className="font-medium">{fmtDay(dates[hover] ?? '')}</div>
            {data.map((s) => (
              <div key={s.label} className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.color }} />
                {series.length > 1 ? `${s.label}: ` : ''}{s.values[hover] ?? 0}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
