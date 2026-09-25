import { SOURCE_STOP_WHATSAPP } from '../crm/consentement';
import {
  SOURCE_STOP_RCS, identifiantPoussable, type AnalyseDuSignal, type CanalSignal, type ContactDuSignal, type Signal, type SignalComplet,
} from './types';

/**
 * RELIRE CE QUE LE SIGNAL NE TRANSPORTE PAS (spec 2026-09-24, § 8), au moment de pousser et jamais sur le
 * chemin chaud : la fiche et son consentement COURANT, l'origine et l'envoi d'un message, le lien cliqué,
 * l'analyse. GÉNÉRIQUE : aucun outil cible n'est nommé ici, tout adaptateur en part.
 *
 * `null` = plus rien à pousser (fiche supprimée, conversation ou analyse disparue) : ce n'est pas un échec.
 */
export interface FicheDuSignal extends ContactDuSignal {
  /** L'origine du dernier consentement écrit (`opt_in_source`) : c'est la source d'un désabonnement WhatsApp. */
  optInSource: string | null;
}

/** Chaque lecture reçoit l'espace du JOB et filtre dessus (`tenant_id = $1`) : c'est le seul contrôle. */
export interface LecturesSignal {
  ficheParWaId(tenantId: string, waId: string): Promise<FicheDuSignal | null>;
  ficheParId(tenantId: string, contactId: string): Promise<FicheDuSignal | null>;
  waIdDeLaConversation(tenantId: string, conversationId: string): Promise<string | null>;
  contexteDuMessage(tenantId: string, messageId: string): Promise<{ origine: string | null; sendId: string | null }>;
  lien(tenantId: string, code: string): Promise<{ template: string | null; destination: string } | null>;
  analyse(tenantId: string, conversationId: string): Promise<AnalyseDuSignal | null>;
}

/**
 * Le canal sur lequel la personne a DIT STOP, ou `null`.
 *
 * 🔴 LE `canal` DU JOB NE LE DIT PAS : il dit quel consentement l'écriture a retiré (`opt_in_status` pour
 * `whatsapp`). Or le dépôt des contacts écrit `opted_out` pour le mot-clé STOP, mais aussi depuis la fiche,
 * l'action en masse, un scénario ou l'API publique. Annoncer `whatsapp` pour ces derniers ferait croire à
 * l'intégrateur que le contact a écrit STOP sur WhatsApp. Seule la source le prouve, relue sur la fiche.
 */
function canalDuStop(s: Extract<Signal, { nom: 'em_opted_out' }>, fiche: FicheDuSignal): CanalSignal | null {
  if (s.canal === 'rcs') return 'rcs';
  return fiche.optInSource === SOURCE_STOP_WHATSAPP ? 'whatsapp' : null;
}

async function ficheDu(l: LecturesSignal, tenantId: string, s: Signal): Promise<FicheDuSignal | null> {
  if (s.nom === 'em_link_clicked') return l.ficheParId(tenantId, s.contactId);
  if (s.nom === 'em_conversation_analyzed') {
    const waId = await l.waIdDeLaConversation(tenantId, s.conversationId);
    return waId === null ? null : l.ficheParWaId(tenantId, waId);
  }
  return l.ficheParWaId(tenantId, s.waId);
}

/** Ce qu'un accusé porte quand son message n'a pas été relu : ni origine, ni envoi. */
const SANS_CONTEXTE = { origine: null, sendId: null } as const;

export async function completerSignal(l: LecturesSignal, tenantId: string, s: Signal): Promise<SignalComplet | null> {
  const fiche = await ficheDu(l, tenantId, s);
  if (fiche === null) return null;
  /**
   * 🔴 CE QUI NE SERT QU'À LA POUSSÉE NE SE RELIT PAS POUR UNE FICHE QUI NE SERA JAMAIS POUSSÉE. Sans identifiant
   * externe, l'adaptateur la COMPTE et s'arrête là : le contexte d'un message (trois sous-requêtes, et un accusé
   * de campagne en produit des milliers) et le lien d'un clic seraient lus pour rien. L'analyse, elle, se relit
   * quand même : son absence veut dire « plus rien à pousser » (`null`), et la fiche ne serait plus comptée.
   */
  const poussable = identifiantPoussable(fiche) !== null;
  const base = {
    id: s.id,
    le: s.le,
    contact: { contactId: fiche.contactId, externalId: fiche.externalId, optOutWhatsapp: fiche.optOutWhatsapp, optOutRcs: fiche.optOutRcs },
  };
  switch (s.nom) {
    case 'em_message_delivered':
    case 'em_message_read': {
      const ctx = poussable ? await l.contexteDuMessage(tenantId, s.messageId) : SANS_CONTEXTE;
      return { ...base, contenu: { nom: s.nom, canal: s.canal, origine: ctx.origine, sendId: ctx.sendId } };
    }
    case 'em_message_failed': {
      const ctx = poussable ? await l.contexteDuMessage(tenantId, s.messageId) : SANS_CONTEXTE;
      return { ...base, contenu: { nom: s.nom, canal: s.canal, origine: ctx.origine, sendId: ctx.sendId, motif: s.motif, codeMeta: s.codeMeta } };
    }
    case 'em_replied':
      return { ...base, contenu: { nom: s.nom, canal: s.canal, bouton: s.bouton } };
    case 'em_link_clicked': {
      const lien = poussable ? await l.lien(tenantId, s.lien) : null;
      return { ...base, contenu: { nom: s.nom, lien: s.lien, template: lien?.template ?? null, destination: lien?.destination ?? null } };
    }
    case 'em_opted_out':
      // ⚠️ La source est relue au moment de pousser : un contact réabonné entre-temps rend la source de son
      // réabonnement, donc aucun canal. C'est le sens exact de « le canal n'est dit que s'il est prouvé ».
      return { ...base, contenu: { nom: s.nom, canal: canalDuStop(s, fiche), source: s.canal === 'rcs' ? SOURCE_STOP_RCS : fiche.optInSource } };
    case 'em_conversation_analyzed': {
      const analyse = await l.analyse(tenantId, s.conversationId);
      return analyse === null ? null : { ...base, contenu: { nom: s.nom, analyse } };
    }
  }
}
