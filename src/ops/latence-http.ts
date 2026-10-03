/**
 * La durée des requêtes HTTP de l'API, par route normalisée et code de retour (audit de performance du 2026-10-02,
 * § 11). Même modèle que l'attente du pool (`src/db/attente-pool.ts`) : un accumulateur par process, vidé en base
 * chaque minute, relu par `/ops`. Une mesure ne doit jamais faire tomber ce qu'elle mesure : rien ici ne lève.
 */

/**
 * Les bornes hautes des tranches, en millisecondes ; une dernière tranche, ouverte, prend tout ce qui dépasse.
 * Elles encadrent les seuils de l'audit (500 et 800 ms pour l'Inbox). 🔴 Les changer rend les lignes déjà en base
 * incohérentes (`db/migrations/0205_http_latences.sql`) : vider la table dans le même déploiement.
 */
export const BORNES_LATENCE_MS = [10, 25, 50, 100, 200, 300, 500, 800, 1200, 2000, 5000, 10000] as const;

/** Le nom unique d'une requête qu'aucune route ne reconnaît : ni cardinalité qui explose, ni adresse en clair. */
export const ROUTE_INCONNUE = '(aucune route)';

/**
 * Au-delà de ce nombre de lignes entre deux vidages, une ligne NEUVE se replie sous `ROUTE_AU_DELA` (méthode et
 * code gardés). Le trafic réel en tient quelques dizaines ; un robot qui balaie toutes les routes avec des corps
 * invalides en produirait des milliers par fenêtre, que la table garderait sept jours.
 */
export const MAX_LIGNES_PAR_VIDAGE = 300;
export const ROUTE_AU_DELA = '(au-delà du plafond)';

/** Le code d'une requête abandonnée par le client avant sa réponse (la convention de nginx). */
export const CODE_ABANDON = 499;

/** Rétention en base : de l'exploitation, pas une preuve. */
export const RETENTION_LATENCES_JOURS = 7;

/** Une ligne de la mesure : une méthode, une route, un code, et ce qu'on a vu passer. */
export interface LigneLatence {
  methode: string;
  route: string;
  code: number;
  /** Une case par tranche de `BORNES_LATENCE_MS`, plus la tranche ouverte. */
  seaux: number[];
  sommeMs: number;
  maxMs: number;
}

const nouveauxSeaux = (): number[] => new Array<number>(BORNES_LATENCE_MS.length + 1).fill(0);

/** La tranche d'une durée : borne haute INCLUSE (100 ms tombe dans « ≤ 100 »). */
export function trancheDe(ms: number): number {
  const i = BORNES_LATENCE_MS.findIndex((borne) => ms <= borne);
  return i === -1 ? BORNES_LATENCE_MS.length : i;
}

/** L'accumulateur. Une instance par copie d'API. */
export class MesureLatenceHttp {
  private lignes = new Map<string, LigneLatence>();

  enregistrer(methode: string, route: string | undefined, code: number, ms: number): void {
    const duree = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const ligne = this.ligneDe(methode, route === undefined || route === '' ? ROUTE_INCONNUE : route, code);
    const i = trancheDe(duree);
    ligne.seaux[i] = (ligne.seaux[i] ?? 0) + 1;
    ligne.sommeMs += duree;
    if (duree > ligne.maxMs) ligne.maxMs = duree;
  }

  /** La ligne d'une clé, créée au besoin, repliée sous `ROUTE_AU_DELA` au-delà du plafond. */
  private ligneDe(methode: string, route: string, code: number): LigneLatence {
    const existante = this.lignes.get(`${methode} ${code} ${route}`);
    if (existante) return existante;
    const motif = this.lignes.size >= MAX_LIGNES_PAR_VIDAGE ? ROUTE_AU_DELA : route;
    const cle = `${methode} ${code} ${motif}`;
    let ligne = this.lignes.get(cle);
    if (!ligne) {
      ligne = { methode, route: motif, code, seaux: nouveauxSeaux(), sommeMs: 0, maxMs: 0 };
      this.lignes.set(cle, ligne);
    }
    return ligne;
  }

