import type { VerrousCourts } from '../db/verrous-courts';
import { journaliser } from '../lib/journal';
import type { WorkerHeartbeatRow } from './heartbeat-store.pg';
import type { BilanSante, Brique, CleBrique, EtatBrique } from './sante';
import type { Seuil, SeuilsCapacite } from './seuils';
import type { AlerteCapacite } from './seuils.pg';

/**
 * LES ALERTES DE SANTÉ SUR TELEGRAM (refonte de /ops, lot 4) : quand un signal de capacité change d'état (passe orange,
 * rouge, ou revient au vert), un message qui dit la mesure, les seuils et ce que veut dire le rouge.
 *
 * 🔴 DANS L'API, PAS DANS LA VEILLE DE CHARGE DU WORKER (écart au plan, décidé au lot 4) : le processeur de la base et
 * celui de la machine viennent de Cockpit, dont le jeton n'est que dans le conteneur de l'API. La veille de charge du
 * worker garde ses propres alertes. Une seule copie de l'API juge à chaque passage (un verrou court en base), et le
 * passage revient toutes les cinq minutes : chaque jugement relit la table des jobs de pg-boss, qu'on ne relit pas à la
 * minute pour une mesure de capacité.
 *
 * Une aggravation (vers orange, puis rouge) part aussitôt ; une baisse ou un retour au vert, au plus une fois par signal
 * et par demi-heure depuis la dernière alerte : un signal qui oscille ne réveille pas Julien toutes les cinq minutes.
 * L'état connu de Telegram est la dernière alerte en base (`alertes_capacite`), qui sert aussi
 * d'historique aux incidents de Santé. Un signal illisible ne se juge pas (Cockpit muet n'est pas une panne). Les
 * workers sont exclus : leur silence a déjà son alerte (`surveillance-workers.ts`) ; la porte HubSpot aussi (dormir
 * n'est pas une panne).
 */

export const DELAI_ENTRE_ALERTES_MS = 30 * 60_000;
/** Le passage revient toutes les cinq minutes ; le verrou court un peu moins, pour que le suivant le reprenne. */
export const INTERVALLE_VEILLE_SANTE_MS = 5 * 60_000;
const DUREE_VERROU_MS = INTERVALLE_VEILLE_SANTE_MS - 30_000;
export const CLE_VERROU_VEILLE_SANTE = 'veille-sante';

/**
 * Après le démarrage d'un worker, le retard des files ne s'alerte pas : son p95 lit le dernier quart d'heure, qui contient
 * le redémarrage (les messages arrivés pendant la coupure). Sans cette fenêtre, chaque déploiement des workers enverrait
 * « passe ROUGE » puis « revient au vert ». La surveillance des workers écarte le même bruit pour ses propres alertes.
 */
export const FENETRE_APRES_DEMARRAGE_MS = 15 * 60_000;
const SENSIBLES_AU_DEMARRAGE: ReadonlySet<CleBrique> = new Set<CleBrique>(['entrants', 'accuses']);

/**
 * L'écran juge la part d'erreurs dès 20 requêtes dans l'heure (`EFFECTIF_MIN_API`) ; l'alerte en exige davantage : une
 * seule 500 sur 20 requêtes, la nuit, ferait 5 %, donc un message ROUGE pour un incident isolé.
 */
export const EFFECTIF_MIN_ALERTE_API = 200;

const RANG: Record<EtatBrique, number> = { vert: 0, orange: 1, rouge: 2 };

interface DefinitionSignal {
  nom: string;
  unite: '%' | 's';
  seuil: (s: SeuilsCapacite) => Seuil;
  /** Ce que veut dire le rouge : le geste à faire. */
  rouge: string;
}

export const SIGNAUX_ALERTES: Partial<Record<CleBrique, DefinitionSignal>> = {
  api: { nom: 'Erreurs 5xx de l’API', unite: '%', seuil: (s) => s.erreurs, rouge: 'une route casse, lire les journaux de l’API' },
  'memoire-workers': { nom: 'Mémoire des workers', unite: '%', seuil: (s) => s.memoireWorker, rouge: 'monter la limite du conteneur, ou la machine' },
  machine: { nom: 'Processeur de la machine des workers', unite: '%', seuil: (s) => s.processeurMachine, rouge: 'une machine plus grosse' },
  base: { nom: 'Connexions de la base', unite: '%', seuil: (s) => s.connexions, rouge: 'revoir le budget de connexions, ou une base plus grosse' },
  'processeur-base': { nom: 'Processeur de la base', unite: '%', seuil: (s) => s.processeurBase, rouge: 'passer en DB-DEV-L' },
  entrants: { nom: 'Retard des messages entrants', unite: 's', seuil: (s) => s.entrants, rouge: 'les workers ou la base saturent' },
  accuses: { nom: 'Retard des accusés de Meta', unite: 's', seuil: (s) => s.accuses, rouge: 'la base devient trop lente (DB-DEV-L)' },
};

