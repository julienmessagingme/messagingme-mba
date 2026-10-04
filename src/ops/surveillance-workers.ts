import type { VerrousCourts } from '../db/verrous-courts';
import type { WorkerHeartbeatRow } from './heartbeat-store.pg';

/**
 * L'ALERTE QUAND UN WORKER SE TAIT OU REDÉMARRE EN BOUCLE (audit de performance du 2026-10-02, § 7 et § 14 :
 * « chaque rôle a son heartbeat et son alerte »).
 *
 * Le battement de chaque rôle était lisible dans `/ops`, mais personne n'était prévenu. La sonde système du VPS
 * (`vps-watch`) ne voit qu'un conteneur ARRÊTÉ, toutes les quinze minutes, et elle n'existera pas chez Scaleway. La
 * surveillance vit donc dans l'API, le seul processus qui ne dépend pas des workers, et part avec elle.
 *
 * Deux pannes, deux signes :
 * - **le silence** : plus aucun battement depuis `SEUIL_SILENCE_WORKER_S` (worker figé, arrêté, ou qui plante avant
 *   son premier battement) ;
 * - **la boucle** : le battement reste frais, parce que chaque redémarrage le réécrit, mais l'heure de démarrage
 *   change sans cesse (`SEUIL_BOUCLE_DEMARRAGES` démarrages en `FENETRE_BOUCLE_MS`). Sans ce second signe, un worker
 *   qui plante après son premier battement passerait pour vivant.
 *
 * 🔴 UNE ALERTE PAR ÉPISODE POUR TOUT LE SERVICE, pas une par copie de l'API : la prise d'un verrou court décide qui
 * envoie. La clé du silence porte l'ÉPISODE (le dernier battement avant le silence), tenue une heure, ce qui fait le
 * rappel : un second silence est un autre épisode, donc une autre clé, et il est annoncé aussitôt, même par une copie
 * de l'API qui vient de redémarrer et n'a rien en mémoire.
 */

/**
 * Au-delà, un rôle est déclaré silencieux. ⚠️ Plus large que le rouge de l'écran (90 s, `WORKER_STALE_S`) : un
 * déploiement redémarre un worker en moins d'une minute, et une alerte à chaque mise en production apprendrait à
 * ne plus les lire. Le battement part toutes les 20 s (`HEARTBEAT_INTERVAL_MS`) : trois minutes, c'est neuf
 * battements manqués d'affilée.
 */
export const SEUIL_SILENCE_WORKER_S = 180;

/** Le rappel tant que le silence dure, et la durée du verrou d'alerte. */
export const RAPPEL_SILENCE_WORKER_MS = 60 * 60_000;

/**
 * Autant de démarrages distincts dans la fenêtre font une boucle. ⚠️ Au-dessus de ce que font des déploiements
 * rapprochés (un correctif puis ses jaunes, trois redémarrages au plus en un quart d'heure) ; une vraie boucle,
 * relancée par Docker, en fait un par minute ou davantage.
 */
export const SEUIL_BOUCLE_DEMARRAGES = 5;
export const FENETRE_BOUCLE_MS = 15 * 60_000;

/** Combien de temps un retour reste annoncé, pour qu'aucune autre copie ne le répète. */
const RETOUR_ANNONCE_MS = 24 * 60 * 60_000;

/** Ce qui s'arrête quand ce rôle se tait : l'alerte doit dire la conséquence, pas seulement le nom du conteneur. */
const CONSEQUENCE: Record<string, string> = {
  principal: 'les messages entrants, les campagnes, les scénarios et les tours d’agent ne sont plus traités',
  analyse: 'les analyses de conversations et leur poussée vers HubSpot attendent',
  all: 'plus rien n’est traité : messages, campagnes, scénarios, analyses',
};

export interface DepsSurveillanceWorkers {
  lister(): Promise<WorkerHeartbeatRow[]>;
  verrous: VerrousCourts;
  /** Envoie le texte (Telegram). `false` = pas parti : la prise est relâchée et la minute suivante réessaie. */
  envoyer(texte: string): Promise<boolean>;
  /** L'horloge, pour la fenêtre des démarrages. `Date.now` par défaut. */
  maintenant?: () => number;
}

const minutes = (secondes: number): number => Math.max(1, Math.round(secondes / 60));
const heureUtc = (iso: string): string => `${iso.slice(11, 16)} UTC`;

/**
 * Une passe par minute, appelée par la minuterie de l'API. Une erreur de verrou ou d'envoi sur un rôle n'empêche pas
 * de regarder l'autre ; seule la lecture des battements lève vers l'appelant.
 */
