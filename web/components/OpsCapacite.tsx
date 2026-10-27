'use client';

import { useEffect, useState } from 'react';
import { getOpsCapacite, type CapaciteOps } from '@/lib/api';
import { ApiError } from '@/lib/http';
import { useT } from '@/lib/i18n';
import { DailyChart } from '@/components/DailyChart';
import { Squelette } from '@/components/Squelette';
import { alerte, brand, danger, ink } from '@/lib/couleurs';
import { dayKey } from '@/lib/day';
import { copiesDeLHeure, MINUTES_MONTEE_MIN, montees7Jours, parJour, retardParJour } from '@/lib/ops-capacite';

/**
 * L'ONGLET CAPACITÉ DE /OPS (refonte, lot 1) : trente jours, un point par jour, de ce qu'on mesure déjà (les copies
 * d'API, le retard des files, les attentes du pool), et sous chaque courbe ce que veut dire en franchir le seuil. Le
 * processeur et la mémoire de la base et de la machine arrivent avec Cockpit (lot 2), le coût au lot 3.
 */
export function OpsCapacite({ jeton, onPerdue }: { jeton: string; onPerdue: () => void }) {
  const t = useT();
  const [capacite, setCapacite] = useState<CapaciteOps | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    getOpsCapacite(jeton)
      .then((c) => {
        if (!vivant) return;
        // Une API d'une autre version peut rendre une autre forme : l'onglet le dit au lieu de faire tomber la page.
        if (Array.isArray(c?.heures) && Array.isArray(c.files) && c.seuils && typeof c.jours === 'number') setCapacite(c);
        else setErreur(t('Historique illisible pour l’instant.', 'History unavailable right now.'));
      })
      .catch((e: unknown) => {
        if (!vivant) return;
        if (e instanceof ApiError && e.status === 401) { onPerdue(); return; }
        setErreur(e instanceof ApiError && e.status === 404
          ? t('L’historique arrive avec le prochain déploiement de l’API.', 'The history arrives with the next API deployment.')
          : t('Historique illisible pour l’instant.', 'History unavailable right now.'));
      });
    return () => { vivant = false; };
  }, [jeton, onPerdue, t]);

  if (erreur) return <p className="rounded-carte border border-ink-200 bg-white p-5 text-sm text-ink-500" data-testid="ops-capacite-erreur">{erreur}</p>;
  if (!capacite) return <Squelette forme="carte" />;

  const to = dayKey(new Date().toISOString());
  const from = dayKey(new Date(Date.now() - (capacite.jours - 1) * 24 * 3600 * 1000).toISOString());
  const { montees, heures } = montees7Jours(capacite.heures);
  const s = capacite.seuils;
  // Le graphique porte déjà son cadre : la note se lit dessous, sans second cadre autour.
  const bloc = 'space-y-2';
  const note = 'px-1 text-xs text-ink-500';

  return (
    <div className="space-y-4" data-testid="ops-capacite">
      <section className={bloc} data-testid="ops-capacite-copies">
        <DailyChart
          title={t('Copies d’API allumées', 'API copies running')}
          subtitle={t('le plus haut de chaque jour', 'daily peak')}
          summary="last"
          from={from}
          to={to}
          series={[{ label: t('Copies', 'Copies'), color: brand[400], points: parJour(capacite.heures, copiesDeLHeure, 'max') }]}
        />
        <p className={note}>
          {t(
            `Sur 7 jours : ${montees} montée(s) à 2 copies ou plus, ${heures} h en tout. Orange à 3 montées, rouge à 1 h : la copie de base est devenue trop petite. Moins de ${MINUTES_MONTEE_MIN} minutes à deux copies (un déploiement) ne compte pas.`,
            `Over 7 days: ${montees} rise(s) to 2 copies or more, ${heures} h in total. Orange at 3 rises, red at 1 h: the base copy has become too small. Under ${MINUTES_MONTEE_MIN} minutes at two copies (a deployment) does not count.`,
          )}
        </p>
      </section>

      <section className={bloc} data-testid="ops-capacite-files">
        <DailyChart
          title={t('Retard des files (p95, secondes)', 'Queue delay (p95, seconds)')}
          subtitle={t('le pire de chaque jour', 'daily worst')}
          summary="last"
          from={from}
          to={to}
          series={[
            { label: t('Accusés de Meta', 'Meta receipts'), color: alerte[500], points: retardParJour(capacite.files, 'webhook-status') },
            { label: t('Messages entrants', 'Inbound messages'), color: brand[400], points: retardParJour(capacite.files, 'webhook') },
          ]}
        />
        <p className={note}>
          {t(
            `Accusés : orange à ${s.accuses.orange} s, rouge à ${s.accuses.rouge} s, la base devient trop lente (DB-DEV-L). Entrants : orange à ${s.entrants.orange} s, rouge à ${s.entrants.rouge} s, les workers ou la base saturent.`,
            `Receipts: orange at ${s.accuses.orange} s, red at ${s.accuses.rouge} s, the database is too slow (DB-DEV-L). Inbound: orange at ${s.entrants.orange} s, red at ${s.entrants.rouge} s, workers or database saturate.`,
          )}
        </p>
      </section>

      <section className={bloc} data-testid="ops-capacite-pool">
        <DailyChart
          title={t('Attentes du pool de connexions', 'Connection pool waits')}
          subtitle={t('acquisitions sur pool saturé, par jour', 'acquisitions on a saturated pool, per day')}
          from={from}
          to={to}
          series={[
            { label: 'API', color: danger[400], points: parJour(capacite.heures, (h) => h.attentesApi, 'somme') },
            { label: 'Workers', color: ink[400], points: parJour(capacite.heures, (h) => h.attentesWorkers, 'somme') },
          ]}
        />
        <p className={note}>
          {t(
            'Quelques attentes isolées sont normales. Des attentes tous les jours disent que la base ou le pool sont trop petits.',
            'A few isolated waits are normal. Waits every day mean the database or the pool are too small.',
          )}
        </p>
      </section>
    </div>
  );
}