  /** Rend ce qui s'est accumulé et repart à vide (boucle à un seul fil : rien ne se perd entre les deux). */
  vider(): LigneLatence[] {
    const lignes = [...this.lignes.values()];
    this.lignes = new Map();
    return lignes;
  }

  /** Remet des lignes qu'on n'a pas pu écrire, fusionnées avec ce qui s'est accumulé entre-temps. */
  reinjecter(lignes: LigneLatence[]): void {
    for (const l of lignes) {
      const courante = this.ligneDe(l.methode, l.route, l.code);
      l.seaux.forEach((n, i) => { courante.seaux[i] = (courante.seaux[i] ?? 0) + n; });
      courante.sommeMs += l.sommeMs;
      if (l.maxMs > courante.maxMs) courante.maxMs = l.maxMs;
    }
  }
}

/**
 * Le centile `q` (0 < q ≤ 1) tiré des tranches : la borne haute de la tranche où tombe la requête de rang
 * `ceil(q × n)`, plafonnée par le maximum mesuré (la tranche ouverte n'a pas d'autre borne). C'est un majorant
 * honnête : « p95 ≤ 500 ms », jamais une précision inventée par interpolation. `null` sans aucune requête.
 */
export function centile(seaux: readonly number[], q: number, maxMs: number): number | null {
  const n = seaux.reduce((s, x) => s + x, 0);
  if (n === 0) return null;
  const rang = Math.max(1, Math.ceil(q * n));
  let cumul = 0;
  for (let i = 0; i < seaux.length; i += 1) {
    cumul += seaux[i] ?? 0;
    if (cumul >= rang) {
      const borne = i < BORNES_LATENCE_MS.length ? BORNES_LATENCE_MS[i]! : Infinity;
      return Math.min(borne, Math.round(maxMs));
    }
  }
  return Math.round(maxMs);
}

/** Les groupes que l'audit met en tête, puis le reste. */
export type GroupeRoute = 'webhooks' | 'inbox' | 'v1' | 'autres';

/**
 * Les webhooks ENTRANTS, tous : Meta et Stripe, les webhooks des clients (`/w/`), le rapport RCS et HubSpot. Un tiers
 * attend notre accusé, et l'abandonne s'il traîne.
 */
const PREFIXES_WEBHOOKS = ['/webhooks/', '/w/', '/rcs/callback/', '/hubspot/deal-stage'];

export function groupeDeRoute(route: string): GroupeRoute {
  if (PREFIXES_WEBHOOKS.some((p) => route.startsWith(p))) return 'webhooks';
  if (route.startsWith('/tenants/:tenantId/conversations')) return 'inbox';
  if (route.startsWith('/v1/')) return 'v1';
  return 'autres';
}

/** Une ligne telle que `/ops` la rend : agrégée sur la fenêtre, toutes copies confondues. */
export interface LatenceHttpRow {
  methode: string;
  route: string;
  code: number;
  groupe: GroupeRoute;
  requetes: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number;
  moyenneMs: number;
}

/** De la ligne agrégée en base à la ligne de l'écran. */
export function versLigneOps(l: LigneLatence): LatenceHttpRow {
  const requetes = l.seaux.reduce((s, x) => s + x, 0);
  return {
    methode: l.methode,
    route: l.route,
    code: l.code,
    groupe: groupeDeRoute(l.route),
    requetes,
    p50Ms: centile(l.seaux, 0.5, l.maxMs),
    p95Ms: centile(l.seaux, 0.95, l.maxMs),
    maxMs: Math.round(l.maxMs),
    moyenneMs: requetes === 0 ? 0 : Math.round(l.sommeMs / requetes),
  };
}
