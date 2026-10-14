import { journaliser } from '../lib/journal';
import { addDays } from '../stats/range';
import type { EmetteurEmails } from './emission';

/**
 * LES E-MAILS D'ACCOMPAGNEMENT (lot 7, livraison C ; décisions de Julien du 2026-10-14) : la bienvenue, les trois
 * relances de qui décroche en route, et le récapitulatif de la semaine pour l'offre Free. Tous de la catégorie
 * `commercial` : ils portent le lien de désinscription, et la personne qui s'est désinscrite ne les reçoit pas (la file
 * le relit à l'envoi).
 *
 * Un seul balayage les décide, et chacun a son occasion en base (le journal des envois) : une fois chacun par espace,
 * une fois par semaine pour le récapitulatif. 🔴 Chaque relance ne vaut que `VALIDITE_JOURS` après son déclencheur :
 * « votre numéro est connecté depuis 24 heures » n'a plus de sens trois semaines après. Mesuré avant le déploiement
 * (2026-10-14) : sans cette borne, cinq espaces en service depuis 2 à 22 jours recevaient la relance du répondeur le
 * jour même. Le balayage ne lit de toute façon que les espaces créés depuis moins de `FENETRE_JOURS`.
 */

type Emettre = EmetteurEmails['emettre'];

/** La bienvenue part dans les deux jours qui suivent la création ; au-delà, elle n'a plus de sens. */
export const BIENVENUE_HEURES = 48;
/** Le balayage ne lit que les espaces créés depuis moins de 30 jours. */
export const FENETRE_JOURS = 30;
/** Une relance qui n'est pas partie dans les sept jours qui suivent son déclencheur ne part plus. */
export const VALIDITE_JOURS = 7;
const HEURE = 3_600_000;
const JOUR = 24 * HEURE;

export interface EspaceAccompagne {
  tenantId: string;
  creeLe: Date;
  /** Le premier numéro WhatsApp connecté de l'espace, `null` s'il n'en a pas. */
  numeroDepuis: Date | null;
}

export interface DepsAccompagnement {
  /** Les espaces créés depuis moins de `FENETRE_JOURS` jours. */
  espacesRecents(): Promise<EspaceAccompagne[]>;
  /** Le répondeur effectif de l'espace (`modeEffectif`) : `equipe` = aucun robot ne répond. */
  modeRepondeur(tenantId: string): Promise<string>;
  /** L'espace a-t-il déjà reçu ou envoyé un message ? */
  aDesMessages(tenantId: string): Promise<boolean>;
  emettre: Emettre;
  pages: { console: string; numero: string; agents: string; widgets: string; offre: string };
  now?: () => Date;
}

