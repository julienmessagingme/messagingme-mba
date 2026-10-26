import { z } from 'zod';
import { journaliser } from '../lib/journal';
import { ATTENTE_RECENTE_MS, FENETRE_MS } from '../emails-produit/alertes';
import type { CorpsHandoff, IssueHandoff } from '../crm/hubspot-service';
import type { EtatPassage } from './enrichment';
import type { PassagesHubspot } from './passages-hubspot';

/**
 * LE PASSAGE À L'ÉQUIPE POUSSÉ À HUBSPOT (lot 1 de la reprise humaine, plan du connecteur du 2026-10-23).
 *
 * Une escalade posée par l'un des trois chemins d'un robot qui passe la main (`prevenirEquipe`) enfile un job
 * `push-handoff` ; le job relit la conversation et appelle `POST /service/handoff` du connecteur, qui crée UNE tâche
 * avec le lien de la conversation. La clé d'occasion (conversation et instant de l'escalade) fait qu'un rejeu ne crée
 * jamais une seconde tâche côté connecteur : aucune file de ce dépôt ne déduplique.
 */

/**
 * Le payload : une référence, jamais un instantané. `relance` (lot 2b, décision C) : le balayage `hubspot-clotures` a
 * inscrit cette relance (son occasion) avant de l'enfiler ; absente, c'est une escalade.
 */
const payloadHandoff = z.object({
  tenantId: z.string().min(1),
  waId: z.string().min(1),
  relance: z.object({ occasion: z.string().min(1).max(200) }).optional(),
});

/**
 * `prevenirEquipe` devient la composition de l'e-mail aux admins (inchangé, avec son filtre « le contact vient
 * d'écrire ») et de l'enfilement du job. `enfiler` nul (aucun connecteur configuré) : l'e-mail seul. Un enfilement en
 * échec est journalisé et ne remonte JAMAIS chez l'appelant, qui vient de basculer le fil et ne doit pas échouer pour
 * HubSpot. 🔴 L'enfilement passe AVANT les filtres de l'e-mail (le quart d'heure, le plafond du jour) : la garde de
 * masse ne tient donc pas aux appelants (un scénario d'automation en rafale, `avant_date` ou deals déplacés en masse,
 * passe `prevenir`), elle est rejouée par le job (« le contact vient d'écrire »).
 */
export function composerPassageEquipe(
  email: (tenantId: string, waId: string) => Promise<void>,
  enfiler: ((job: { tenantId: string; waId: string }) => Promise<void>) | null,
): (tenantId: string, waId: string) => Promise<void> {
  if (enfiler === null) return email;
  return async (tenantId, waId) => {
    try {
      await enfiler({ tenantId, waId });
    } catch (err) {
      journaliser('error', 'push_handoff_enfilement_impossible', { err, tenantId });
    }
    await email(tenantId, waId);
  };
}

export interface PushHandoffDeps {
  /** Le client a-t-il branché « la tâche immédiate » (lot 1bis, `lireChoixHubspot`) ? Requis, pour la même raison. */
  passageBranche(tenantId: string): Promise<boolean>;
  /** L'état frais de la conversation, filtré sur l'espace (`getEtatPassage`). */
  lireEtat(tenantId: string, waId: string): Promise<EtatPassage | null>;
  /** La porte HubSpot du numéro, la même que la poussée de l'analyse. */
  numeros: { getHubspotGateStatus(tenantId: string, whatsappLine: string): Promise<{ connected: boolean; pausedAt: string | null }> };
  /** L'adresse de la conversation dans l'Inbox, la même fonction que l'e-mail `transfert_equipe`. */
  lienConversation(conversationId: string): string;
  /** `pousserHandoff` : rend une issue, LÈVE sur 429, 5xx et réseau. */
  pousser(corps: CorpsHandoff): Promise<IssueHandoff>;
  /**
   * 🔴 Lot 2b (décision D) : un contact qui a dit STOP n'ouvre aucune tâche. Après son STOP, l'agent de Meta passe la
   * main à l'équipe (vu à l'essai réel du 2026-10-26) : sans cette garde, un conseiller était invité à répondre à
   * quelqu'un que la carte refuse, à raison, de lui écrire. Requise, comme partout où elle se pose.
   */
  estDesabonne(tenantId: string, waId: string): Promise<boolean>;
  /** Lot 2b : les passages poussés, que le balayage `hubspot-clotures` clôt (`src/analysis/passages-hubspot.ts`). */
  passages: Pick<PassagesHubspot, 'inscrire' | 'clore'>;
}

