import { z } from 'zod';
import type { HttpGet } from '../lib/http-get';

/**
 * COCKPIT, L'OUTIL DE MESURE DE SCALEWAY, EN LECTURE (refonte de /ops, lot 2). Le processeur, la mémoire et le disque de
 * la base, de la machine des workers et des copies de l'API, que rien dans l'application ne voit. Requêtes PromQL sur la
 * source « Scaleway Metrics » du projet (31 jours gardés, gratuits), avec un jeton en LECTURE des métriques
 * (`COCKPIT_TOKEN`, posé par Julien dans les secrets du conteneur de l'API).
 *
 * 🔴 LES NOMS ET LES FORMULES ONT ÉTÉ MESURÉS, PAS LUS (2026-10-28) : la documentation ne donne pas les noms des séries.
 * Relevés avec le jeton (`docs/prive/cockpit-metriques.txt`), puis chaque formule ci-dessous évaluée sur les vraies
 * mesures avant d'être écrite (`docs/prive/cockpit-formules.txt`) : base 6,7 % de processeur sur 3 cœurs, 28 % de
 * mémoire, 5,6 % de disque, 16,7 % de connexions ; machine 1,6 % et 27 % ; copie d'API 22 % de sa mémoire ; la porte
 * HubSpot endormie n'a AUCUNE série (d'où zéro copie, pas une lecture en échec).
 *
 * Une panne de Cockpit dégrade l'affichage, jamais l'écran : chaque signal illisible vaut `null`, et une lecture où rien
 * ne répond rend `null` en entier. Le jeton ne part jamais dans un journal.
 */

/** Les ressources du projet, par leur nom chez Scaleway (`resource_name`). Les conteneurs portent le nom de leur espace en tête. */
export const RESSOURCES_COCKPIT = {
  base: 'mm-prod-db',
  machine: 'mm-workers',
  api: '.*-mba-api',
  hubspot: '.*-mm-hubspot-api',
} as const;

const B = `resource_name="${RESSOURCES_COCKPIT.base}"`;
const M = `resource_name="${RESSOURCES_COCKPIT.machine}"`;
const API = `resource_name=~"${RESSOURCES_COCKPIT.api}"`;
const HUB = `resource_name=~"${RESSOURCES_COCKPIT.hubspot}"`;

/** Chaque signal, en pourcentage sauf les copies. Le processeur se juge en moyenne sur 15 minutes (la spec). */
export const REQUETES_COCKPIT = {
  baseProcesseur: `100 * (1 - avg(rate(rdb_instance_postgresql_node_cpu_seconds_total{${B},mode="idle"}[15m])))`,
  baseMemoire: `100 * (1 - rdb_instance_postgresql_node_memory_MemAvailable_bytes{${B}} / rdb_instance_postgresql_node_memory_MemTotal_bytes{${B}})`,
  baseDisque: `100 * (1 - rdb_instance_postgresql_node_filesystem_avail_bytes{${B},mountpoint="/data"} / rdb_instance_postgresql_node_filesystem_size_bytes{${B},mountpoint="/data"})`,
  baseConnexions: `100 * sum(rdb_instance_postgresql_pg_stat_database_numbackends{${B}}) / max(rdb_instance_postgresql_pg_settings_max_connections{${B}})`,
  machineProcesseur: `100 * rate(instance_server_cpu_seconds_total{${M}}[15m]) / instance_server_vcpu_count{${M}}`,
  machineMemoire: `100 * (1 - instance_server_memory_available{${M}} / instance_server_memory_total{${M}})`,
  // La pire copie : une seule copie près de sa limite suffit à la faire tomber.
  apiMemoire: `100 * max(serverless_container_memory_usage_bytes{${API}} / serverless_container_memory_limit_bytes{${API}})`,
  hubspotCopies: `max(serverless_container_instances_total{${HUB}})`,
} as const;

