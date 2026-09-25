import type { Signal } from '../signaux/types';
import { signalRisque } from '../signaux/emetteur';
import { prochaineOuverture } from '../lib/heures-ouvrees';
import { parseInstant, type BusinessHours } from '../workflow/conditions';
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
 *  - pour un PASSAGE EN ÉLEVÉ, l'événement d'automation `risque_eleve`, plafonné et différé (ci-dessous).
 */

/** Les fiches lues, calculées et écrites ensemble : une lecture et une écriture par lot, jamais par contact. */
export const TAILLE_LOT_RISQUE = 500;

/**
 * 🔴 AU PLUS 200 DÉCLENCHEMENTS « RISQUE ÉLEVÉ » PAR JOUR ET PAR ESPACE (décision de Julien, spec § 19).
 *
 * Une nuit peut faire basculer beaucoup de contacts d'un coup (la première nuit, le retour d'une campagne
 * ignorée par toute une base), et chaque déclenchement peut lancer un scénario FACTURÉ. Au-delà, le niveau est
 * ÉCRIT (la fiche, le filtre, l'API et l'outil branché le voient) mais rien ne part, et le bilan le dit. Ce
 * plafond s'ajoute au plafond horaire de chaque automation (`runAutomations`), il ne le remplace pas.
 *
 * 🔴 IL SE COMPTE DEPUIS MINUIT (PARIS), PAS PAR EXÉCUTION (relecture du lot 7, 2026-09-25). Compté par
 * exécution, un lancement `/ops` dans la journée s'AJOUTAIT à la nuit : 200 à 3 h, 200 de plus à 10 h. Chaque
 * passage commence donc par compter ce que la journée a déjà écrit (`declenchablesDepuis`) et ne garde que le
 * reste. La trace lue est le résultat du balayage lui-même, sur la fiche : un niveau `eleve` dont la date
 * (`risque_calcule_le`, qui ne bouge qu'au changement de niveau) est d'aujourd'hui, hors STOP, blocage et fiche
 * sans adresse. Aucune migration.
 *
 * ⚠️ CE COMPTE EST CELUI DES PASSAGES DÉCLENCHABLES, PAS DES PUBLICATIONS RÉUSSIES. Il sur-compte un passage
 * écrit alors qu'aucune automation n'était active, ou dont la publication a échoué : l'erreur ne peut que
 * RESTREINDRE la suite de la journée. Il perd un contact passé en élevé puis ressorti le même jour (sa date a
 * bougé avec son nouveau niveau) : l'anti-rebond de 30 jours l'empêche de repartir, mais sa place dans le
 * plafond se libère pour un autre. Et deux passages SIMULTANÉS sur un même espace (`/ops` pendant la nuit)
 * comptent chacun avant d'écrire : c'est la seule fenêtre où le plafond du jour peut être dépassé.
 *
 * ⚠️ PAS DE VARIABLE D'ENVIRONNEMENT, délibéré : un plafond qui borne une facture ne se dérègle pas par un
 * redéploiement.
 */
export const PLAFOND_DECLENCHEMENTS_PAR_JOUR = 200;

/** Les heures d'ouverture d'un espace, pour savoir QUAND l'automation « risque élevé » peut partir. */
export interface HorairesEspace {
  timeZone: string;
  businessHours: BusinessHours;
}

