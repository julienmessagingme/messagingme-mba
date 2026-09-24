import { llmOutputSchema, INTENTS, NOTE_MIN, NOTE_MAX, type Intent, type LlmOutput, type HandledBy } from './schema';

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

/**
 * CE QUE VEUT DIRE CHAQUE INTENTION, TEL QU'ON LE DIT AU MODÈLE.
 *
 * 🔴 UN `Record<Intent, string>`, ET C'EST LA GARDE : une valeur ajoutée à `INTENTS` sans sa description ne
 * compile pas. Une intention que le schéma accepte mais que le prompt ne propose pas ne serait jamais rendue,
 * et l'écran montrerait une barre toujours vide sans que rien ne dise pourquoi.
 *
 * ⚠️ ÉCRITES POUR SÉPARER LES VOISINES (spec du 2026-09-24, § 7) : `achat` contre `demande_devis`,
 * `suivi_commande` contre `reclamation`, `retour` contre `sav`. Sans ces frontières, le modèle placerait la
 * limite différemment d'une conversation à l'autre, et la répartition ne voudrait plus rien dire.
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
  // La liste ET ses descriptions sont DÉRIVÉES de `INTENTS` : écrites à la main ici, elles feraient une copie
  // de plus, et c'est celle qu'on oublie qui fait qu'une intention n'est jamais proposée au modèle.
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
  // Le résumé et la justification répondent à deux questions différentes, et le prompt doit le dire, sinon
  // le modèle rend deux fois la même phrase et la fiche de conversation n'apprend rien de plus que le tableau.
  '- summary : 2 à 3 phrases sur CE QUI S\'EST DIT (la demande du client, ce qui lui a été répondu, où en est',
  '  la conversation). C\'est un compte rendu, pas une justification : n\'y répète pas le champ justification.',
  // Volontairement ÉTROIT : insultes et agressivité VISANT l'entreprise. Un client mécontent, même très sec,
  // n'est pas injurieux, et le signaler noierait la liste sous des réclamations ordinaires, ce qui revient à
  // ne plus la lire du tout.
  '- abusive : true UNIQUEMENT si le client insulte ou agresse verbalement l\'entreprise ou ses employés',
  '  (grossièretés dirigées, menaces, propos haineux). Un simple mécontentement, même vif, reste false.',
  // Deux ENTIERS et non deux adjectifs : ces deux notes sont les axes d'un nuage de points, donc elles
  // doivent se comparer entre conversations. Les bornes sont RÉPÉTÉES au modèle (0 = ..., 10 = ...) parce
  // qu'une échelle sans ses extrémités se lit dans les deux sens : « 0 » voudrait dire « aucune urgence »
  // pour l'un et « urgence maximale » pour l'autre, et le nuage entier basculerait sans rien signaler.
  `- satisfaction : entier de ${NOTE_MIN} à ${NOTE_MAX}. ${NOTE_MIN} = client très mécontent, ${NOTE_MAX} = client très satisfait.`,
  `- urgence : entier de ${NOTE_MIN} à ${NOTE_MAX}. ${NOTE_MIN} = aucune attente particulière, ${NOTE_MAX} = le client attend une réponse immédiate.`,
  '  Ces deux notes portent sur le CLIENT, pas sur la qualité de la réponse de l\'entreprise.',
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
