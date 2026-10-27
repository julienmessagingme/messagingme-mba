'use client';

import { useEffect, useState } from 'react';
import { getOpsSante, type BriqueSanteOps, type SanteOps } from '@/lib/api';
import { ApiError } from '@/lib/http';
import { useLocale, useT } from '@/lib/i18n';
import { formatDate } from '@/lib/day';
import { Squelette } from '@/components/Squelette';
import { fmtNum } from '@/lib/format';

/**
 * L'ONGLET SANTÉ DE /OPS (refonte, lot 1 : `docs/superpowers/specs/2026-10-27-ops-refonte-design.md`). Lisible sur
 * téléphone d'abord : la jauge de capacité, une pastille par brique, les derniers signaux de Meta, les incidents des
 * 24 h. Le serveur juge (`src/ops/sante.ts`) et rend ses seuils ; l'écran ne fait que mettre en mots.
 */

const TEINTE = {
  vert: { pastille: 'bg-succes-500', fond: 'bg-succes-50', texte: 'text-succes-700' },
  orange: { pastille: 'bg-alerte-500', fond: 'bg-alerte-50', texte: 'text-alerte-700' },
  rouge: { pastille: 'bg-danger-500', fond: 'bg-danger-50', texte: 'text-danger-700' },
} as const;

/** Une durée en secondes, lisible : « 42 s », « 3 min », « 2 h ». */
function duree(secondes: number): string {
  if (secondes < 90) return `${Math.round(secondes)} s`;
  if (secondes < 5400) return `${Math.round(secondes / 60)} min`;
  return `${Math.round(secondes / 3600)} h`;
}