export interface DepsBalayageRisque {
  /** Les espaces du balayage de nuit. */
  espaces(): Promise<string[]>;
  contactsAEvaluer(tenantId: string, depuis: Date): Promise<string[]>;
  faits(tenantId: string, ids: readonly string[], depuis: Date, maintenant: Date): Promise<ContactAEvaluer[]>;
  ecrire(tenantId: string, lignes: ReadonlyArray<{ contactId: string; risque: Risque }>, calculeLe: Date): Promise<TransitionRisque[]>;
  /**
   * Les passages en élevé DÉCLENCHABLES déjà écrits pour cet espace depuis `depuis` (minuit, Paris) : c'est ce qui
   * fait du plafond un plafond PAR JOUR. Lu une fois par espace, avant la première écriture.
   */
  declenchablesDepuis(tenantId: string, depuis: Date): Promise<number>;
  /**
   * Une automation « risque élevé » ACTIVE existe-t-elle dans cet espace ? Lue une fois par balayage d'espace, et
   * seulement s'il y a un passage en élevé : sans automation, aucun événement ne part, et le plafond ne s'use pas
   * pour rien.
   */
  automationRisqueActive(tenantId: string): Promise<boolean>;
  /**
   * Les heures d'ouverture de l'espace, `null` quand il n'y a rien d'exploitable. Lues une fois par espace, et
   * seulement quand un événement va être publié.
   */
  horairesOuvres(tenantId: string): Promise<HorairesEspace | null>;
  /**
   * Publie l'événement d'automation `risque_eleve` pour ce contact (file `automation-event`), qui ne sera pas
   * traité avant `depart` (`departDuDeclencheur`).
   */
  publierRisqueEleve(tenantId: string, waId: string, depart: Date): Promise<void>;
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
  /** Passages en élevé déclenchables déjà écrits aujourd'hui (Paris) AVANT ce passage : ils comptent dans le plafond. */
  dejaDeclenches: number;
  /** Quand les événements publiés par ce passage seront traités (ISO). `null` = rien n'a été publié. */
  departLe: string | null;
  /** Passages en élevé écrits SANS déclencher, parce que le plafond du jour était atteint. */
  auDelaDuPlafond: number;
  /** Passages en élevé sans rien à déclencher : aucune automation active, STOP, blocage, ou fiche sans adresse. */
  sansDeclencheur: number;
  /** Publications qui ont échoué (file indisponible) : le niveau est écrit, l'automation n'est pas partie. */
  echecsPublication: number;
  /** Le message d'erreur quand l'espace a échoué en cours de route : ses lots déjà écrits le restent. */
  erreur?: string;
}

const texte = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const bilanVide = (tenantId: string): BilanRisque => ({
  tenantId, evalues: 0, transitions: 0, declenches: 0, dejaDeclenches: 0, departLe: null, auDelaDuPlafond: 0,
  sansDeclencheur: 0, echecsPublication: 0,
});

/** L'heure de Paris : celle de la fenêtre du balayage, du plafond du jour, et du départ d'un espace sans horaires. */
const FUSEAU_BALAYAGE = 'Europe/Paris';

/** Minuit (Paris) du jour de `maintenant` : le début du plafond du jour. */
export function debutDuJour(maintenant: Date): Date {
  return parseInstant(`${maintenant.toLocaleDateString('en-CA', { timeZone: FUSEAU_BALAYAGE })}T00:00`, FUSEAU_BALAYAGE);
}

/**
 * Le repli d'un espace SANS heures d'ouverture exploitables (aucun jour ouvert, horaires illisibles, lecture en
 * échec) : tous les jours de 9 h à 18 h, heure de Paris. Le balayage passant entre 3 h et 6 h, c'est 9 h le matin
 * même.
 */
const REPLI_SANS_HORAIRES: BusinessHours = Object.fromEntries(
  ['0', '1', '2', '3', '4', '5', '6'].map((j) => [j, { closed: false, open: '09:00', close: '18:00' }]),
);

/**
 * QUAND L'AUTOMATION « RISQUE ÉLEVÉ » PART (relecture du lot 7, 2026-09-25).
 *
 * 🔴 JAMAIS PENDANT LE BALAYAGE DE NUIT. Le scénario commence par un template, donc par un message au contact :
 * publié tel quel, il partait vers 3 h du matin. L'événement est donc DIFFÉRÉ (départ différé de la file) jusqu'à
 * la prochaine ouverture de l'espace, par la même brique que les campagnes « uniquement pendant les heures
 * ouvrées » (`prochaineOuverture`), qui sait franchir un week-end et un changement d'heure.
 *
 * - espace ouvert maintenant (un lancement `/ops` dans la journée) : tout de suite ;
 * - espace fermé : sa prochaine ouverture ;
 * - aucune ouverture exploitable : 9 h, heure de Paris, le matin même avant 9 h, sinon le lendemain.
 *
 * ⚠️ Seul l'ÉVÉNEMENT attend : le niveau est écrit tout de suite, et la fiche, le filtre, l'API et les signaux le
 * voient dès la nuit. Un contact qui répond entre-temps (un samedi, pour une ouverture le lundi) recevra quand
 * même le scénario : son niveau ne sera recalculé que la nuit suivante.
 */
