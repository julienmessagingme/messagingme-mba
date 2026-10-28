'use client';

import { useEffect, useState, type ComponentProps } from 'react';
import { getOpsCapacite, type CapaciteOps } from '@/lib/api';
import { ApiError } from '@/lib/http';
import { useT } from '@/lib/i18n';
import { DailyChart } from '@/components/DailyChart';
import { Squelette } from '@/components/Squelette';
import { alerte, brand, danger, ink, navy, succes } from '@/lib/couleurs';
import { dayKey } from '@/lib/day';
import { cockpitParJour, copiesDeLHeure, debutMesure, memoireWorkerParJour, MINUTES_MONTEE_MIN, montees7Jours, parJour, retardParJour, rolesDeMemoire } from '@/lib/ops-capacite';

/**
 * L'ONGLET CAPACITÉ DE /OPS (refonte, lots 1 et 2) : trente jours, un point par jour (le pire du jour), et sous chaque
 * courbe ce que veut dire en franchir le seuil. Les copies d'API, le retard des files et les attentes du pool sont nos
 * mesures ; le processeur, la mémoire, les connexions et le disque viennent de Cockpit (lot 2), la mémoire de chaque
 * worker de son propre relevé. Une API d'avant le lot 2 ne rend ni `cockpit` ni `memoires` : leurs courbes ne
 * s'affichent pas. Le coût arrive au lot 3.
 */
const COULEURS_WORKERS = [navy[400], succes[500], alerte[700], danger[600]];

/** Un graphique qui commence à son premier jour mesuré (`debutMesure`). */
function Courbe(props: ComponentProps<typeof DailyChart>) {
  return <DailyChart {...props} from={debutMesure(props.series, props.from)} />;
}
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
        <Courbe
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
        <Courbe
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
        <Courbe
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

      <CourbesCockpit capacite={capacite} from={from} to={to} />
    </div>
  );
}