export function OpsSante({ jeton, onPerdue }: { jeton: string; onPerdue: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const [sante, setSante] = useState<SanteOps | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    getOpsSante(jeton)
      .then((s) => {
        if (!vivant) return;
        // Une API d'une autre version peut rendre une autre forme : l'onglet le dit au lieu de faire tomber la page.
        if (Array.isArray(s?.briques) && s.jauge && s.seuils && s.meta && s.incidents) setSante(s);
        else setErreur(t('Santé illisible pour l’instant.', 'Health unavailable right now.'));
      })
      .catch((e: unknown) => {
        if (!vivant) return;
        if (e instanceof ApiError && e.status === 401) { onPerdue(); return; }
        // Une API qui ne connaît pas encore la route (déployée après la console) : l'écran le dit, sans tomber.
        setErreur(e instanceof ApiError && e.status === 404
          ? t('L’onglet Santé arrive avec le prochain déploiement de l’API.', 'The Health tab arrives with the next API deployment.')
          : t('Santé illisible pour l’instant.', 'Health unavailable right now.'));
      });
    return () => { vivant = false; };
  }, [jeton, onPerdue, t]);

  if (erreur) return <p className="rounded-carte border border-ink-200 bg-white p-5 text-sm text-ink-500" data-testid="ops-sante-erreur">{erreur}</p>;
  if (!sante) return <Squelette forme="carte" />;

  const s = sante.seuils;
  const cx = sante.connexions;
  const nomSignal = { base: t('connexions de la base', 'database connections'), entrants: t('messages entrants', 'inbound messages'), accuses: t('accusés de Meta', 'Meta receipts') }[sante.jauge.signal];
  const marge = sante.jauge.margePourcent;
  const teinteJauge = marge <= 0 ? TEINTE.rouge : marge < 40 ? TEINTE.orange : TEINTE.vert;

  function libelle(b: BriqueSanteOps): { titre: string; raison: string } {
    const m = b.mesure;
    switch (b.cle) {
      case 'api':
        return { titre: 'API', raison: m === null ? t('aucune requête dans l’heure', 'no request this hour') : t(`${fmtNum(Math.round(m * 10) / 10, locale)} % d’erreurs 5xx dans l’heure (rouge à ${s.erreurs.rouge} %)`, `${fmtNum(Math.round(m * 10) / 10, locale)}% 5xx errors this hour (red at ${s.erreurs.rouge}%)`) };
      case 'workers':
        return { titre: t('Workers', 'Workers'), raison: m === null ? t('aucun worker n’a jamais battu', 'no worker has ever beaten') : t(`dernier battement du ${b.detail ?? ''} il y a ${duree(m)}`, `last beat from ${b.detail ?? ''} ${duree(m)} ago`) };
      case 'base':
        return { titre: t('Base de données', 'Database'), raison: m === null ? t('connexions illisibles', 'connections unreadable') : t(`${Math.round(m)} % des connexions (${cx?.utilisees ?? '?'} sur ${cx?.max ?? '?'}, rouge à ${s.connexions.rouge} %)`, `${Math.round(m)}% of connections (${cx?.utilisees ?? '?'} of ${cx?.max ?? '?'}, red at ${s.connexions.rouge}%)`) };
      case 'entrants':
        return { titre: t('Messages entrants', 'Inbound messages'), raison: m === null ? t('aucun dans l’heure', 'none this hour') : t(`retard ${duree(m)} (rouge à ${duree(s.entrants.rouge)})`, `delay ${duree(m)} (red at ${duree(s.entrants.rouge)})`) };
      case 'accuses':
        return { titre: t('Accusés de Meta', 'Meta receipts'), raison: m === null ? t('aucun dans l’heure', 'none this hour') : t(`retard ${duree(m)} (rouge à ${duree(s.accuses.rouge)})`, `delay ${duree(m)} (red at ${duree(s.accuses.rouge)})`) };
    }
  }

  const quand = (iso: string | null): string => (iso === null
    ? t('rien depuis 7 jours', 'nothing for 7 days')
    : formatDate(iso, locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
  const inc = sante.incidents;

  return (
    <div className="space-y-4" data-testid="ops-sante">
      <section className="rounded-carte border border-ink-200 bg-white p-5" data-testid="ops-jauge">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink-900">{t('Marge avant de devoir grossir', 'Headroom before scaling up')}</h2>
          <span className={`text-2xl font-semibold ${teinteJauge.texte}`}>{marge} %</span>
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-ink-100">
          <div className={`h-full rounded-full ${teinteJauge.pastille}`} style={{ width: `${Math.max(2, marge)}%` }} />
        </div>
        <p className="mt-2 text-xs text-ink-500">{t(`Signal le plus tendu : ${nomSignal}.`, `Tightest signal: ${nomSignal}.`)}</p>
      </section>

      <section className="grid gap-2 sm:grid-cols-2" data-testid="ops-briques">
        {sante.briques.map((b) => {
          const { titre, raison } = libelle(b);
          const teinte = TEINTE[b.etat];
          return (
            <div key={b.cle} className={`flex items-start gap-3 rounded-carte border border-ink-200 p-4 ${teinte.fond}`} data-testid={`ops-brique-${b.cle}`} data-etat={b.etat}>
              <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${teinte.pastille}`} aria-hidden />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-ink-900">{titre}</div>
                <div className={`text-xs ${teinte.texte}`}>{raison}</div>
              </div>
            </div>
          );
        })}
      </section>

      <section className="rounded-carte border border-ink-200 bg-white p-5" data-testid="ops-meta">
        <h2 className="text-sm font-semibold text-ink-900">{t('Derniers signaux de Meta', 'Latest signals from Meta')}</h2>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-500">{t('Dernier message reçu', 'Last message received')}</dt>
          <dd className="text-ink-900">{quand(sante.meta.dernierMessage)}</dd>
          <dt className="text-ink-500">{t('Dernier accusé', 'Last receipt')}</dt>
          <dd className="text-ink-900">{quand(sante.meta.dernierAccuse)}</dd>
        </dl>
      </section>

      <section className="rounded-carte border border-ink-200 bg-white p-5" data-testid="ops-incidents">
        <h2 className="text-sm font-semibold text-ink-900">{t('Incidents des 24 h', 'Last 24 h incidents')}</h2>
        <ul className="mt-2 space-y-1 text-sm text-ink-700">
          <li>{t(`Erreurs 5xx : ${inc.erreurs5xx}`, `5xx errors: ${inc.erreurs5xx}`)}</li>
          <li>{t(`Tâches en échec : ${inc.tachesEnEchec}`, `Failed tasks: ${inc.tachesEnEchec}`)}</li>
          <li>{t(`File d’échec : ${inc.fileEchec}`, `Dead letter queue: ${inc.fileEchec}`)}</li>
          {inc.demarrages.length === 0
            ? <li>{t('Aucun démarrage de worker', 'No worker start')}</li>
            : inc.demarrages.map((d) => (
              <li key={d.role}>{t(`Worker ${d.role} démarré le ${quand(d.demarreLe)} (déploiement ou redémarrage)`, `Worker ${d.role} started ${quand(d.demarreLe)} (deployment or restart)`)}</li>
            ))}
        </ul>
      </section>
    </div>
  );
}
