import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BORNES_ACTION, type ChampAction } from './outils-maison';
import { TYPE_ACTION_AGENT, donneesActionAgent, idEvenement, type ContactPublic, type TypeAbonnable } from '../evenements/types';
import { jourDans } from '../repondeur/alerte-credit';

/**
 * LES ACTIONS DE L'AGENT IA (plan `docs/superpowers/plans/2026-10-13-actions-agent.md`, décisions de Julien du
 * 2026-10-13). L'agent reconnaît une demande que l'administrateur a décrite (« je veux résilier »), recueille ce qu'il
 * peut, et l'action part vers l'application du client par le webhook `agent.action`, avec une trace dans la frise et un
 * déclencheur d'automation. Le tour CONTINUE : l'agent dit au contact ce que la consigne prévoit.
 *
 * 🔴 UNE FOIS PAR JOUR, PAR CONTACT ET PAR ACTION, tenu en base (`agent_actions_une_par_jour`, migration 0232), le jour
 * lu dans le fuseau de l'espace : un modèle qui rappelle l'outil, ou un tour rejoué, ne fait rien partir deux fois.
 */

export type ValeursAction = Record<string, string | number>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Une date `AAAA-MM-JJ` qui existe au calendrier (le 30 février n'en est pas une). */
function dateReelle(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Les valeurs recueillies par le modèle, champ par champ. TOUS FACULTATIFS (décision de Julien) : un champ absent, nul ou
 * vide est simplement absent du webhook. Un format faux (date, e-mail, nombre, valeur hors liste) est RENDU au modèle,
 * qui peut redemander au contact : partir avec une date illisible ferait échouer l'application du client en silence.
 * Les arguments hors des champs sont ignorés (la validation de `executeTool` les a déjà retirés).
 */
export function valeursDesChamps(
  champs: readonly ChampAction[], args: Record<string, unknown>,
): { ok: true; valeurs: ValeursAction } | { ok: false; erreur: string } {
  const valeurs: ValeursAction = {};
  for (const c of champs) {
    // `hasOwn` : un code « constructor » ou « toString » lirait sinon le prototype quand le modèle ne le donne pas.
    const brut = Object.hasOwn(args, c.code) ? args[c.code] : undefined;
    if (brut === null || brut === undefined) continue;
    if (c.type === 'nombre') {
      const n = typeof brut === 'number' ? brut : String(brut).trim() === '' ? null : Number(String(brut).trim().replace(',', '.'));
      if (n === null) continue;
      if (!Number.isFinite(n)) return { ok: false, erreur: `« ${c.libelle} » : un nombre est attendu` };
      valeurs[c.code] = n;
      continue;
    }
    const s = String(brut).trim();
    if (s === '') continue;
    // La borne est annoncée au modèle dans la description du champ (`FORMAT_DU_CHAMP`) ; au-delà, le corps du webhook
    // pourrait dépasser ce que la ligne d'envoi accepte.
    if (s.length > BORNES_ACTION.texte) {
      return { ok: false, erreur: `« ${c.libelle} » : ${BORNES_ACTION.texte} caractères au plus` };
    }
    if (c.type === 'date' && !dateReelle(s)) {
      return { ok: false, erreur: `« ${c.libelle} » : une date au format AAAA-MM-JJ est attendue, par exemple 2026-10-31` };
    }
    if (c.type === 'email' && !z.email().safeParse(s).success) {
      return { ok: false, erreur: `« ${c.libelle} » : une adresse e-mail valide est attendue` };
    }
    if (c.type === 'liste' && !(c.valeurs ?? []).includes(s)) {
      return { ok: false, erreur: `« ${c.libelle} » : choisir parmi ${(c.valeurs ?? []).join(', ')}` };
    }
    valeurs[c.code] = s;
  }
  return { ok: true, valeurs };
}

/**
 * 🔴 L'identifiant public de l'événement, tiré de la CLÉ NATURELLE (l'action, le contact, le jour) et non de la ligne
 * réservée : c'est ce qui rend toute reprise idempotente. Une réservation rendue puis reprise, ou un rejeu sur « déjà
 * partie », retombe sur le même identifiant, et la ligne d'envoi, unique par adresse et par événement, ne part pas deux
 * fois (seule une ligne jamais tentée est réenfilée, `PgEnvoisEvenementsStore.creer`). Opaque : il encode le numéro.
 */
export function idEvenementAction(cle: { actionId: string; waId: string; jour: string }): string {
  return idEvenement(createHash('sha256').update(`${TYPE_ACTION_AGENT}:${cle.actionId}:${cle.waId}:${cle.jour}`).digest('hex').slice(0, 32));
}

export interface ReservationAction {
  tenantId: string;
  /** L'outil de l'agent qui porte l'action (`agent_tools.id`). */
  actionId: string;
  agentId: string;
  conversationId: string;
  waId: string;
  /** Le jour civil `AAAA-MM-JJ` dans le fuseau de l'espace. */
  jour: string;
  champs: ValeursAction;
}

export interface DepsDeclencherAction {
  /** 🔴 Filtré sur l'espace. La conversation du contact du tour, `null` s'il n'en a pas. */
  conversationId(tenantId: string, waId: string): Promise<string | null>;
  /** Le fuseau de l'espace (`settings.timezone`) : le « jour » de la règle est le sien. */
  fuseau(tenantId: string): Promise<string>;
  /** Réserve la ligne du jour ; rend son identifiant, ou `null` si l'action est déjà partie aujourd'hui pour ce contact. */
  reserver(l: ReservationAction): Promise<string | null>;
  /** Rend une réservation dont le webhook n'a pas pu s'écrire, pour que le modèle puisse réessayer. Filtré sur l'espace. */
  annuler(tenantId: string, reservationId: string): Promise<void>;
  /** La fiche du contact, telle qu'elle part dans chaque événement (`ContactPublic`). */
  fiche(tenantId: string, waId: string): Promise<ContactPublic | null>;
  /** La distribution aux adresses qui ont coché le type (`distribuerEvenementEspace`). */
  distribuer(tenantId: string, ev: {
    id: string; type: TypeAbonnable; le: string; data: Record<string, unknown>; contactId: string | null;
  }): Promise<unknown>;
  /** L'événement `action_agent` de la frise du panneau Détail de l'Inbox ; sa cause nomme l'agent et l'action. */
  noterFrise(tenantId: string, conversationId: string, action: { agentId: string; nom: string }): Promise<void>;
  /** Le déclencheur d'automation « une action de l'agent » : un démarrage unitaire, permis comme la pose d'un tag. */
  publierAutomation(ev: { kind: 'agent_action'; tenantId: string; waId: string; actionId: string }): Promise<void>;
  maintenant?: () => Date;
}

export type IssueAction = 'declenchee' | 'deja' | 'aucune_conversation';

/**
 * Déclenche une action. L'ordre compte : la réservation d'abord (c'est elle qui dit « une fois par jour »), puis le
 * webhook, qui est le contrat avec l'application du client. 🔴 Si le webhook ne s'écrit pas, la réservation est rendue
 * et l'erreur remonte : le modèle l'apprend, et un nouvel appel peut réussir. La frise et l'automation viennent après et
 * ne défont rien : le webhook est déjà enfilé.
 *
 * 🔴 « DÉJÀ PARTIE » REJOUE LA DISTRIBUTION, avec le même identifiant (`idEvenementAction`) : un processus tué entre la
 * réservation et le webhook laisserait sinon une action réservée que rien n'a envoyée, et l'agent dirait « c'est
 * enregistré » toute la journée. Le rejeu est idempotent : une ligne d'envoi déjà là ne repart pas, une ligne jamais
 * tentée est réenfilée. Ni frise ni automation ne sont rejouées. Une valeur donnée APRÈS le premier déclenchement ne
 * part pas (une fois par jour) : le modèle le lit.
 */
export async function declencherAction(
  deps: DepsDeclencherAction,
  input: { tenantId: string; waId: string; agentId: string; actionId: string; nom: string; champs: ValeursAction },
): Promise<IssueAction> {
  const { tenantId, waId } = input;
  const conversationId = await deps.conversationId(tenantId, waId);
  if (conversationId === null) return 'aucune_conversation';
  const maintenant = deps.maintenant?.() ?? new Date();
  const jour = jourDans(await deps.fuseau(tenantId), maintenant);
  const distribuer = async (): Promise<void> => {
    const contact = await deps.fiche(tenantId, waId);
    await deps.distribuer(tenantId, {
      id: idEvenementAction({ actionId: input.actionId, waId, jour }),
      type: TYPE_ACTION_AGENT,
      le: maintenant.toISOString(),
      data: donneesActionAgent({
        contact, conversationId, agentId: input.agentId, actionId: input.actionId, nom: input.nom, champs: input.champs,
      }),
      contactId: contact?.id ?? null,
    });
  };
  const reservation = await deps.reserver({
    tenantId, actionId: input.actionId, agentId: input.agentId, conversationId, waId, jour, champs: input.champs,
  });
  if (reservation === null) {
    try {
      await distribuer();
    } catch (err) {
      console.warn('action de l’agent : le rejeu du webhook a échoué :', err instanceof Error ? err.message : err);
    }
    return 'deja';
  }

  try {
    await distribuer();
  } catch (err) {
    await deps.annuler(tenantId, reservation);
    throw err;
  }

  try {
    await deps.noterFrise(tenantId, conversationId, { agentId: input.agentId, nom: input.nom });
  } catch (err) {
    console.warn('action de l’agent : la frise n’a pas pu être écrite :', err instanceof Error ? err.message : err);
  }
  try {
    await deps.publierAutomation({ kind: 'agent_action', tenantId, waId, actionId: input.actionId });
  } catch (err) {
    console.warn('action de l’agent : l’automation n’a pas pu être enfilée :', err instanceof Error ? err.message : err);
  }
  return 'declenchee';
}