export function departDuDeclencheur(maintenant: Date, horaires: HorairesEspace | null): Date {
  const ouverture = horaires === null ? null : prochaineOuverture(maintenant, horaires.timeZone, horaires.businessHours);
  return ouverture ?? prochaineOuverture(maintenant, FUSEAU_BALAYAGE, REPLI_SANS_HORAIRES) ?? maintenant;
}

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
  const plafond = deps.plafondDeclenchements ?? PLAFOND_DECLENCHEMENTS_PAR_JOUR;
  const depuis = debutFenetre(maintenant, seuils);
  const bilan = bilanVide(tenantId);
  let automationActive: boolean | null = null;
  let depart: Date | null = null;

  const ids = await deps.contactsAEvaluer(tenantId, depuis);
  if (ids.length === 0) return bilan;
  // AVANT la première écriture : après, ce passage-ci se compterait lui-même.
  bilan.dejaDeclenches = await deps.declenchablesDepuis(tenantId, debutDuJour(maintenant));
  const reste = Math.max(0, plafond - bilan.dejaDeclenches);
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
       * exactement ce que le client lui demande. Il est tenu par ses bornes, qui sont la condition de
       * l'exception :
       *  - il n'émet que sur un PASSAGE en élevé, jamais chaque nuit tant que le contact y reste ;
       *  - au plus `PLAFOND_DECLENCHEMENTS_PAR_JOUR` par jour (Paris) et par espace, `/ops` compris, le reste est
       *    écrit sans déclencher ;
       *  - le plafond horaire de chaque automation s'applique ensuite, dans `runAutomations`, avec l'anti-rebond
       *    de 30 jours par contact propre à ce déclencheur (`antiRebondParDefaut`) ;
       *  - et l'événement ne part pas la nuit : il attend l'ouverture de l'espace (`departDuDeclencheur`).
       * Il n'émet QUE `risque_eleve` : aucun tag, aucun autre type. `tests/risque-balayage.test.ts` tient ces
       * bornes, et `tests/concurrence-files.test.ts` recense les points d'enfilement.
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
      if (bilan.declenches >= reste) {
        bilan.auDelaDuPlafond += 1;
        continue;
      }
      // Lues UNE fois par espace, au premier événement à publier. Une lecture en échec vaut « pas d'horaires »,
      // donc 9 h (Paris), jamais « tout de suite », qui serait la nuit.
      depart ??= departDuDeclencheur(maintenant, await deps.horairesOuvres(tenantId).catch(() => null));
      try {
        await deps.publierRisqueEleve(tenantId, t.waId, depart);
        bilan.declenches += 1;
        bilan.departLe = depart.toISOString();
      } catch (err) {
        bilan.echecsPublication += 1;
        deps.log?.(`risque: automation « risque élevé » non publiée pour ${tenantId} (${t.contactId}) : ${texte(err)}`);
      }
    }
  }
  if (bilan.auDelaDuPlafond > 0) {
    deps.log?.(`risque: plafond de ${plafond} déclenchements par jour atteint pour ${tenantId} (${bilan.dejaDeclenches} avant ce passage), ${bilan.auDelaDuPlafond} passage(s) en élevé écrit(s) sans déclencher`);
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
      bilans.push({ ...bilanVide(tenantId), erreur: texte(err) });
    }
  }
  return bilans;
}

/** L'heure où le balayage de nuit part, en heure de Paris : de 3 h à 6 h, hors de toute activité de campagne. */
export const HEURE_DEBUT_BALAYAGE = 3;
export const HEURE_FIN_BALAYAGE = 6;

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