const ETATS: Record<EtatBrique, string> = { vert: 'VERT', orange: 'ORANGE', rouge: 'ROUGE' };
const valeur = (v: number, unite: '%' | 's'): string => `${Math.round(v * 10) / 10}${unite === '%' ? ' %' : ' s'}`;

/** Le texte d'une alerte. Pur, testé. */
export function texteAlerte(b: Brique, seuils: SeuilsCapacite): string {
  const def = SIGNAUX_ALERTES[b.cle]!;
  const mesure = b.mesure === null ? '' : ` : ${valeur(b.mesure, def.unite)}`;
  if (b.etat === 'vert') return `Santé : ${def.nom} revient au vert${mesure}.`;
  const s = def.seuil(seuils);
  return `Santé : ${def.nom} passe ${ETATS[b.etat]}${mesure} (orange à ${valeur(s.orange, def.unite)}, rouge à `
    + `${valeur(s.rouge, def.unite)}). Au rouge : ${def.rouge}.`;
}

export function creerVeilleSante(deps: {
  /**
   * Le jugement de Santé, avec les seuils réglés : les mêmes lectures que la route `/ops/sante`. Rejette quand les seuils
   * sont illisibles : juger avec les défauts alerterait sur des seuils que personne n'a choisis.
   */
  evaluer: () => Promise<{ bilan: BilanSante; seuils: SeuilsCapacite; workers: WorkerHeartbeatRow[] | null }>;
  alertes: {
    dernieres(): Promise<Map<string, AlerteCapacite>>;
    noter(signal: string, etat: EtatBrique, mesure: number | null): Promise<void>;
  };
  verrous: VerrousCourts;
  /** Rend `false` quand Telegram n'a pas pris le message (non configuré, ou refus) : rien ne se note, on réessaiera. */
  envoyer: (texte: string) => Promise<boolean>;
  maintenant?: () => number;
}): () => Promise<void> {
  const maintenant = deps.maintenant ?? (() => Date.now());

  async function passage(): Promise<void> {
    // Une copie par passage ; le verrou n'est pas relâché, il court jusqu'au passage suivant.
    const prise = await deps.verrous.prendre([[CLE_VERROU_VEILLE_SANTE, DUREE_VERROU_MS]]);
    if (!prise) return;
    const [{ bilan, seuils, workers }, dernieres] = await Promise.all([deps.evaluer(), deps.alertes.dernieres()]);
    const t = maintenant();
    const demarrageRecent = (workers ?? []).some((w) => w.bootedAt !== null && t - Date.parse(w.bootedAt) < FENETRE_APRES_DEMARRAGE_MS);
    for (const b of bilan.briques) {
      if (!SIGNAUX_ALERTES[b.cle] || b.indisponible) continue;
      if (demarrageRecent && SENSIBLES_AU_DEMARRAGE.has(b.cle)) continue;
      if (b.cle === 'api' && b.etat !== 'vert' && (b.effectif ?? 0) < EFFECTIF_MIN_ALERTE_API) continue;
      const avant = dernieres.get(b.cle);
      const connu = avant?.etat ?? 'vert';
      if (b.etat === connu) continue;
      const aggravation = RANG[b.etat] > RANG[connu];
      if (avant && !aggravation && t - Date.parse(avant.envoyeLe) < DELAI_ENTRE_ALERTES_MS) continue;
      if (!(await deps.envoyer(texteAlerte(b, seuils)))) {
        journaliser('warn', 'veille_sante_alerte_non_envoyee', { signal: b.cle, etat: b.etat });
        continue;
      }
      await deps.alertes.noter(b.cle, b.etat, b.mesure);
    }
  }

  // Un passage lent (la base qui rame) ne s'empile pas sur le suivant de la même copie.
  let enCours = false;
  return async function veilleSante(): Promise<void> {
    if (enCours) return;
    enCours = true;
    try {
      await passage();
    } finally {
      enCours = false;
    }
  };
}
