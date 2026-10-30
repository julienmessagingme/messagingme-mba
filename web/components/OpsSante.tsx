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

/** Le nom d'un signal dans une alerte (lot 4), les clés des briques ; une autre garde sa clé. */
const NOMS_ALERTES: Record<string, [string, string]> = {
  api: ['Erreurs 5xx de l’API', 'API 5xx errors'],
  'memoire-workers': ['Mémoire des workers', 'Workers memory'],
  machine: ['Processeur de la machine', 'Machine CPU'],
  base: ['Connexions de la base', 'Database connections'],
  'processeur-base': ['Processeur de la base', 'Database CPU'],
  entrants: ['Retard des entrants', 'Inbound delay'],
  accuses: ['Retard des accusés', 'Receipts delay'],
};

/** Les briques que cet écran sait mettre en mots ; une autre (ajoutée par une API plus récente) est ignorée. */
const BRIQUES_CONNUES: ReadonlySet<string> = new Set([
  'api', 'workers', 'memoire-workers', 'machine', 'base', 'processeur-base', 'entrants', 'accuses', 'hubspot',
]);

export function OpsSante({ jeton, onPerdue, onRevision }: { jeton: string; onPerdue: () => void; onRevision?: (revision: string) => void }) {
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
        if (Array.isArray(s?.briques) && s.jauge && s.seuils && s.meta && s.incidents) {
          setSante(s);
          if (typeof s.revision === 'string') onRevision?.(s.revision);
        } else setErreur(t('Santé illisible pour l’instant.', 'Health unavailable right now.'));
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
  }, [jeton, onPerdue, onRevision, t]);

  if (erreur) return <p className="rounded-carte border border-ink-200 bg-white p-5 text-sm text-ink-500" data-testid="ops-sante-erreur">{erreur}</p>;
  if (!sante) return <Squelette forme="carte" />;

  const s = sante.seuils;
  const cx = sante.connexions;
  const nomSignal = {
    base: t('connexions de la base', 'database connections'),
    entrants: t('messages entrants', 'inbound messages'),
    accuses: t('accusés de Meta', 'Meta receipts'),
    'processeur-base': t('processeur de la base', 'database CPU'),
    machine: t('processeur de la machine des workers', 'workers machine CPU'),
    'memoire-workers': t('mémoire des workers', 'workers memory'),
  }[sante.jauge.signal] ?? sante.jauge.signal;
  const marge = sante.jauge.margePourcent;
  const teinteJauge = marge <= 0 ? TEINTE.rouge : marge < 40 ? TEINTE.orange : TEINTE.vert;

  const illisible = t('lecture impossible : la base ou l’API est peut-être saturée', 'reading failed: the database or the API may be saturated');
  // Les briques de Cockpit : une mesure absente dit Cockpit muet, pas la production en panne.
  const sansCockpit = t('mesure indisponible : Cockpit ne répond pas', 'measure unavailable: Cockpit is not answering');
  const pourcent = (m: number): string => `${Math.round(m)} %`;
  const rougeA = (seuil: { rouge: number } | undefined, defaut: number): number => seuil?.rouge ?? defaut;

  function libelle(b: BriqueSanteOps): { titre: string; raison: string } {
    const m = b.mesure;
    switch (b.cle) {
      case 'api':
        return { titre: 'API', raison: b.indisponible ? illisible : m === null ? t('moins de 20 requêtes dans l’heure : rien à juger', 'fewer than 20 requests this hour: nothing to judge') : t(`${fmtNum(Math.round(m * 10) / 10, locale)} % d’erreurs 5xx dans l’heure (rouge à ${s.erreurs.rouge} %)`, `${fmtNum(Math.round(m * 10) / 10, locale)}% 5xx errors this hour (red at ${s.erreurs.rouge}%)`) };
      case 'workers':
        return { titre: t('Workers', 'Workers'), raison: b.indisponible ? illisible : m === null ? t('aucun worker n’a jamais battu', 'no worker has ever beaten') : t(`dernier battement du ${b.detail ?? ''} il y a ${duree(m)}`, `last beat from ${b.detail ?? ''} ${duree(m)} ago`) };
      case 'base':
        return { titre: t('Base de données', 'Database'), raison: b.indisponible ? illisible : m === null ? t('connexions illisibles', 'connections unreadable') : t(`${Math.round(m)} % des connexions (${cx?.utilisees ?? '?'} sur ${cx?.max ?? '?'}, rouge à ${s.connexions.rouge} %)`, `${Math.round(m)}% of connections (${cx?.utilisees ?? '?'} of ${cx?.max ?? '?'}, red at ${s.connexions.rouge}%)`) };
      case 'entrants':
        return { titre: t('Messages entrants', 'Inbound messages'), raison: b.indisponible ? illisible : m === null ? t('aucun en attente ni traité récemment', 'none waiting or recently handled') : t(`retard ${duree(m)} (rouge à ${duree(s.entrants.rouge)})`, `delay ${duree(m)} (red at ${duree(s.entrants.rouge)})`) };
      case 'accuses':
        return { titre: t('Accusés de Meta', 'Meta receipts'), raison: b.indisponible ? illisible : m === null ? t('aucun en attente ni traité récemment', 'none waiting or recently handled') : t(`retard ${duree(m)} (rouge à ${duree(s.accuses.rouge)})`, `delay ${duree(m)} (red at ${duree(s.accuses.rouge)})`) };
      case 'memoire-workers': {
        const rouge = rougeA(s.memoireWorker, 85);
        return { titre: t('Mémoire des workers', 'Workers memory'), raison: b.indisponible ? illisible : m === null ? t('aucun relevé récent', 'no recent reading') : t(`${b.detail ?? ''} à ${pourcent(m)} de sa limite (rouge à ${rouge} %)`, `${b.detail ?? ''} at ${pourcent(m)} of its limit (red at ${rouge}%)`) };
      }
      case 'machine': {
        const rouge = rougeA(s.processeurMachine, 80);
        return { titre: t('Machine des workers', 'Workers machine'), raison: b.indisponible || m === null ? sansCockpit : t(`processeur à ${pourcent(m)} sur 15 min (rouge à ${rouge} %)`, `CPU at ${pourcent(m)} over 15 min (red at ${rouge}%)`) };
      }
      case 'processeur-base': {
        const rouge = rougeA(s.processeurBase, 80);
        return { titre: t('Processeur de la base', 'Database CPU'), raison: b.indisponible || m === null ? sansCockpit : t(`${pourcent(m)} sur 15 min (rouge à ${rouge} % : passer en DB-DEV-L)`, `${pourcent(m)} over 15 min (red at ${rouge}%: move to DB-DEV-L)`) };
      }
      case 'hubspot':
        return { titre: t('Porte HubSpot', 'HubSpot door'), raison: b.indisponible || m === null ? sansCockpit : m === 0 ? t('endormie : elle se réveille au premier appel', 'asleep: it wakes up on the first call') : t(`éveillée (${m} copie${m > 1 ? 's' : ''})`, `awake (${m} cop${m > 1 ? 'ies' : 'y'})`) };
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
        {sante.jauge.partielle && (
          <p className="mt-1 text-xs text-alerte-700" data-testid="ops-jauge-partielle">
            {t('Marge partielle : une lecture a échoué, elle ne compte que les autres signaux.', 'Partial headroom: a reading failed, only the other signals count.')}
          </p>
        )}
      </section>

      <section className="grid gap-2 sm:grid-cols-2" data-testid="ops-briques">
        {sante.briques.filter((b) => BRIQUES_CONNUES.has(b.cle) && b.etat in TEINTE).map((b) => {
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
        <p className="mt-1 text-xs text-ink-500">
          {t('Enregistrés quand le worker les traite : si les entrants sont en retard, ces heures le sont aussi.', 'Recorded when the worker handles them: if inbound is delayed, these times are too.')}
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-500">{t('Dernier message enregistré', 'Last message recorded')}</dt>
          <dd className="text-ink-900">{quand(sante.meta.dernierMessage)}</dd>
          <dt className="text-ink-500">{t('Dernier accusé enregistré', 'Last receipt recorded')}</dt>
          <dd className="text-ink-900">{quand(sante.meta.dernierAccuse)}</dd>
        </dl>
      </section>

      <section className="rounded-carte border border-ink-200 bg-white p-5" data-testid="ops-incidents">
        <h2 className="text-sm font-semibold text-ink-900">{t('Incidents', 'Incidents')}</h2>
        <ul className="mt-2 space-y-1 text-sm text-ink-700">
          <li>{t(`Erreurs 5xx de l’API (24 h) : ${inc.erreurs5xx}`, `API 5xx errors (24 h): ${inc.erreurs5xx}`)}</li>
          <li>{t(`Jobs en échec gardés par pg-boss (7 jours) : ${inc.tachesEnEchec}`, `Failed jobs kept by pg-boss (7 days): ${inc.tachesEnEchec}`)}</li>
          <li>{t(`En attente dans les files d’échec (à rejouer) : ${inc.fileEchec}`, `Waiting in dead letter queues (to replay): ${inc.fileEchec}`)}</li>
          {inc.alertes === null && (
            <li data-testid="ops-alertes-illisibles">{t('Alertes Telegram illisibles pour l’instant', 'Telegram alerts unreadable for now')}</li>
          )}
          {inc.alertes !== undefined && inc.alertes !== null && (inc.alertes.length === 0
            ? <li data-testid="ops-alertes-aucune">{t('Aucune alerte Telegram envoyée (24 h)', 'No Telegram alert sent (24 h)')}</li>
            : inc.alertes.map((a, i) => (
              <li key={`${a.signal}-${a.envoyeLe}-${i}`} data-testid="ops-alerte">
                {t('Alerte', 'Alert')} {formatDate(a.envoyeLe, locale, { hour: '2-digit', minute: '2-digit' })} : {(NOMS_ALERTES[a.signal] ?? [a.signal, a.signal])[locale === 'en' ? 1 : 0]}{' '}
                <span className={TEINTE[a.etat]?.texte ?? ''}>{a.etat === 'vert' ? t('revenu au vert', 'back to green') : a.etat === 'orange' ? t('orange', 'orange') : t('rouge', 'red')}</span>
              </li>
            )))}
          {inc.demarrages.length === 0
            ? <li>{t('Aucun démarrage de worker (24 h)', 'No worker start (24 h)')}</li>
            : inc.demarrages.map((d) => (
              <li key={d.role}>{t(`Worker ${d.role} démarré le ${quand(d.demarreLe)} (déploiement ou redémarrage)`, `Worker ${d.role} started ${quand(d.demarreLe)} (deployment or restart)`)}</li>
            ))}
        </ul>
      </section>
    </div>
  );
}
