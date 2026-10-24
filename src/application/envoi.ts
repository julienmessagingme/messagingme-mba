import { DROITS } from '../offres/offres';
import type { ClientApplication, RaisonClient, Resultat } from './client';
import type { ComptesApplication, Filiere } from './comptes';
import { idDuMessage, jidDuWaId } from './message';
import { GEL_MS, type RefusPremier } from './premier-message';

/**
 * ENVOYER PAR LA FILIÈRE APPLICATION (plan 2026-10-22, tâche 5) : ce que la réponse commune (`src/inbox/repondre.ts`),
 * l'agent IA (`src/workflow/wiring.ts`) et le contrôle du fil (`src/inbox/fil.ts`) savent de cette filière. Une seule
 * dépendance, requise partout : sans elle, un chemin oublié refuserait en silence faute de numéro Meta.
 */
export interface EnvoiApplication {
  /** `application` dès qu'un compte non retiré existe, `api` avec un numéro de Meta, `null` sinon. */
  filiere(tenantId: string): Promise<Filiere | null>;
  /** Le compte de l'espace est-il relié, donc en état d'envoyer ? */
  relie(tenantId: string): Promise<boolean>;
  /** Un texte au contact ; l'identifiant rendu est celui de nos tables (`idDuMessage`). */
  envoyer(tenantId: string, waId: string, texte: string): Promise<Resultat<{ messageId: string }>>;
}

export function creerEnvoiApplication(d: {
  comptes: Pick<ComptesApplication, 'parEspace' | 'filiereDe'>;
  /** `null` : le service n'est pas configuré (`APPLICATION_SERVICE_URL` vide), la filière est fermée. */
  client: ClientApplication | null;
}): EnvoiApplication {
  return {
    filiere: (tenantId) => d.comptes.filiereDe(tenantId),
    relie: async (tenantId) => (await d.comptes.parEspace(tenantId))?.statut === 'relie',
    async envoyer(tenantId, waId, texte) {
      const jid = jidDuWaId(waId);
      if (!jid) return { ok: false, raison: 'refuse' };
      const compte = await d.comptes.parEspace(tenantId);
      // Coupé ou endormi : deux raisons à part, parce que leurs suites s'opposent (un banni ne se relie jamais, un
      // endormi se réveille). Les autres statuts restent « non relié ».
      if (compte?.statut === 'banni' || compte?.statut === 'sommeil') return { ok: false, raison: compte.statut };
      if (compte?.statut !== 'relie') return { ok: false, raison: 'non_relie' };
      if (!d.client) return { ok: false, raison: 'service_injoignable' };
      const r = await d.client.envoyer(compte.id, jid, texte);
      return r.ok ? { ok: true, messageId: idDuMessage(compte.id, r.messageId) } : r;
    },
  };
}

/** Ce qu'un refus d'envoi de la filière application dit à qui a voulu envoyer (API publique, Claude, console). */
export function phraseApplicationIndisponible(raison: RaisonClient): string {
  if (raison === 'service_injoignable') {
    return 'le service de connexion de l’application WhatsApp Business ne répond pas : réessayez dans un instant';
  }
  if (raison === 'refuse') return 'WhatsApp a refusé l’envoi de ce message';
  if (raison === 'refuse_whatsapp') return 'WhatsApp a refusé ce message';
  // 🔴 Jamais « reliez-le de nouveau » pour un numéro coupé : un relien rendrait le bannissement définitif.
  if (raison === 'banni') return 'le numéro a été coupé par WhatsApp : il ne peut plus rien envoyer';
  if (raison === 'sommeil') {
    return 'le numéro est en sommeil faute de messages : reliez-le de nouveau pour le réveiller (start_whatsapp_connection)';
  }
  return 'le numéro de l’application WhatsApp Business n’est pas relié : reliez-le de nouveau (start_whatsapp_connection)';
}

/** Sur l'application, seul le texte part au premier lot : un média, des boutons ou un lieu attendent un lot suivant. */
export const PHRASE_FORMAT_APPLICATION = 'sur un numéro de l’application WhatsApp Business, seul un texte peut partir pour l’instant';

/** Un nombre écrit à la française (« 1 000 »), comme les refus de l'offre (`src/offres/refus.ts`). */
const nb = (n: number): string => n.toLocaleString('fr-FR');

/**
 * Les messages écrits en premier d'un mois, ceux de la Free : la filière application n'a pas d'autre offre (le Pro y est
 * refusé, conception du 2026-10-22). Lus dans la grille, jamais recopiés.
 */
const MESSAGES_DU_MOIS = nb(DROITS.base.limites.envoisModelesMois ?? 0);

/**
 * Ce qu'un message écrit en premier mis en file dit à qui l'a demandé (Claude, l'API) : l'heure de son départ, à Paris,
 * et ce qu'il coûte. Le créneau espacé est la règle de la porte (`enfilerPremierMessage`), jamais un refus.
 */
export function phraseMessageEnFile(prevuLe: Date): string {
  const heure = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(prevuLe);
  return `message en file : il part vers ${heure} (heure de Paris), hors des 24 heures il compte dans les ${MESSAGES_DU_MOIS} messages du mois`;
}

/**
 * Ce qu'un refus de la porte « écrire en premier » dit à qui a voulu écrire. `pour` : l'outil à nommer quand la phrase
 * en propose un (Claude) ou le champ de l'API publique (`api`). Exhaustif : un refus ajouté demain ne compile pas ici.
 */
export function phrasePremierMessage(refus: RefusPremier, pour: 'mcp' | 'api'): string {
  switch (refus) {
    case 'filiere_api':
      return `sur l’API, un premier message est un modèle approuvé : ${pour === 'mcp' ? 'send_template_to_contact' : 'POST /v1/sends'}`;
    case 'numero_coupe':
      // 🔴 Jamais « reliez-le de nouveau » pour un numéro coupé (`phraseApplicationIndisponible`).
      return phraseApplicationIndisponible('banni');
    case 'numero_indisponible':
      return phraseApplicationIndisponible('non_relie');
    case 'gele':
      return `WhatsApp a refusé un message écrit en premier depuis ce numéro : les premiers messages sont suspendus ${GEL_MS / 3_600_000} heures, `
        + 'les réponses dans les 24 heures restent possibles';
    case 'desabonne':
      return 'ce contact a demandé à ne plus recevoir de messages (STOP) : rien ne lui est envoyé';
    case 'bloque':
      return 'ce contact est bloqué dans cet espace : rien ne lui est envoyé';
    case 'sans_consentement':
      return 'ce contact n’a pas accepté WhatsApp : hors des 24 heures, un premier message exige son accord ; '
        + (pour === 'mcp' ? 'write_first_message avec consent_source le déclare' : 'consent à opted_in, avec consentSource, le déclare');
    case 'limite_contacts':
      return `limite de contacts de votre offre atteinte (${nb(DROITS.base.limites.contacts ?? 0)} contacts créés) : aucune fiche n’a été créée, le message ne part pas`;
    case 'limite_modeles':
      return `les ${MESSAGES_DU_MOIS} messages du mois sont atteints : le message ne part pas, les réponses dans les 24 heures restent possibles`;
    case 'sans_telephone':
      return 'ce contact n’a pas de numéro de téléphone connu : un premier message ne part que vers un numéro';
    default: {
      const inconnu: never = refus;
      throw new Error(`refus de premier message inconnu : ${String(inconnu)}`);
    }
  }
}