/** Un tour du balayage de la bienvenue et des relances. Rend le nombre d'émissions tentées. */
export async function balayerAccompagnement(d: DepsAccompagnement): Promise<number> {
  const maintenant = (d.now ? d.now() : new Date()).getTime();
  /** La durée a-t-elle atteint le déclencheur, sans l'avoir dépassé de plus de `VALIDITE_JOURS` ? */
  const due = (duree: number, declencheur: number) => duree >= declencheur && duree < declencheur + VALIDITE_JOURS * JOUR;
  let n = 0;
  for (const e of await d.espacesRecents()) {
    try {
      const age = maintenant - e.creeLe.getTime();
      if (age < BIENVENUE_HEURES * HEURE) {
        await d.emettre({ cle: 'bienvenue', tenantId: e.tenantId, occasion: 'bienvenue', a: 'admins', valeurs: { lien_console: d.pages.console } });
        n += 1;
      }
      if (e.numeroDepuis === null) {
        if (due(age, JOUR)) {
          await d.emettre({ cle: 'relance_numero', tenantId: e.tenantId, occasion: 'relance_numero', a: 'admins', valeurs: { lien_numero: d.pages.numero } });
          n += 1;
        }
        continue;
      }
      const enService = maintenant - e.numeroDepuis.getTime();
      if (due(enService, JOUR) && (await d.modeRepondeur(e.tenantId)) === 'equipe') {
        await d.emettre({ cle: 'relance_repondeur', tenantId: e.tenantId, occasion: 'relance_repondeur', a: 'admins', valeurs: { lien_agents: d.pages.agents } });
        n += 1;
      }
      if (due(enService, 7 * JOUR) && !(await d.aDesMessages(e.tenantId))) {
        await d.emettre({ cle: 'relance_silence', tenantId: e.tenantId, occasion: 'relance_silence', a: 'admins', valeurs: { lien_widgets: d.pages.widgets } });
        n += 1;
      }
    } catch (err) {
      journaliser('error', 'accompagnement_impossible', { err, tenantId: e.tenantId });
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Le récapitulatif de la semaine
// ---------------------------------------------------------------------------------------------------------------

export interface RecapSemaine {
  messagesRecus: number;
  messagesEnvoyes: number;
  conversations: number;
  demandes: number;
  creditMicroEur: number;
}

export interface DepsRecap {
  espaces(): Promise<string[]>;
  /** L'espace est-il en Free (une offre avec des limites) ? Le récapitulatif ne va qu'à lui (décision du 2026-10-14). */
  estFree(tenantId: string): Promise<boolean>;
  /** L'occasion de la semaine est-elle déjà réservée ? Lue AVANT de compter : le balayage repasse toutes les 30 minutes. */
  dejaEnvoye(tenantId: string, occasion: string): Promise<boolean>;
  /** La semaine `[du, au]` (jours de Paris, bornes comprises). */
  recap(tenantId: string, du: string, au: string): Promise<RecapSemaine>;
  emettre: Emettre;
  pageOffre: string;
  now?: () => Date;
}

/** Le jour (`AAAA-MM-JJ`), le jour de la semaine (0 = dimanche) et l'heure de Paris d'un instant. */
export function heureDeParis(instant: Date): { jour: string; jourSemaine: number; heure: number } {
  const jour = instant.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  const heure = Number(instant.toLocaleString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }));
  const jourSemaine = new Date(`${jour}T12:00:00Z`).getUTCDay();
  return { jour, jourSemaine, heure: heure === 24 ? 0 : heure };
}

/**
 * La semaine écoulée à envoyer : le lundi à partir de 9 h (Paris), et le mardi pour rattraper un balayage manqué, la
 * semaine du lundi au dimanche qui précède ; le journal ne l'envoie qu'une fois. Les autres jours, `null` : un
 * récapitulatif qui arriverait le jeudi ne récapitule plus rien (et le premier déploiement, un mercredi, n'envoie pas
 * celui de la semaine d'avant).
 */
export function semaineARecapituler(instant: Date): { du: string; au: string } | null {
  const { jour, jourSemaine, heure } = heureDeParis(instant);
  if (!((jourSemaine === 1 && heure >= 9) || jourSemaine === 2)) return null;
  const lundiCourant = addDays(jour, -((jourSemaine + 6) % 7));
  return { du: addDays(lundiCourant, -7), au: addDays(lundiCourant, -1) };
}

export async function balayerRecap(d: DepsRecap): Promise<number> {
  const semaine = semaineARecapituler(d.now ? d.now() : new Date());
  if (semaine === null) return 0;
  const occasion = `semaine:${semaine.du}`;
  let n = 0;
  for (const tenantId of await d.espaces()) {
    try {
      if (!(await d.estFree(tenantId))) continue;
      if (await d.dejaEnvoye(tenantId, occasion)) continue;
      const r = await d.recap(tenantId, semaine.du, semaine.au);
      // Une semaine vide n'écrit rien (décision du 2026-10-14) : un e-mail de zéros ne sert à personne.
      if (r.messagesRecus + r.messagesEnvoyes === 0) continue;
      await d.emettre({
        cle: 'recap_semaine', tenantId, occasion, a: 'admins',
        valeurs: {
          semaine_du: `${semaine.du}T12:00:00.000Z`, messages_recus: String(r.messagesRecus), messages_envoyes: String(r.messagesEnvoyes),
          conversations: String(r.conversations), demandes: String(r.demandes), credit: String(Math.max(0, r.creditMicroEur)),
          lien_offre: d.pageOffre,
        },
      });
      n += 1;
    } catch (err) {
      journaliser('error', 'recap_semaine_impossible', { err, tenantId });
    }
  }
  return n;
}
