import type { Signal } from '../signaux/types';
import { signalRisque } from '../signaux/emetteur';
import type { ContactAEvaluer, TransitionRisque } from './risque.pg';
import { SEUILS_PAR_DEFAUT, calculerRisque, debutFenetre, passeEnEleve, type Risque, type SeuilsRisque } from './risque';

/**
 * LE BALAYAGE DU RISQUE DE DÉSENGAGEMENT (spec § 19, tâche 4 du plan du lot 7) : une fois par nuit et par
 * espace, et à la demande par `/ops` pour un espace.
 *
 * IO INJECTÉE (aucun import de pg) : testable sans base, comme `runDateSweep`. Les règles vivent dans
 * `risque.ts` (pur), la lecture et l'écriture dans `risque.pg.ts`.
 *
 * Pour chaque changement de NIVEAU (et seulement pour lui) :
 *  - les SIGNAUX (`em_risk_changed`, qui porte les attributs `em_risk_level`, `em_risk_score`,
 *    `em_risk_reasons`), par l'émetteur existant, qui ne fait rien pour un espace sans outil branché ;
 *  - pour un PASSAGE EN ÉLEVÉ, l'événement d'automation `risque_eleve`, plafonné (ci-dessous).
 */

/** Les fiches lues, calculées et écrites ensemble : une lecture et une écriture par lot, jamais par contact. */
export const TAILLE_LOT_RISQUE = 500;

/**
 * 🔴 AU PLUS 200 DÉCLENCHEMENTS « RISQUE ÉLEVÉ » PAR NUIT ET PAR ESPACE (décision de Julien, spec § 19).
 *
 * Une nuit peut faire basculer beaucoup de contacts d'un coup (la première nuit, le retour d'une campagne
 * ignorée par toute une base), et chaque déclenchement peut lancer un scénario FACTURÉ. Au-delà, le niveau est
 * ÉCRIT (la fiche, le filtre, l'API et l'outil branché le voient) mais rien ne part, et le bilan le dit. Ce
 * plafond s'ajoute au plafond horaire de chaque automation (`runAutomations`), il ne le remplace pas.
 *
 * ⚠️ PAS DE VARIABLE D'ENVIRONNEMENT, délibéré : un plafond qui borne une facture ne se dérègle pas par un
 * redéploiement.
 */
export const PLAFOND_DECLENCHEMENTS_PAR_NUIT = 200;

export interface DepsBalayageRisque {
  /** Les espaces du balayage de nuit. */
  espaces(): Promise<string[]>;
  contactsAEvaluer(tenantId: string, depuis: Date): Promise<string[]>;
  faits(tenantId: string, ids: readonly string[], depuis: Date, maintenant: Date): Promise<ContactAEvaluer[]>;
  ecrire(tenantId: string, lignes: ReadonlyArray<{ contactId: string; risque: Risque }>, calculeLe: Date): Promise<TransitionRisque[]>;
  /**
   * Une automation « risque élevé » ACTIVE existe-t-elle dans cet espace ? Lue une fois par balayage d'espace, et
   * seulement s'il y a un passage en élevé : sans automation, aucun événement ne part, et le plafond ne s'use pas
   * pour rien.
   */
  automationRisqueActive(tenantId: string): Promise<boolean>;
  /** Publie l'événement d'automation `risque_eleve` pour ce contact (file `automation-event`). */
  publierRisqueEleve(tenantId: string, waId: string): Promise<void>;
  /** L'émetteur des signaux. Il ne lève jamais, et ne fait rien pour un espace sans outil branché. */
  emettreSignaux(tenantId: string, signaux: readonly Signal[]): Promise<void>;
  maintenant?: () => Date;
  /** POUR LES TESTS SEULEMENT (spec § 19 : « le seuil de silence est paramétrable dans les tests seulement »). */
  seuils?: SeuilsRisque;
  plafondDeclenchements?: number;
  log?: (message: string) => void;
}

