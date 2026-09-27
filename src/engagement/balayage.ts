import type { Signal } from '../signaux/types';
import { signalRisque } from '../signaux/emetteur';
import { prochaineOuverture } from '../lib/heures-ouvrees';
import { parseInstant, type BusinessHours } from '../workflow/conditions';
import type { ContactAEvaluer, TransitionRisque } from './risque.pg';
import { SEUILS_PAR_DEFAUT, calculerRisque, debutFenetre, passeEnEleve, type Risque, type SeuilsRisque } from './risque';
import { texteDe } from '../lib/erreur';

/**
 * Le balayage du risque de désengagement : une fois par nuit et par espace, et à la demande par `/ops`.
 * IO injectée (aucun import de pg), testable sans base ; règles dans `risque.ts`, base dans `risque.pg.ts`.
 *
 * Pour chaque changement de niveau, et seulement pour lui : les signaux `em_risk_changed` (l'émetteur ne fait
 * rien pour un espace sans outil branché) et, pour un passage en élevé, l'événement d'automation `risque_eleve`,
 * plafonné et différé.
 */

/** Les fiches lues, calculées et écrites ensemble : une lecture et une écriture par lot, jamais par contact. */
export const TAILLE_LOT_RISQUE = 500;

/**
 * 🔴 Au plus 200 déclenchements « risque élevé » par jour et par espace : une nuit peut faire basculer beaucoup
 * de contacts d'un coup, et chaque déclenchement peut lancer un scénario facturé. Au-delà, le niveau est écrit
 * mais rien ne part. Ce plafond s'ajoute au plafond horaire de chaque automation.
 *
 * Il se compte depuis minuit (Paris), pas par exécution, sinon un lancement `/ops` s'ajouterait à la nuit :
 * chaque passage compte d'abord les passages déclenchables déjà écrits aujourd'hui (`declenchablesDepuis`, lu sur
 * `risque_calcule_le`). Ce compte ne peut que restreindre la suite de la journée ; seuls deux passages simultanés
 * sur un même espace peuvent le dépasser.
 * Pas de variable d'environnement : un plafond qui borne une facture ne se dérègle pas par un redéploiement.
 */
export const PLAFOND_DECLENCHEMENTS_PAR_JOUR = 200;

