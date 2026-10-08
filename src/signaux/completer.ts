import { SOURCE_STOP_WHATSAPP } from '../crm/consentement';
import {
  SOURCE_STOP_RCS, identifiantPoussable, type AnalyseDuSignal, type CanalSignal, type ContactDuSignal, type Signal, type SignalComplet,
} from './types';

/**
 * Relire ce que le signal ne transporte pas, au moment de pousser et jamais sur le chemin chaud : la fiche et son
 * consentement courant, l'origine et l'envoi d'un message, le lien cliqué, l'analyse. Aucun outil n'est nommé ici.
 *
 * Une seule règle d'identité y est lue en dur, celle de l'adaptateur actuel (`identifiantPoussable` : une fiche
 * ne se pousse que sous son `externalId`). Un adaptateur qui désignerait un profil autrement devra passer son
 * critère en paramètre, sinon il recevrait des signaux amputés pour les fiches sans `externalId`, en silence.
 *
 * `null` = plus rien à pousser (fiche supprimée, conversation ou analyse disparue) : ce n'est pas un échec.
 */
export interface FicheDuSignal extends ContactDuSignal {
  /** L'origine du dernier consentement écrit (`opt_in_source`) : c'est la source d'un désabonnement WhatsApp. */
  optInSource: string | null;
}

/** 🔴 Chaque lecture reçoit l'espace du job et filtre dessus (`tenant_id = $1`) : c'est le seul contrôle. */
export interface LecturesSignal {
  ficheParWaId(tenantId: string, waId: string): Promise<FicheDuSignal | null>;
  ficheParId(tenantId: string, contactId: string): Promise<FicheDuSignal | null>;
  waIdDeLaConversation(tenantId: string, conversationId: string): Promise<string | null>;
  contexteDuMessage(tenantId: string, messageId: string): Promise<{ origine: string | null; sendId: string | null }>;
  lien(tenantId: string, code: string): Promise<{ template: string | null; destination: string } | null>;
  analyse(tenantId: string, conversationId: string): Promise<AnalyseDuSignal | null>;
}

/**
 * Le canal sur lequel la personne a dit STOP, ou `null`.
 *
 * Le `canal` du job ne le dit pas : il dit quel consentement a été retiré, et `opted_out` s'écrit aussi depuis la
 * fiche, l'action en masse, un scénario ou l'API. Annoncer `whatsapp` pour ceux-là ferait croire à un STOP écrit
 * sur WhatsApp : seule la source relue sur la fiche le prouve.
 */
function canalDuStop(s: Extract<Signal, { nom: 'em_opted_out' }>, fiche: FicheDuSignal): CanalSignal | null {
  if (s.canal === 'rcs') return 'rcs';
  return fiche.optInSource === SOURCE_STOP_WHATSAPP ? 'whatsapp' : null;
}

async function ficheDu(l: LecturesSignal, tenantId: string, s: Signal): Promise<FicheDuSignal | null> {
  if (s.nom === 'em_link_clicked' || s.nom === 'em_risk_changed') return l.ficheParId(tenantId, s.contactId);
  if (s.nom === 'em_conversation_analyzed') {
    const waId = await l.waIdDeLaConversation(tenantId, s.conversationId);
    return waId === null ? null : l.ficheParWaId(tenantId, waId);
  }
  return l.ficheParWaId(tenantId, s.waId);
}

/** Ce qu'un accusé porte quand son message n'a pas été relu : ni origine, ni envoi. */
const SANS_CONTEXTE = { origine: null, sendId: null } as const;

/**
 * `contexteComplet` : relire le contexte d'un message et le lien d'un clic même pour une fiche sans identifiant
 * externe. Les webhooks sortants le demandent : ils désignent une fiche par son identifiant à nous, pas par celui
 * d'un outil, donc la règle de Batch (`identifiantPoussable`) n'a pas à les amputer.
 */
export async function completerSignal(
  l: LecturesSignal, tenantId: string, s: Signal, opts: { contexteComplet?: boolean } = {},
): Promise<SignalComplet | null> {
  const fiche = await ficheDu(l, tenantId, s);
  if (fiche === null) return null;
  // Une fiche sans identifiant externe sera seulement comptée : on ne relit pas pour elle le contexte d'un message
  // (un accusé de campagne en produit des milliers) ni le lien d'un clic. L'analyse se relit quand même : son
  // absence veut dire « plus rien à pousser ». Règle d'identité lue en dur, cf. l'en-tête du fichier.
  const poussable = opts.contexteComplet === true || identifiantPoussable(fiche) !== null;
  const base = {
    id: s.id,
    le: s.le,
    contact: {
      contactId: fiche.contactId, telephone: fiche.telephone, nom: fiche.nom, externalId: fiche.externalId,
      optOutWhatsapp: fiche.optOutWhatsapp, optOutRcs: fiche.optOutRcs, derniereAnalyse: fiche.derniereAnalyse,
    },
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
      // Source relue au moment de pousser : un contact réabonné entre-temps rend la source de son réabonnement,
      // donc aucun canal.
      return { ...base, contenu: { nom: s.nom, canal: canalDuStop(s, fiche), source: s.canal === 'rcs' ? SOURCE_STOP_RCS : fiche.optInSource } };
    case 'em_conversation_analyzed': {
      // Conversation effacée avant la poussée : on ne retrouve la fiche que par le fil, et l'analyse part avec lui,
      // donc le signal tombe (`ficheDu` a déjà rendu `null`). Le garder quand la fiche est analysée demanderait que
      // le signal porte son `contactId` (format du job et émetteur) pour une fenêtre de quelques secondes entre
      // l'analyse et la poussée : écarté le 2026-10-02. La copie de la fiche part avec le signal suivant.
      const analyse = await l.analyse(tenantId, s.conversationId);
      return analyse === null ? null : { ...base, contenu: { nom: s.nom, analyse } };
    }
    case 'em_risk_changed':
      // Rien à relire : le calcul du balayage voyage dans le job (`signalRisque`).
      return { ...base, contenu: { nom: s.nom, niveau: s.niveau, ancienNiveau: s.ancienNiveau, score: s.score, raisons: s.raisons } };
  }
}