export interface BilanRisque {
  tenantId: string;
  evalues: number;
  transitions: number;
  /** Passages en élevé qui ont publié l'événement d'automation. */
  declenches: number;
  /** Passages en élevé écrits SANS déclencher, parce que le plafond de la nuit était atteint. */
  auDelaDuPlafond: number;
  /** Passages en élevé sans rien à déclencher : aucune automation active, STOP, blocage, ou fiche sans adresse. */
  sansDeclencheur: number;
  /** Publications qui ont échoué (file indisponible) : le niveau est écrit, l'automation n'est pas partie. */
  echecsPublication: number;
  /** Le message d'erreur quand l'espace a échoué en cours de route : ses lots déjà écrits le restent. */
  erreur?: string;
}

const texte = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Un espace. Lève si la lecture ou l'écriture lève : c'est `balayerRisque` qui isole les espaces entre eux.
 *
 * ⚠️ ÉCRIRE PUIS DÉCLENCHER, dans cet ordre, et c'est choisi. Un arrêt entre les deux perd le déclenchement de
 * ce lot (la nuit suivante ne voit plus de passage) ; l'ordre inverse, rejoué, déclencherait DEUX fois un
 * scénario facturé. Entre un scénario manqué et un scénario doublé, seul le premier est sans coût pour le client.
 */
export async function balayerRisqueEspace(tenantId: string, deps: DepsBalayageRisque): Promise<BilanRisque> {
  const maintenant = deps.maintenant?.() ?? new Date();
  const seuils = deps.seuils ?? SEUILS_PAR_DEFAUT;
  const plafond = deps.plafondDeclenchements ?? PLAFOND_DECLENCHEMENTS_PAR_NUIT;
  const depuis = debutFenetre(maintenant, seuils);
  const bilan: BilanRisque = {
    tenantId, evalues: 0, transitions: 0, declenches: 0, auDelaDuPlafond: 0, sansDeclencheur: 0, echecsPublication: 0,
  };
  let automationActive: boolean | null = null;

  const ids = await deps.contactsAEvaluer(tenantId, depuis);
  for (let i = 0; i < ids.length; i += TAILLE_LOT_RISQUE) {
    const lot = await deps.faits(tenantId, ids.slice(i, i + TAILLE_LOT_RISQUE), depuis, maintenant);
    const lignes = lot.map((c) => ({ contactId: c.contactId, risque: calculerRisque(c.faits, maintenant, seuils) }));
    const transitions = await deps.ecrire(tenantId, lignes, maintenant);
    bilan.evalues += lignes.length;
    bilan.transitions += transitions.length;
    if (transitions.length === 0) continue;

    // Les signaux : un par CHANGEMENT de niveau, jamais pour un contact qui reste où il était. L'émetteur ne lève
    // pas ; la garde est là pour qu'un câblage qui lèverait ne prive pas le lot de ses automations.
    try {
      await deps.emettreSignaux(tenantId, transitions.map((t) => signalRisque(t, maintenant)));
    } catch (err) {
      deps.log?.(`risque: signaux non émis pour ${tenantId} : ${texte(err)}`);
    }

    for (const t of transitions) {
      if (!passeEnEleve(t.ancien, t.nouveau)) continue;
      /**
       * 🔴 UN CHEMIN DE MASSE QUI ÉMET, ET C'EST UNE EXCEPTION DÉCIDÉE (Julien, spec § 19, 2026-09-25).
       *
       * La règle du dépôt est qu'AUCUN chemin de masse n'émet d'événement d'automation (action en masse, import,
       * API publique, campagne) : poser un tag sur 5 000 fiches ne doit pas lancer 5 000 scénarios facturés. Ce
       * balayage en est un, et il émet quand même, parce que « relancer un contact qui décroche » est
       * exactement ce que le client lui demande. Il est tenu par TROIS bornes, qui sont la condition de
       * l'exception :
       *  - il n'émet que sur un PASSAGE en élevé, jamais chaque nuit tant que le contact y reste ;
       *  - au plus `PLAFOND_DECLENCHEMENTS_PAR_NUIT` par nuit et par espace, le reste est écrit sans déclencher ;
       *  - le plafond horaire de chaque automation s'applique ensuite, dans `runAutomations`.
       * Il n'émet QUE `risque_eleve` : aucun tag, aucun autre type. `tests/risque-balayage.test.ts` tient les
       * trois bornes, et `tests/concurrence-files.test.ts` recense les points d'enfilement.
       *
       * ⚠️ STOP ET BLOCAGE NE DÉCLENCHENT RIEN, bien qu'ils donnent « élevé » : un scénario de relance vers
       * quelqu'un qui a dit STOP est ce que tout le reste du produit interdit (et la garde d'envoi le
       * refuserait), et la première nuit ferait passer en élevé TOUS les désabonnés d'un espace, qui useraient
       * le plafond avant le premier vrai décrocheur.
       */
      if (t.raisons.includes('stop') || t.raisons.includes('bloque') || t.waId === null) {
        bilan.sansDeclencheur += 1;
        continue;
      }
      automationActive ??= await deps.automationRisqueActive(tenantId);
      if (!automationActive) {
        bilan.sansDeclencheur += 1;
        continue;
      }
      if (bilan.declenches >= plafond) {
        bilan.auDelaDuPlafond += 1;
        continue;
      }
      try {
        await deps.publierRisqueEleve(tenantId, t.waId);
        bilan.declenches += 1;
      } catch (err) {
        bilan.echecsPublication += 1;
        deps.log?.(`risque: automation « risque élevé » non publiée pour ${tenantId} (${t.contactId}) : ${texte(err)}`);
      }
    }
  }
  if (bilan.auDelaDuPlafond > 0) {
    deps.log?.(`risque: plafond de ${plafond} déclenchements atteint pour ${tenantId}, ${bilan.auDelaDuPlafond} passage(s) en élevé écrit(s) sans déclencher`);
  }
  return bilan;
}