/**
 * Job `push-handoff`. Relit l'état et s'arrête sans rien pousser :
 * - conversation absente, ou `escaladee_le` nul : plus personne n'attend (un opérateur a déjà répondu, ou c'était un
 *   échec remonté sans le drapeau d'escalade, qui n'est pas une demande d'humain) ;
 * - 🔴 aucun entrant dans le quart d'heure qui précède l'escalade (`ATTENTE_RECENTE_MS`, la règle de l'e-mail
 *   `transfert_equipe`), ou aucun entrant du tout : personne n'a rien demandé. C'est la garde contre la masse : un
 *   scénario d'automation (`avant_date`, `tag_added`, `webhook`, `hubspot_deal_stage`) qui passe la main sur des
 *   centaines de contacts silencieux créerait sinon autant de tâches chez les conseillers. Les passages légitimes
 *   (agent de Meta, agent IA, scénario qui avance sur une réponse) suivent toujours un entrant récent ;
 * - ligne non reliée à HubSpot ou en pause : aucune marque de rattrapage, une demande d'humain périmée n'a rien à
 *   faire dans HubSpot à la reprise.
 * Sinon il pousse. 2xx et 404 (espace sans portail) finissent le job ; un autre refus est journalisé et le finit
 * aussi (le rejouer rendrait le même refus) ; 429, 5xx et réseau lèvent, et pg-boss rejoue.
 *
 * Lot 2b : un contact STOP ou bloqué ne pousse rien (décision D) ; une escalade poussée s'inscrit dans
 * `passages_hubspot`, que le balayage `hubspot-clotures` clôt ; une RELANCE (payload `relance`) se rejuge à l'exécution
 * (l'équipe tient le fil, aucune escalade, le dernier message vient du client) et se clôt si elle ne part pas.
 */
export async function pushHandoffJob(data: unknown, deps: PushHandoffDeps): Promise<void> {
  const p = payloadHandoff.safeParse(data);
  if (!p.success) throw new Error('push-handoff : payload invalide (tenantId/waId manquant)');
  const { tenantId, waId, relance } = p.data;
  // Une relance inscrite mais pas poussée se clôt aussitôt : rien ne l'attend chez HubSpot, et le balayage n'a pas à
  // lui demander d'y cocher quoi que ce soit.
  const abandonner = async (): Promise<void> => { if (relance) await deps.passages.clore(relance.occasion); };

  // Lot 1bis : le client a éteint la tâche immédiate. Lu au moment d'agir, comme le reste de l'état.
  if (!(await deps.passageBranche(tenantId))) {
    journaliser('info', 'push_handoff_non_branche', { tenantId });
    await abandonner();
    return;
  }
  if (await deps.estDesabonne(tenantId, waId)) {
    journaliser('info', 'push_handoff_contact_desabonne', { tenantId });
    await abandonner();
    return;
  }

  const etat = await deps.lireEtat(tenantId, waId);
  if (etat === null) {
    journaliser('info', 'push_handoff_sans_escalade', { tenantId });
    await abandonner();
    return;
  }
  let occasion: string;
  let depuisEscalade: Date | null = null;
  if (relance) {
    // Toujours due ? L'équipe tient le fil, aucune escalade n'est ouverte (elle a son propre passage), et le dernier
    // message est encore celui du client.
    if (etat.controlOwner !== 'app_human' || etat.escaladeeLe !== null || etat.dernierSens !== 'in') {
      journaliser('info', 'push_handoff_relance_plus_due', { tenantId, conversationId: etat.conversationId });
      await abandonner();
      return;
    }
    occasion = relance.occasion;
  } else {
    if (etat.escaladeeLe === null) {
      journaliser('info', 'push_handoff_sans_escalade', { tenantId });
      return;
    }
    if (etat.dernierEntrantLe === null || etat.dernierEntrantLe.getTime() < etat.escaladeeLe.getTime() - ATTENTE_RECENTE_MS) {
      journaliser('info', 'push_handoff_sans_attente', { tenantId, conversationId: etat.conversationId });
      return;
    }
    occasion = `${etat.conversationId}:${etat.escaladeeLe.toISOString()}`;
    depuisEscalade = etat.escaladeeLe;
  }
  const porte = await deps.numeros.getHubspotGateStatus(tenantId, etat.whatsappLine);
  if (!porte.connected) {
    journaliser('info', 'push_handoff_ligne_non_reliee', { tenantId, conversationId: etat.conversationId });
    await abandonner();
    return;
  }

  const issue = await deps.pousser({
    tenantId,
    e164: etat.contactE164,
    nom: etat.nom?.trim() || null,
    conversationId: etat.conversationId,
    lienConversation: deps.lienConversation(etat.conversationId),
    finFenetre: etat.dernierEntrantLe ? new Date(etat.dernierEntrantLe.getTime() + FENETRE_MS).toISOString() : null,
    occasion,
    // L'escalade garde le corps du lot 1 au bit près (un connecteur antérieur au lot 2b le lit tel quel).
    ...(relance ? { nature: 'relance' as const } : {}),
  });
  if (issue.issue === 'fait') {
    journaliser('info', 'push_handoff_fait', { tenantId, conversationId: etat.conversationId, created: issue.created, taskId: issue.taskId, relance: relance !== undefined });
    // Lot 2b (décision A) : le passage poussé s'inscrit, pour que le balayage coche sa tâche à la clôture. Une relance
    // l'est déjà ; une escalade rejouée retrouve sa ligne (`on conflict do nothing`).
    if (depuisEscalade) {
      await deps.passages.inscrire({ occasion, tenantId, conversationId: etat.conversationId, nature: 'escalade', depuis: depuisEscalade });
    }
  } else if (issue.issue === 'non_relie') {
    journaliser('info', 'push_handoff_espace_sans_portail', { tenantId, conversationId: etat.conversationId });
    await abandonner();
  } else {
    journaliser('error', 'push_handoff_refuse', { tenantId, conversationId: etat.conversationId, status: issue.status, code: issue.code });
    await abandonner();
  }
}