export function creerSurveillanceWorkers(deps: DepsSurveillanceWorkers): () => Promise<void> {
  const maintenant = deps.maintenant ?? Date.now;
  /** Les silences que CETTE copie a annoncés (le dernier battement avant le silence), pour en annoncer le retour. */
  const annonces = new Map<string, { episode: string; depuisS: number }>();
  /** Par rôle, les heures de démarrage vues, avec l'instant où on les a vues pour la première fois. */
  const demarrages = new Map<string, Map<string, number>>();

  return async function surveiller(): Promise<void> {
    const lignes = await deps.lister();
    const vus = new Set<string>();
    for (const w of lignes) {
      vus.add(w.role);
      try {
        if (w.ageSeconds > SEUIL_SILENCE_WORKER_S) {
          await signalerSilence(w);
        } else {
          await signalerRetour(w);
          await surveillerBoucle(w);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`surveillance-workers: rôle ${w.role} :`, err instanceof Error ? err.message : String(err));
      }
    }
    // Une ligne effacée (rôles réorganisés) n'a plus rien à suivre.
    for (const role of [...annonces.keys()]) if (!vus.has(role)) annonces.delete(role);
    for (const role of [...demarrages.keys()]) if (!vus.has(role)) demarrages.delete(role);
  };

  /** Prend la clé, envoie, relâche si l'envoi n'est pas parti. `true` = le message est parti. */
  async function annoncer(cle: string, dureeMs: number, texte: string, journal: 'error' | 'warn'): Promise<boolean> {
    const prise = await deps.verrous.prendre([[cle, dureeMs]]);
    if (!prise) return false; // déjà annoncé, par cette copie ou une autre
    // eslint-disable-next-line no-console
    console[journal](`surveillance-workers: ${texte}`);
    if (await deps.envoyer(texte)) return true;
    await deps.verrous.relacher(prise);
    return false;
  }

  async function signalerSilence(w: WorkerHeartbeatRow): Promise<void> {
    const texte = `🔴 worker « ${w.role} » silencieux depuis ${minutes(w.ageSeconds)} min (dernier battement ${heureUtc(w.beatAt)}) : `
      + `${CONSEQUENCE[w.role] ?? 'son travail n’est plus fait'}.`;
    if (await annoncer(`alerte-worker:${w.role}:${w.beatAt}`, RAPPEL_SILENCE_WORKER_MS, texte, 'error')) {
      annonces.set(w.role, { episode: w.beatAt, depuisS: w.ageSeconds });
    }
  }

  async function signalerRetour(w: WorkerHeartbeatRow): Promise<void> {
    const annonce = annonces.get(w.role);
    if (!annonce) return;
    // L'heure de démarrage ne se dit que si le worker a vraiment redémarré pendant l'épisode : un worker figé puis
    // reparti sans redémarrer garde une heure de démarrage ancienne, qui tromperait.
    const redemarre = w.bootedAt !== null && w.bootedAt > annonce.episode;
    const texte = `✅ worker « ${w.role} » reparti (silencieux au moins ${minutes(annonce.depuisS)} min, `
      + `${redemarre ? `redémarré ${heureUtc(w.bootedAt!)}` : 'sans redémarrage'}).`;
    const prise = await deps.verrous.prendre([[`retour-worker:${w.role}:${annonce.episode}`, RETOUR_ANNONCE_MS]]);
    if (prise) {
      // eslint-disable-next-line no-console
      console.warn(`surveillance-workers: ${texte}`);
      if (!(await deps.envoyer(texte))) {
        await deps.verrous.relacher(prise);
        return; // la minute suivante réessaie
      }
    }
    annonces.delete(w.role);
  }

  async function surveillerBoucle(w: WorkerHeartbeatRow): Promise<void> {
    if (w.bootedAt === null) return;
    const t = maintenant();
    const vusDuRole = demarrages.get(w.role) ?? new Map<string, number>();
    if (!vusDuRole.has(w.bootedAt)) vusDuRole.set(w.bootedAt, t);
    for (const [boot, vuA] of vusDuRole) if (t - vuA > FENETRE_BOUCLE_MS) vusDuRole.delete(boot);
    demarrages.set(w.role, vusDuRole);
    if (vusDuRole.size < SEUIL_BOUCLE_DEMARRAGES) return;
    const texte = `🔴 worker « ${w.role} » redémarre en boucle : ${vusDuRole.size} démarrages en ${FENETRE_BOUCLE_MS / 60_000} min `
      + `(dernier ${heureUtc(w.bootedAt)}). Il bat entre deux plantages, mais ${CONSEQUENCE[w.role] ?? 'son travail n’est plus fait'} normalement.`;
    await annoncer(`boucle-worker:${w.role}`, RAPPEL_SILENCE_WORKER_MS, texte, 'error');
  }
}