/** Les heures d'ouverture d'un espace, pour savoir quand l'automation « risque élevé » peut partir. */
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
   * Les passages en élevé déclenchables déjà écrits pour cet espace depuis minuit (Paris) : ce qui fait du plafond
   * un plafond par jour. Lu une fois par espace, avant la première écriture.
   */
  declenchablesDepuis(tenantId: string, depuis: Date): Promise<number>;
  /**
   * Une automation « risque élevé » active existe-t-elle ? Lue seulement s'il y a un passage en élevé : sans
   * automation, rien ne part et le plafond ne s'use pas.
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
  /** Pour les tests seulement : le seuil de silence n'est paramétrable que là. */
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
  /** Passages en élevé déclenchables déjà écrits aujourd'hui (Paris) avant ce passage, comptés dans le plafond. */
  dejaDeclenches: number;
  /** Quand les événements publiés par ce passage seront traités (ISO). `null` = rien n'a été publié. */
  departLe: string | null;
  /** Passages en élevé écrits sans déclencher, parce que le plafond du jour était atteint. */
  auDelaDuPlafond: number;
  /** Passages en élevé sans rien à déclencher : aucune automation active, STOP, blocage, ou fiche sans adresse. */
  sansDeclencheur: number;
  /** Publications qui ont échoué (file indisponible) : le niveau est écrit, l'automation n'est pas partie. */
  echecsPublication: number;
  /** Le message d'erreur quand l'espace a échoué en cours de route : ses lots déjà écrits le restent. */
  erreur?: string;
}

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
 * Le repli d'un espace sans heures d'ouverture exploitables : tous les jours de 9 h à 18 h, heure de Paris (le
 * balayage passant entre 3 h et 6 h, c'est 9 h le matin même).
 */
const REPLI_SANS_HORAIRES: BusinessHours = Object.fromEntries(
  ['0', '1', '2', '3', '4', '5', '6'].map((j) => [j, { closed: false, open: '09:00', close: '18:00' }]),
);

/**
 * Quand l'automation « risque élevé » part : jamais pendant le balayage de nuit, le scénario commençant par un
 * message au contact. L'événement est différé à la prochaine ouverture de l'espace (`prochaineOuverture`, qui
 * franchit week-end et changement d'heure) : tout de suite si l'espace est ouvert, sinon sa prochaine ouverture,
 * et à défaut 9 h (Paris).
 * Seul l'événement attend : le niveau est écrit tout de suite. Un contact qui répond entre-temps recevra quand
 * même le scénario, son niveau n'étant recalculé que la nuit suivante.
 */
export function departDuDeclencheur(maintenant: Date, horaires: HorairesEspace | null): Date {
  const ouverture = horaires === null ? null : prochaineOuverture(maintenant, horaires.timeZone, horaires.businessHours);
  return ouverture ?? prochaineOuverture(maintenant, FUSEAU_BALAYAGE, REPLI_SANS_HORAIRES) ?? maintenant;
}

/**
 * Un espace. Lève si la lecture ou l'écriture lève : `balayerRisque` isole les espaces entre eux.
 *
 * Écrire puis déclencher, dans cet ordre : un arrêt entre les deux perd un déclenchement, l'ordre inverse rejoué
 * déclencherait deux fois un scénario facturé. Seul le premier est sans coût pour le client.
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
  // Avant la première écriture : après, ce passage-ci se compterait lui-même.
  bilan.dejaDeclenches = await deps.declenchablesDepuis(tenantId, debutDuJour(maintenant));
  const reste = Math.max(0, plafond - bilan.dejaDeclenches);
  for (let i = 0; i < ids.length; i += TAILLE_LOT_RISQUE) {
    const lot = await deps.faits(tenantId, ids.slice(i, i + TAILLE_LOT_RISQUE), depuis, maintenant);
    const lignes = lot.map((c) => ({ contactId: c.contactId, risque: calculerRisque(c.faits, maintenant, seuils) }));
    const transitions = await deps.ecrire(tenantId, lignes, maintenant);
    bilan.evalues += lignes.length;
    bilan.transitions += transitions.length;
    if (transitions.length === 0) continue;

    // Un signal par changement de niveau. L'émetteur ne lève pas ; la garde protège les automations du lot d'un
    // câblage qui lèverait.
    try {
      await deps.emettreSignaux(tenantId, transitions.map((t) => signalRisque(t, maintenant)));
    } catch (err) {
      deps.log?.(`risque: signaux non émis pour ${tenantId} : ${texteDe(err)}`);
    }

    for (const t of transitions) {
      if (!passeEnEleve(t.ancien, t.nouveau)) continue;
      /**
       * 🔴 Un chemin de masse qui émet, par exception : aucun chemin de masse n'émet d'événement d'automation
       * (5 000 tags ne doivent pas lancer 5 000 scénarios facturés), mais relancer un contact qui décroche est ce
       * que le client demande ici. L'exception tient par ses bornes : seulement sur un passage en élevé, au plus
       * `PLAFOND_DECLENCHEMENTS_PAR_JOUR` par jour et par espace, puis le plafond horaire et l'anti-rebond de 30
       * jours de `runAutomations`, et un départ différé à l'ouverture. Seulement `risque_eleve`.
       * `tests/risque-balayage.test.ts` tient ces bornes, `tests/concurrence-files.test.ts` les points d'enfilement.
       *
       * STOP et blocage ne déclenchent rien, bien qu'ils donnent « élevé » : relancer quelqu'un qui a dit STOP est
       * interdit, et les désabonnés useraient le plafond avant le premier vrai décrocheur.
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
      // Lues une fois par espace. Une lecture en échec vaut « pas d'horaires », donc 9 h (Paris), jamais « tout de
      // suite », qui serait la nuit.
      depart ??= departDuDeclencheur(maintenant, await deps.horairesOuvres(tenantId).catch(() => null));
      try {
        await deps.publierRisqueEleve(tenantId, t.waId, depart);
        bilan.declenches += 1;
        bilan.departLe = depart.toISOString();
      } catch (err) {
        bilan.echecsPublication += 1;
        deps.log?.(`risque: automation « risque élevé » non publiée pour ${tenantId} (${t.contactId}) : ${texteDe(err)}`);
      }
    }
  }
  if (bilan.auDelaDuPlafond > 0) {
    deps.log?.(`risque: plafond de ${plafond} déclenchements par jour atteint pour ${tenantId} (${bilan.dejaDeclenches} avant ce passage), ${bilan.auDelaDuPlafond} passage(s) en élevé écrit(s) sans déclencher`);
  }
  return bilan;
}

/**
 * Tous les espaces, un à un. 🔴 Une panne d'un espace n'arrête pas les autres : elle est rendue dans son bilan et
 * journalisée. Une liste d'espaces illisible lève, et l'appelant la journalise.
 */
export async function balayerRisque(deps: DepsBalayageRisque): Promise<BilanRisque[]> {
  const bilans: BilanRisque[] = [];
  for (const tenantId of await deps.espaces()) {
    try {
      bilans.push(await balayerRisqueEspace(tenantId, deps));
    } catch (err) {
      deps.log?.(`risque: balayage en échec pour ${tenantId} : ${texteDe(err)}`);
      bilans.push({ ...bilanVide(tenantId), erreur: texteDe(err) });
    }
  }
  return bilans;
}

/** L'heure où le balayage de nuit part, en heure de Paris : de 3 h à 6 h, hors de toute activité de campagne. */
export const HEURE_DEBUT_BALAYAGE = 3;
export const HEURE_FIN_BALAYAGE = 6;

/**
 * Le jour (Paris) à balayer maintenant, ou `null` : ce n'est pas l'heure, ou ce jour a déjà été balayé.
 * Le « déjà balayé » vit en mémoire du worker : un redémarrage relance un passage la même nuit, sans effet (aucun
 * changement de niveau, donc ni signal ni automation), pour le prix d'une relecture.
 */
export function jourABalayer(maintenant: Date, dernierJour: string | null): string | null {
  const heure = Number(new Intl.DateTimeFormat('en-GB', { timeZone: FUSEAU_BALAYAGE, hour: '2-digit', hourCycle: 'h23' }).format(maintenant));
  if (heure < HEURE_DEBUT_BALAYAGE || heure >= HEURE_FIN_BALAYAGE) return null;
  const jour = maintenant.toLocaleDateString('en-CA', { timeZone: FUSEAU_BALAYAGE });
  return jour === dernierJour ? null : jour;
}