/** Le processeur, la mémoire, les connexions et le disque (lot 2), et ce qui les remplace quand Cockpit manque. */
function CourbesCockpit({ capacite, from, to }: { capacite: CapaciteOps; from: string; to: string }) {
  const t = useT();
  const memoires = capacite.memoires;
  const cockpit = capacite.cockpit;
  // Une API d'avant le lot 2 : rien à montrer, rien à dire.
  if (memoires === undefined && cockpit === undefined) return null;
  const series = cockpit?.configure ? cockpit.series : null;
  const s = capacite.seuils;
  const note = 'px-1 text-xs text-ink-500';
  const roles = rolesDeMemoire(memoires ?? []);
  const etatCockpit = !cockpit || !cockpit.configure
    ? t('Cockpit n’est pas configuré : le processeur, la mémoire et le disque arrivent avec son jeton.', 'Cockpit is not configured: CPU, memory and disk arrive with its token.')
    : series === null
      ? t('Mesures de Cockpit indisponibles pour l’instant : seule la mémoire des workers est tracée.', 'Cockpit measures unavailable right now: only workers memory is drawn.')
      : null;

  return (
    <>
      {etatCockpit && <p className="rounded-carte border border-ink-200 bg-white p-5 text-sm text-ink-500" data-testid="ops-cockpit-etat">{etatCockpit}</p>}

      {series && (
        <section className="space-y-2" data-testid="ops-capacite-processeur">
          <Courbe
            title={t('Processeur (%, moyenne sur 15 min)', 'CPU (%, 15 min average)')}
            subtitle={t('le pire de chaque jour', 'daily worst')}
            summary="last"
            from={from}
            to={to}
            series={[
              { label: t('Base', 'Database'), color: brand[400], points: cockpitParJour(series.baseProcesseur) },
              { label: t('Machine des workers', 'Workers machine'), color: alerte[500], points: cockpitParJour(series.machineProcesseur) },
            ]}
          />
          <p className={note}>
            {t(
              `Base : orange à ${s.processeurBase?.orange ?? 60} %, rouge à ${s.processeurBase?.rouge ?? 80} %, passer en DB-DEV-L. Machine : orange à ${s.processeurMachine?.orange ?? 60} %, rouge à ${s.processeurMachine?.rouge ?? 80} %, une machine plus grosse.`,
              `Database: orange at ${s.processeurBase?.orange ?? 60}%, red at ${s.processeurBase?.rouge ?? 80}%, move to DB-DEV-L. Machine: orange at ${s.processeurMachine?.orange ?? 60}%, red at ${s.processeurMachine?.rouge ?? 80}%, a bigger machine.`,
            )}
          </p>
        </section>
      )}

      {series && (
        <section className="space-y-2" data-testid="ops-capacite-memoire">
          <Courbe
            title={t('Mémoire (%)', 'Memory (%)')}
            subtitle={t('le pire de chaque jour', 'daily worst')}
            summary="last"
            from={from}
            to={to}
            series={[
              { label: t('Base', 'Database'), color: brand[400], points: cockpitParJour(series.baseMemoire) },
              { label: t('Machine des workers', 'Workers machine'), color: ink[400], points: cockpitParJour(series.machineMemoire) },
              { label: t('Copie d’API (sa limite)', 'API copy (its limit)'), color: danger[400], points: cockpitParJour(series.apiMemoire) },
            ]}
          />
          <p className={note}>
            {t(
              'La base garde du cache : sa mémoire haute n’est pas une alerte. Une copie d’API près de sa limite, si : elle redémarre en perdant ses requêtes en cours.',
              'The database keeps cache: high memory is not an alert. An API copy near its limit is: it restarts and loses its in-flight requests.',
            )}
          </p>
        </section>
      )}

      {/* Les workers à part : leurs relevés commencent au lot 2, ils ne partagent pas le début des courbes de Cockpit. */}
      {roles.length > 0 && (
        <section className="space-y-2" data-testid="ops-capacite-memoire-workers">
          <Courbe
            title={t('Mémoire des workers (% de leur limite)', 'Workers memory (% of their limit)')}
            subtitle={t('le pire de chaque jour', 'daily worst')}
            summary="last"
            from={from}
            to={to}
            series={roles.map((role, i) => ({
              label: t(`Worker ${role}`, `Worker ${role}`),
              color: COULEURS_WORKERS[i % COULEURS_WORKERS.length]!,
              points: memoireWorkerParJour(memoires ?? [], role),
            }))}
          />
          <p className={note}>
            {t(
              `Orange à ${s.memoireWorker?.orange ?? 70} %, rouge à ${s.memoireWorker?.rouge ?? 85} % de sa limite : monter sa limite, ou la machine.`,
              `Orange at ${s.memoireWorker?.orange ?? 70}%, red at ${s.memoireWorker?.rouge ?? 85}% of its limit: raise its limit, or the machine.`,
            )}
          </p>
        </section>
      )}

      {series && (
        <section className="space-y-2" data-testid="ops-capacite-base">
          <Courbe
            title={t('Base : connexions et disque (%)', 'Database: connections and disk (%)')}
            subtitle={t('le pire de chaque jour', 'daily worst')}
            summary="last"
            from={from}
            to={to}
            series={[
              { label: t('Connexions', 'Connections'), color: brand[400], points: cockpitParJour(series.baseConnexions) },
              { label: t('Disque', 'Disk'), color: navy[400], points: cockpitParJour(series.baseDisque) },
            ]}
          />
          <p className={note}>
            {t(
              `Connexions : orange à ${s.connexions.orange} %, rouge à ${s.connexions.rouge} %, revoir le budget de connexions ou une base plus grosse. Le disque n’a pas de seuil réglé : il se lit ici.`,
              `Connections: orange at ${s.connexions.orange}%, red at ${s.connexions.rouge}%, review the connection budget or a bigger database. Disk has no threshold set: read it here.`,
            )}
          </p>
        </section>
      )}
    </>
  );
}
