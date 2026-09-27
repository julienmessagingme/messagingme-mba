import { llmOutputSchema, INTENTS, NOTE_MIN, NOTE_MAX, type Intent, type LlmOutput, type HandledBy } from './schema';

/** Un message de conversation, forme minimale utilisée par l'analyse (agnostique du stockage). */
export interface AnalysisMessage {
  direction: 'in' | 'out';
  body: string | null;
  type: string | null;
  senderUserId?: string | null;
}

/** Signaux déterministes pour déduire qui a tenu la conversation (calculés en base, pas demandés au LLM). */
export interface HandledBySignals {
  /** Au moins un message sortant posté par un humain (sender_user_id non nul, réponse inbox). */
  hasHumanOutbound: boolean;
}

/**
 * Qui a tenu la conversation (heuristique) : `humain` si un agent a répondu depuis l'inbox, sinon `automatise`,
 * défaut le moins faux y compris pour un entrant jamais traité. `mba` est réservé.
 */
export function deduceHandledBy(s: HandledBySignals): HandledBy {
  if (s.hasHumanOutbound) return 'humain';
  return 'automatise';
}

/** Nombre d'échanges = nombre de tours du client (messages entrants), proxy de friction. */
export function countExchanges(messages: AnalysisMessage[]): number {
  return messages.filter((m) => m.direction === 'in').length;
}

/**
 * Transcript « Client:/Agent: » chronologique, borné en caractères. Trop long, on garde la fin (l'épisode récent
 * porte le sentiment et l'intention), avec un marqueur de troncature en tête.
 */
export function buildTranscript(messages: AnalysisMessage[], maxChars = 6000): string {
  const lines = messages.map((m) => {
    const who = m.direction === 'in' ? 'Client' : 'Agent';
    const text = (m.body ?? '').trim() || `[${m.type ?? 'message'}]`;
    return `${who}: ${text}`;
  });
  let out = lines.join('\n');
  if (out.length > maxChars) {
    out = `[...début tronqué...]\n${out.slice(out.length - maxChars)}`;
  }
  return out;
}

/**
 * Ce que veut dire chaque intention, tel qu'on le dit au modèle. Un `Record<Intent, string>` : une valeur ajoutée à
 * `INTENTS` sans description ne compile pas, sinon elle ne serait jamais proposée et sa barre resterait vide.
 * Écrites pour séparer les voisines (`achat` / `demande_devis`, `suivi_commande` / `reclamation`, `retour` /
 * `sav`), sans quoi la répartition ne voudrait plus rien dire.
 */
export const DESCRIPTIONS_INTENTION: Record<Intent, string> = {
  demande_devis: "le client demande un prix ou un devis chiffré AVANT de s'engager (quantité, prestation sur mesure)",
  sav: "le client a besoin d'aide sur un produit ou un service qu'il a déjà et qu'il GARDE (panne, réglage, mode d'emploi, garantie)",
  reclamation: "le client se plaint d'un préjudice (retard, erreur, produit abîmé, facturation) et attend une réparation ou un geste",
  information: 'question générale, sans démarche en cours (horaires, conditions, disponibilité, tarifs affichés)',
  prise_rdv: 'le client veut fixer, déplacer ou annuler un rendez-vous',
  achat: 'le client veut acheter MAINTENANT un produit ou une offre identifiée (commander, payer, réserver un article), sans demander de devis',
  suivi_commande: "le client demande où en est une commande DÉJÀ passée (expédition, livraison, délai, numéro de suivi), sans s'en plaindre",
  retour: 'le client veut retourner, échanger ou se faire rembourser un produit reçu',
  autre: 'aucune des intentions ci-dessus',
};

const SYSTEM_INSTRUCTIONS = [
  'Tu es un analyste de conversations WhatsApp (support et commercial).',
  'Analyse la conversation et renvoie UNIQUEMENT un objet JSON valide, sans texte autour, sans balises de code.',
  'Champs attendus :',
  '- sentiment : "positif" | "neutre" | "negatif" (ressenti global du client).',
  // Liste et descriptions dérivées de `INTENTS` : une copie à la main serait celle qu'on oublie.
  `- intent : ${INTENTS.map((i) => `"${i}"`).join(' | ')}.`,
  ...INTENTS.map((i) => `  - ${i} : ${DESCRIPTIONS_INTENTION[i]}.`),
  '  Entre deux voisines : une commande en retard dont le client se PLAINT est reclamation, la même question',
  "  posée sans reproche est suivi_commande ; un produit qu'il veut RENVOYER ou échanger est retour, un produit",
  "  qu'il garde mais qui ne marche pas est sav ; une commande à passer est achat, un prix demandé avant de",
  '  décider est demande_devis.',
  '- topic : le sujet en 2 à 5 mots (français), ex. "retard de livraison".',
  '- resolved : true si la demande du client est résolue, false sinon.',
  '- entities : objet des infos utiles extraites (ex. {"produit":"Pack Pro","quantite":50,"budget":12000}). {} si rien.',
  '- action_suggestion : action commerciale suggérée : "creer_devis" | "rappeler" | "relancer" | "escalader" | "aucune".',
  '- confidence : nombre entre 0 et 1 (ta confiance dans l\'analyse).',
  '- justification : une phrase courte qui justifie l\'action (ce que lirait un commercial pour décider).',
  // Résumé et justification répondent à deux questions : dit au modèle, sinon il rend deux fois la même phrase.
  '- summary : 2 à 3 phrases sur CE QUI S\'EST DIT (la demande du client, ce qui lui a été répondu, où en est',
  '  la conversation). C\'est un compte rendu, pas une justification : n\'y répète pas le champ justification.',
  // Volontairement étroit : un client mécontent, même sec, n'est pas injurieux, et le signaler noierait la liste.
  '- abusive : true UNIQUEMENT si le client insulte ou agresse verbalement l\'entreprise ou ses employés',
  '  (grossièretés dirigées, menaces, propos haineux). Un simple mécontentement, même vif, reste false.',
  // Deux entiers comparables entre conversations (les axes d'un nuage de points). Les extrémités sont répétées au
  // modèle : une échelle sans ses bornes se lit dans les deux sens, et le nuage basculerait en silence.
  `- satisfaction : entier de ${NOTE_MIN} à ${NOTE_MAX}. ${NOTE_MIN} = client très mécontent, ${NOTE_MAX} = client très satisfait.`,
  `- urgence : entier de ${NOTE_MIN} à ${NOTE_MAX}. ${NOTE_MIN} = aucune attente particulière, ${NOTE_MAX} = le client attend une réponse immédiate.`,
  '  Ces deux notes portent sur le CLIENT, pas sur la qualité de la réponse de l\'entreprise.',
].join('\n');

/** Construit le prompt (system + user) pour le LLM à partir du transcript. */
export function buildPrompt(transcript: string): { system: string; user: string } {
  return { system: SYSTEM_INSTRUCTIONS, user: `Conversation :\n${transcript}\n\nRenvoie l'objet JSON d'analyse.` };
}

/**
 * Parse la sortie brute du LLM en LlmOutput validé, ou null. Tolère un préambule et des balises ```json (on isole du
 * premier `{` au dernier `}`), puis JSON.parse et Zod, sans jamais lever.
 */
export function parseLlmOutput(raw: string): LlmOutput | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = llmOutputSchema.safeParse(obj);
  return parsed.success ? parsed.data : null;
}