export type SignalCockpit = keyof typeof REQUETES_COCKPIT;
/** Les signaux tracés sur 30 jours : tous sauf la porte HubSpot, qui n'a d'intérêt qu'à l'instant. */
export type SignalHistorique = Exclude<SignalCockpit, 'hubspotCopies'>;
export const SIGNAUX_HISTORIQUE: readonly SignalHistorique[] = [
  'baseProcesseur', 'baseMemoire', 'baseDisque', 'baseConnexions', 'machineProcesseur', 'machineMemoire', 'apiMemoire',
];

/** `null` = illisible (Cockpit muet, refus, autre forme). */
export type MesuresCockpit = Record<SignalCockpit, number | null>;
export interface PointCockpit { heure: string; valeur: number }
export type HistoriqueCockpit = Record<SignalHistorique, PointCockpit[] | null>;

export interface LecteurCockpit {
  /** Les valeurs de l'instant ; `null` quand aucune requête n'a répondu. */
  mesures(): Promise<MesuresCockpit | null>;
  /** Un point par heure (le pire de l'heure), sur `jours` jours ; `null` quand aucune requête n'a répondu. */
  historique(jours: number): Promise<HistoriqueCockpit | null>;
}

const echantillon = z.tuple([z.number(), z.string()]);
const vecteur = z.object({
  status: z.literal('success'),
  data: z.object({ resultType: z.literal('vector'), result: z.array(z.object({ value: echantillon })) }),
});
const matrice = z.object({
  status: z.literal('success'),
  data: z.object({ resultType: z.literal('matrix'), result: z.array(z.object({ values: z.array(echantillon) })) }),
});

/** Prometheus écrit ses nombres en texte, `NaN` et `+Inf` compris : seul un nombre fini compte. */
function nombre(texte: string): number | null {
  const n = Number(texte);
  return Number.isFinite(n) ? n : null;
}

const MS_MESURES = 60_000;
const MS_HISTORIQUE = 10 * 60_000;
/** Un échec ne se garde pas aussi longtemps qu'un succès : l'exploitant qui recharge doit voir Cockpit revenu. */
const MS_ECHEC = 30_000;

