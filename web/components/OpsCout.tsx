'use client';

import { useEffect, useState } from 'react';
import { getOpsCout, type CoutOps } from '@/lib/api';
import { ApiError } from '@/lib/http';
import { useLocale, useT } from '@/lib/i18n';
import { formatDate } from '@/lib/day';
import { fmtNum } from '@/lib/format';

/**
 * LE COÛT SCALEWAY DU MOIS, EN TÊTE DE L'ONGLET CAPACITÉ (refonte, lot 3) : ce qui est consommé depuis le 1er, hors
 * taxes et avant remise, sa projection au rythme du mois, et le détail par poste pour savoir quoi réduire. Lu par sa
 * propre route (`/ops/cout`), que le serveur garde trois heures. Une API d'avant le lot 3 (404) : la carte ne
 * s'affiche pas.
 */

/** Les postes de la facture de Scaleway, en français ; un poste inconnu garde son nom. */
const POSTES: Record<string, string> = {
  'Managed Databases': 'Bases de données',
  Compute: 'Machines',
  Serverless: 'Conteneurs serverless',
  Network: 'Réseau',
  Storage: 'Stockage',
  'Object Storage': 'Stockage objet',
  Containers: 'Registre d’images',
  'Security and Identity': 'Sécurité et identité',
  Observability: 'Observabilité',
};

export function OpsCout({ jeton, onPerdue }: { jeton: string; onPerdue: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const [etat, setEtat] = useState<CoutOps | 'absent' | 'erreur' | null>(null);

  useEffect(() => {
    let vivant = true;
    getOpsCout(jeton)
      .then((c) => { if (vivant) setEtat(c && typeof c === 'object' && 'configure' in c ? c : 'erreur'); })
      .catch((e: unknown) => {
        if (!vivant) return;
        if (e instanceof ApiError && e.status === 401) { onPerdue(); return; }
        setEtat(e instanceof ApiError && e.status === 404 ? 'absent' : 'erreur');
      });
    return () => { vivant = false; };
  }, [jeton, onPerdue]);

  const euros = (n: number): string => n.toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR', { style: 'currency', currency: 'EUR' });
  const carte = 'rounded-carte border border-ink-200 bg-white p-5';
  if (etat === null || etat === 'absent') return null;
  if (etat === 'erreur' || (etat.configure && etat.cout === null)) {
    return <p className={`${carte} text-sm text-ink-500`} data-testid="ops-cout-indisponible">{t('Coût Scaleway indisponible pour l’instant : la facturation n’a pas répondu.', 'Scaleway cost unavailable right now: billing did not answer.')}</p>;
  }
  if (!etat.configure) {
    return <p className={`${carte} text-sm text-ink-500`} data-testid="ops-cout-non-configure">{t('Le coût Scaleway arrive avec la clé de facturation (SCW_FACTURATION_CLE).', 'The Scaleway cost arrives with the billing key (SCW_FACTURATION_CLE).')}</p>;
  }
  const c = etat.cout!;
  const plusCher = c.postes[0]?.montantHt ?? 0;
  const libelle = (categorie: string): string => (locale === 'en' ? categorie : POSTES[categorie] ?? categorie);

  return (
    <section className={carte} data-testid="ops-cout">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink-900">{t('Coût Scaleway du mois (HT)', 'Scaleway cost this month (excl. tax)')}</h2>
        {c.majLe && <span className="text-xs text-ink-500">{t('mis à jour par Scaleway le', 'updated by Scaleway on')} {formatDate(c.majLe, locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-8 gap-y-2">
        <div>
          <div className="text-3xl font-semibold text-ink-900" data-testid="ops-cout-total">{euros(c.totalHt)}</div>
          <div className="text-xs text-ink-500">{t(`depuis le 1er, ${fmtNum(c.joursEcoules, locale)} jours sur ${c.joursDuMois}`, `since the 1st, ${fmtNum(c.joursEcoules, locale)} of ${c.joursDuMois} days`)}</div>
        </div>
        {c.projectionHt !== null && (
          <div>
            <div className="text-xl font-semibold text-ink-700" data-testid="ops-cout-projection">{euros(c.projectionHt)}</div>
            <div className="text-xs text-ink-500">{t('projection au rythme du mois', 'projection at this month’s pace')}</div>
          </div>
        )}
      </div>
      <ul className="mt-4 space-y-1.5" data-testid="ops-cout-postes">
        {c.postes.map((p) => (
          <li key={p.categorie} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm">
            <span className="truncate text-ink-700">{libelle(p.categorie)}</span>
            <span className="h-2 overflow-hidden rounded-full bg-ink-100">
              <span className="block h-full rounded-full bg-brand-400" style={{ width: `${plusCher > 0 ? Math.max(2, (100 * p.montantHt) / plusCher) : 0}%` }} />
            </span>
            <span className="text-right tabular-nums text-ink-900">{euros(p.montantHt)}</span>
          </li>
        ))}
      </ul>
      {c.lignes.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-ink-500">{t('Les lignes les plus chères', 'Most expensive lines')}</summary>
          <ul className="mt-2 space-y-1" data-testid="ops-cout-lignes">
            {c.lignes.map((l, i) => (
              <li key={`${l.produit}-${i}`} className="flex justify-between gap-3 text-ink-700">
                <span className="truncate">{l.produit} <span className="text-ink-400">({libelle(l.categorie)})</span></span>
                <span className="tabular-nums text-ink-900">{euros(l.montantHt)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="mt-3 text-xs text-ink-500">
        {t(
          'Toute l’organisation Scaleway, hors taxes et avant remise. Une réduction faite en cours de mois n’entre qu’en partie dans la projection.',
          'The whole Scaleway organization, excluding tax and before discount. A reduction made during the month only partly enters the projection.',
        )}
        {c.remiseHt > 0 && t(` Remise annoncée par Scaleway sur la facture : ${euros(c.remiseHt)}.`, ` Discount announced by Scaleway on the invoice: ${euros(c.remiseHt)}.`)}
      </p>
    </section>
  );
}
