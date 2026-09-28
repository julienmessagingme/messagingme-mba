/**
 * Surveillance des tentatives sur `/ops`.
 *
 * `/ops` est gardé par une session d'exploitation nominative (`makeRequireOps`), mais Fastify tourne en
 * `logger: false` : sans ce module, des essais toute la nuit ne laisseraient aucune trace. Un refus compte aussi
 * la session d'une adresse retirée de la liste, ou dont le second facteur a été retiré.
 *
 * Quatre règles :
 *  1. 🔴 le jeton présenté n'est jamais journalisé, ni en clair ni tronqué : une session, même refusée, reste un
 *     secret ;
 *  2. pas d'alerte au premier échec : une session expirée est le cas courant ;
 *  3. rien ici ne peut faire échouer une requête ni ralentir le refus ;
 *  4. 🔴 le compte et le repos sont PARTAGÉS par toutes les copies de l'API (lot B, 2026-09-28) : les refus se comptent
 *     dans le compteur en base, le repos entre deux alertes est un verrou court. Sans cela, un balayage réparti sur
 *     trois copies ne dépasserait le seuil sur aucune, et une attaque soutenue préviendrait une fois PAR COPIE.
 */
import type { CompteurDebit } from '../db/debit';
import type { VerrousCourts } from '../db/verrous-courts';

/** Échecs à atteindre dans la fenêtre avant d'alerter. Une session expirée en produit un ou deux, pas cinq. */
export const SEUIL_ALERTE = 5;
/**
 * Fenêtre de comptage. Assez large pour attraper un balayage lent, assez courte pour ne pas cumuler des mois. Fixe
 * (alignée sur l'heure de la base) et non plus glissante : un paquet d'échecs à cheval sur deux fenêtres peut ne pas
 * alerter, un balayage qui dure, si.
 */
export const FENETRE_MS = 5 * 60_000;
/** Silence entre deux alertes. Une attaque soutenue doit prévenir une fois, pas mille. */
export const REPOS_ALERTE_MS = 30 * 60_000;

/** La clé du compte des refus et celle du repos, dans le compteur et les verrous partagés. */
export const CLE_REFUS_OPS = 'ops.refus';
export const CLE_REPOS_ALERTE_OPS = 'ops.alerte';

export interface SurveillanceOps {
  /**
   * À appeler à chaque refus de `/ops`. La promesse ne rejette jamais et l'appelant ne l'attend pas : elle ne bloque
   * ni ne retarde le refus. Elle se rend quand le refus est compté (ce que les tests attendent).
   */
  refus(info: { chemin: string; ip: string }): Promise<void>;
}

/**
 * Construit la surveillance. `alerter` est injecté : testable sans réseau, et une fonction vide quand Telegram
 * n'est pas configuré. `compteur` et `verrous` sont ceux que partagent les copies de l'API.
 *
 * Base muette : le refus est journalisé quand même (`dansLaFenetre: null`), sans alerte. `/ops` a lui-même besoin de
 * la base pour ouvrir une session, donc une panne de base ne peut pas ouvrir d'accès ; elle ne fait que taire
 * l'alerte, et le journal reste.
 */
export function surveillerOps(deps: {
  alerter: (message: string) => void;
  journaliser?: (message: string) => void;
  compteur: CompteurDebit;
  verrous: Pick<VerrousCourts, 'prendre'>;
}): SurveillanceOps {
  /**
   * 🔴 UN SEUL COMPTAGE EN VOL PAR COPIE. Un refus est anonyme et l'appelant n'attend pas : sans ce regroupement, une
   * rafale sans session ferait une écriture par requête, sans aucune contre-pression, jusqu'à prendre toutes les
   * connexions du pool (console et `/v1` comprises). Les refus arrivés pendant un comptage partent ensemble, en `pas`,
   * dans le suivant : le compte reste exact, le nombre d'écritures est borné par le temps d'un aller-retour.
   */
  let enAttente = 0;
  let derniere: { chemin: string; ip: string } = { chemin: '', ip: '' };
  let enVol: Promise<void> | null = null;
  /** Le repos vu tenu (ou pris) par cette copie : elle ne le redemande pas à la base avant son échéance estimée. */
  let reposLocalJusqua = 0;

  async function vider(): Promise<void> {
    while (enAttente > 0) {
      const pas = enAttente;
      enAttente = 0;
      const info = derniere;
      let dansLaFenetre: number | null = null;
      let maintenant = 0;
      try {
        const v = await deps.compteur.compter([{ cle: CLE_REFUS_OPS, dureeMs: FENETRE_MS, max: null, pas }]);
        dansLaFenetre = v.fenetres[0]?.compte ?? null;
        maintenant = v.maintenantMs;
      } catch {
        // Le journal ci-dessous dit la panne (`dansLaFenetre: null`) ; rien ne remonte à la requête.
      }
      // Journalisé à chaque comptage, même quand l'alerte est étouffée par le repos. Jamais le jeton, seulement le fait.
      deps.journaliser?.(
        JSON.stringify({ lvl: 'warn', msg: 'ops_refus', chemin: info.chemin, ip: info.ip, refus: pas, dansLaFenetre }),
      );
      // Heure de la BASE (celle que rend le compteur), la même pour toutes les copies.
      if (dansLaFenetre === null || dansLaFenetre < SEUIL_ALERTE || maintenant < reposLocalJusqua) continue;
      try {
        // Le repos est un verrou jamais relâché : son échéance EST le silence, et la copie qui le prend est la seule
        // à alerter, quelle que soit celle qui a vu le refus du seuil.
        const prise = await deps.verrous.prendre([[CLE_REPOS_ALERTE_OPS, REPOS_ALERTE_MS]]);
        reposLocalJusqua = maintenant + REPOS_ALERTE_MS;
        if (prise === null) continue;
      } catch {
        continue;
      }
      try {
        deps.alerter(
          `ops : ${dansLaFenetre} tentatives refusées en moins de ${Math.round(FENETRE_MS / 60_000)} min `
          + `(dernière sur ${info.chemin}, ip ${info.ip}). Si ce n'est pas toi, quelqu'un cherche à entrer dans l'exploitation.`,
        );
      } catch {
        // Une alerte qui lève ne doit pas devenir une promesse rejetée que personne n'attend.
      }
    }
  }

  const lancer = (): Promise<void> => vider().finally(() => { enVol = enAttente > 0 ? lancer() : null; });

  return {
    refus(info) {
      enAttente += 1;
      derniere = info;
      enVol ??= lancer();
      return enVol;
    },
  };
}

/**
 * L'adresse du client, à titre indicatif. `req.ip` désigne le proxy (pas de `trustProxy`, Cloudflare puis NPM
 * devant) : on lit l'en-tête de Cloudflare, qu'un appel direct au VPS pourrait forger. Il ne sert qu'au
 * journal, jamais à une décision d'autorisation.
 */
export function ipIndicative(req: { ip: string; headers: Record<string, unknown> }): string {
  const cf = req.headers['cf-connecting-ip'];
  const brut = Array.isArray(cf) ? cf[0] : cf;
  return typeof brut === 'string' && brut.trim() !== '' ? brut.trim() : req.ip;
}