export function creerLecteurCockpit(o: {
  url: string;
  jeton: string;
  http: HttpGet;
  /** Par requête de l'instant : l'écran Santé l'attend. */
  delaiMs?: number;
  /** Par requête de trente jours (sous-requête comprise) : plus lourde, l'onglet Capacité n'est pas un chemin chaud. */
  delaiHistoriqueMs?: number;
  maintenant?: () => number;
  /** Une requête refusée ou illisible : le statut, jamais le jeton ni le corps. */
  signaler?: (detail: { signal: string; status: number | null }) => void;
}): LecteurCockpit {
  const base = o.url.replace(/\/+$/, '');
  const delaiMs = o.delaiMs ?? 4_000;
  const delaiHistoriqueMs = o.delaiHistoriqueMs ?? 10_000;
  const maintenant = o.maintenant ?? Date.now;
  const entete = { authorization: `Bearer ${o.jeton}` };

  /** Un appel, sans rien journaliser : c'est l'appelant qui signale l'échec FINAL, une seule fois par signal. */
  async function appeler(chemin: string, delai: number): Promise<{ status: number; json: unknown } | null> {
    try {
      return await o.http.get(`${base}/prometheus/api/v1/${chemin}`, entete, { signal: AbortSignal.timeout(delai) });
    } catch {
      return null;
    }
  }
  const echoue = (r: { status: number } | null): boolean => !r || r.status < 200 || r.status >= 300;

  async function instantane(signal: SignalCockpit): Promise<number | null> {
    const r = await appeler(`query?query=${encodeURIComponent(REQUETES_COCKPIT[signal])}`, delaiMs);
    if (!r || echoue(r)) { o.signaler?.({ signal, status: r?.status ?? null }); return null; }
    const p = vecteur.safeParse(r.json);
    if (!p.success) { o.signaler?.({ signal, status: r.status }); return null; }
    const valeurs = p.data.data.result.map((s) => nombre(s.value[1])).filter((v): v is number => v !== null);
    // Une porte endormie n'a aucune série : zéro copie. Ailleurs, aucune série ne se devine.
    if (valeurs.length === 0) return signal === 'hubspotCopies' ? 0 : null;
    return Math.max(...valeurs);
  }

  async function plage(signal: SignalHistorique, jours: number): Promise<PointCockpit[] | null> {
    const fin = Math.floor(maintenant() / 1000);
    const debut = fin - jours * 86_400;
    // Le pire de chaque heure, par pas de 5 minutes : un pic entre deux points horaires ne disparaît pas.
    const chemin = (q: string) => `query_range?query=${encodeURIComponent(q)}&start=${debut}&end=${fin}&step=3600`;
    let r = await appeler(chemin(`max_over_time((${REQUETES_COCKPIT[signal]})[1h:5m])`), delaiHistoriqueMs);
    // Une sous-requête refusée (400 ou 422 selon le moteur) : la valeur du point horaire, plutôt que rien.
    if (r && (r.status === 400 || r.status === 422)) r = await appeler(chemin(REQUETES_COCKPIT[signal]), delaiHistoriqueMs);
    if (!r || echoue(r)) { o.signaler?.({ signal, status: r?.status ?? null }); return null; }
    const p = matrice.safeParse(r.json);
    if (!p.success) { o.signaler?.({ signal, status: r.status }); return null; }
    const parHeure = new Map<number, number>();
    for (const serie of p.data.data.result) {
      for (const [t, texte] of serie.values) {
        const v = nombre(texte);
        if (v === null) continue;
        parHeure.set(t, Math.max(parHeure.get(t) ?? v, v));
      }
    }
    // Aucun point : une ressource renommée, un jeton sans accès. « Indisponible », pas trente jours à zéro.
    if (parHeure.size === 0) { o.signaler?.({ signal, status: r.status }); return null; }
    return [...parHeure.entries()].sort(([a], [b]) => a - b)
      .map(([t, valeur]) => ({ heure: new Date(t * 1000).toISOString(), valeur: Math.round(valeur * 10) / 10 }));
  }

  let cacheMesures: { a: number; valeur: MesuresCockpit | null } | null = null;
  const cacheHistorique = new Map<number, { a: number; valeur: HistoriqueCockpit | null }>();

  return {
    async mesures() {
      if (cacheMesures && maintenant() - cacheMesures.a < MS_MESURES) return cacheMesures.valeur;
      const signaux = Object.keys(REQUETES_COCKPIT) as SignalCockpit[];
      const valeurs = await Promise.all(signaux.map((s) => instantane(s)));
      const mesures = Object.fromEntries(signaux.map((s, i) => [s, valeurs[i] ?? null])) as MesuresCockpit;
      // La porte HubSpot vaut 0 sans série : seuls les AUTRES signaux disent si Cockpit a répondu.
      const valeur = signaux.some((s) => s !== 'hubspotCopies' && mesures[s] !== null) ? mesures : null;
      // Un échec, même partiel, se garde le temps d'un échec : on reviendra le relire plus tôt.
      const complet = valeur !== null && signaux.every((s) => mesures[s] !== null);
      cacheMesures = { a: maintenant() - (complet ? 0 : MS_MESURES - MS_ECHEC), valeur };
      return valeur;
    },
    async historique(jours) {
      const j = Math.max(1, Math.min(31, Math.floor(jours)));
      const vu = cacheHistorique.get(j);
      if (vu && maintenant() - vu.a < MS_HISTORIQUE) return vu.valeur;
      const series = await Promise.all(SIGNAUX_HISTORIQUE.map((s) => plage(s, j)));
      const historique = Object.fromEntries(SIGNAUX_HISTORIQUE.map((s, i) => [s, series[i] ?? null])) as HistoriqueCockpit;
      const valeur = series.some((x) => x !== null) ? historique : null;
      const complet = series.every((x) => x !== null);
      cacheHistorique.set(j, { a: maintenant() - (complet ? 0 : MS_HISTORIQUE - MS_ECHEC), valeur });
      return valeur;
    },
  };
}