/**
 * Tous les espaces, UN À UN. 🔴 UNE PANNE D'UN ESPACE N'ARRÊTE PAS LES AUTRES : elle est rendue dans son bilan et
 * journalisée, et le balayage passe au suivant. Une liste d'espaces illisible, elle, lève : il n'y a rien à
 * balayer, et c'est l'appelant qui le journalise.
 */
export async function balayerRisque(deps: DepsBalayageRisque): Promise<BilanRisque[]> {
  const bilans: BilanRisque[] = [];
  for (const tenantId of await deps.espaces()) {
    try {
      bilans.push(await balayerRisqueEspace(tenantId, deps));
    } catch (err) {
      deps.log?.(`risque: balayage en échec pour ${tenantId} : ${texte(err)}`);
      bilans.push({
        tenantId, evalues: 0, transitions: 0, declenches: 0, auDelaDuPlafond: 0, sansDeclencheur: 0, echecsPublication: 0,
        erreur: texte(err),
      });
    }
  }
  return bilans;
}

/** L'heure où le balayage de nuit part, en heure de Paris : de 3 h à 6 h, hors de toute activité de campagne. */
export const HEURE_DEBUT_BALAYAGE = 3;
export const HEURE_FIN_BALAYAGE = 6;
const FUSEAU_BALAYAGE = 'Europe/Paris';

/**
 * Le JOUR (Paris) à balayer maintenant, ou `null` : ce n'est pas l'heure, ou ce jour a déjà été balayé.
 *
 * ⚠️ LE « DÉJÀ BALAYÉ » VIT EN MÉMOIRE DU WORKER, délibérément. Un redémarrage pendant la fenêtre relance un
 * passage la même nuit, et c'est sans effet : un second passage ne voit aucun changement de niveau (tout est
 * déjà écrit), donc n'émet ni signal ni automation. Il ne coûte qu'une relecture, là où une date en base
 * coûterait une migration de plus.
 */
export function jourABalayer(maintenant: Date, dernierJour: string | null): string | null {
  const heure = Number(new Intl.DateTimeFormat('en-GB', { timeZone: FUSEAU_BALAYAGE, hour: '2-digit', hourCycle: 'h23' }).format(maintenant));
  if (heure < HEURE_DEBUT_BALAYAGE || heure >= HEURE_FIN_BALAYAGE) return null;
  const jour = maintenant.toLocaleDateString('en-CA', { timeZone: FUSEAU_BALAYAGE });
  return jour === dernierJour ? null : jour;
}
