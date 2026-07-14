import { llmOutputSchema, type LlmOutput, type HandledBy } from './schema';

/** Un message de conversation, forme minimale utilisée par l'analyse (pur, agnostique du stockage). */
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
  /** Envoi automatisé détecté (campagne / workflow) pour ce contact. */
  hasAutomated: boolean;
}

/**
 * Qui a tenu la conversation. Humain si un agent a répondu depuis l'inbox ; sinon 'automatise' (campagne/workflow,
 * OU inbound jamais traité -> défaut le moins faux, l'enum n'a que ces 3 valeurs). 'mba' (agent LLM autonome) est
 * réservé : inatteignable tant que le MBA n'est pas ouvert (bloqué ToS). NB : c'est une heuristique, pas une garantie.
 */
export function deduceHandledBy(s: HandledBySignals): HandledBy {
  if (s.hasHumanOutbound) return 'humain';
  return 'automatise';
}

/** Nombre d'échanges = nombre de tours du client (messages entrants). Proxy de friction (long = frottement). */
export function countExchanges(messages: AnalysisMessage[]): number {
  return messages.filter((m) => m.direction === 'in').length;
}

/**
 * Rend un transcript lisible "Client:/Agent:" chronologique, borné en caractères. Si trop long, on garde la FIN
 * (l'épisode récent porte le sentiment/intent), avec un marqueur de troncature en tête.
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

const SYSTEM_INSTRUCTIONS = [
  'Tu es un analyste de conversations WhatsApp (support et commercial).',
  'Analyse la conversation et renvoie UNIQUEMENT un objet JSON valide, sans texte autour, sans balises de code.',
  'Champs attendus :',
  '- sentiment : "positif" | "neutre" | "negatif" (ressenti global du client).',
  '- intent : "demande_devis" | "sav" | "reclamation" | "information" | "prise_rdv" | "autre".',
  '- topic : le sujet en 2 à 5 mots (français), ex. "retard de livraison".',
  '- resolved : true si la demande du client est résolue, false sinon.',
  '- entities : objet des infos utiles extraites (ex. {"produit":"Pack Pro","quantite":50,"budget":12000}). {} si rien.',
  '- action_suggestion : action commerciale suggérée : "creer_devis" | "rappeler" | "relancer" | "escalader" | "aucune".',
  '- confidence : nombre entre 0 et 1 (ta confiance dans l\'analyse).',
  '- justification : une phrase courte qui justifie l\'action (ce que lirait un commercial pour décider).',
].join('\n');

/** Construit le prompt (system + user) pour le LLM à partir du transcript. */
export function buildPrompt(transcript: string): { system: string; user: string } {
  return { system: SYSTEM_INSTRUCTIONS, user: `Conversation :\n${transcript}\n\nRenvoie l'objet JSON d'analyse.` };
}

/**
 * Parse la sortie brute du LLM en LlmOutput validé, ou null si invalide. Tolère un préambule / des balises ```json
 * (on isole le 1er objet JSON du 1er `{` au dernier `}`), puis JSON.parse + validation Zod (aucun throw).
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
