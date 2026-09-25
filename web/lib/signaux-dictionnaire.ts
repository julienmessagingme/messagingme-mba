/**
 * LE DICTIONNAIRE DES SIGNAUX, TEL QUE LA DOCUMENTATION API LE PRÉSENTE (spec 2026-09-24, § 8).
 *
 * 🔴 PARITÉ : les noms d'événements, d'attributs ET de champs sont ceux de `src/signaux/types.ts`, ni plus ni
 * moins (`tests/web-signaux-parite.test.ts`). Un signal ou un champ ajouté côté serveur sans être documenté ici
 * fait échouer ce test. ⚠️ Le module ne les IMPORTE pas : la console est un projet séparé, qui n'importe rien de
 * `src/`. Le test est ce qui tient les deux listes d'accord.
 *
 * 🔴 AUCUN OUTIL TIERS NOMMÉ (demande de Julien du 2026-09-24) : ce texte sert à tout intégrateur, quel que soit
 * l'outil qu'il branche. Le même test le vérifie.
 */
export interface EntreeEvenement {
  nom: string;
  quand: readonly [string, string];
  /** Les noms des champs de l'événement, tels qu'ils partent : la liste EXACTE du dictionnaire, dans son ordre. */
  champs: readonly string[];
  /** Ce qu'il faut savoir de plus, en une phrase. */
  note: readonly [string, string];
}
export interface EntreeAttribut {
  nom: string;
  sens: readonly [string, string];
}

/** L'identifiant stable que porte CHAQUE événement, en plus de ses champs. */
export const CHAMP_ID_DOC = 'em_event_id';

/** Réponses, clics, désabonnements et analyses passent DEVANT les accusés dans la file. */
const PRIORITAIRE = ['Dans la minute, en priorité', 'Within a minute, with priority'] as const;
const ACCUSE = [
  'Dans la minute ; en retard derrière une grosse campagne',
  'Within a minute; delayed behind a large campaign',
] as const;

export const EVENEMENTS_SIGNAUX: readonly EntreeEvenement[] = [
  {
    nom: 'em_message_delivered', quand: ACCUSE, champs: ['canal', 'origine', 'send_id'],
    note: [
      'send_id : l’envoi (sendId) auquel le message appartient, seulement s’il appartient à un envoi',
      'send_id: the send (sendId) the message belongs to, only when it belongs to one',
    ],
  },
  {
    nom: 'em_message_read', quand: ACCUSE, champs: ['canal', 'origine', 'send_id'],
    note: ['Mêmes champs que la livraison', 'Same fields as delivery'],
  },
  {
    nom: 'em_message_failed', quand: ACCUSE, champs: ['canal', 'origine', 'send_id', 'motif', 'code_meta'],
    note: [
      'motif : la raison de l’échec, quand elle est connue. code_meta : le code d’erreur de Meta, pour un message WhatsApp',
      'motif: the failure reason, when known. code_meta: Meta’s error code, for a WhatsApp message',
    ],
  },
  {
    nom: 'em_replied', quand: PRIORITAIRE, champs: ['canal', 'bouton'],
    note: [
      'bouton : le libellé du bouton tapé. Jamais le texte du message. Une réaction (emoji) n’est pas une réponse.',
      'bouton: the label of the tapped button. Never the message text. A reaction (emoji) is not a reply.',
    ],
  },
  {
    nom: 'em_link_clicked', quand: PRIORITAIRE, champs: ['lien', 'template', 'destination'],
    note: [
      'lien : le code du lien suivi. Seulement quand le clic est attribué à une fiche ; un clic automatique (aperçu, robot) ne compte pas. destination : l’adresse vers laquelle le lien mène, absente au-delà de 300 caractères (une adresse coupée serait fausse).',
      'lien: the tracked link code. Only when the click is attributed to a contact; an automatic click (preview, bot) does not count. destination: the address the link leads to, absent beyond 300 characters (a cut address would be wrong).',
    ],
  },
  {
    nom: 'em_opted_out', quand: PRIORITAIRE, champs: ['canal', 'source'],
    note: [
      'canal : seulement quand la personne a écrit STOP sur ce canal ; absent pour un désabonnement posé par votre équipe ou par l’API. source : d’où vient le refus (whatsapp_stop, rcs_stop, crm, api…).',
      'canal: only when the person wrote STOP on that channel; absent for an unsubscribe set by your team or through the API. source: where the refusal comes from (whatsapp_stop, rcs_stop, crm, api…).',
    ],
  },
  {
    nom: 'em_conversation_analyzed',
    quand: ['À la fin d’une conversation', 'At the end of a conversation'],
    champs: [
      'intent', 'sentiment', 'satisfaction', 'urgence', 'resolved', 'topic', 'action_suggestion', 'handled_by',
      'exchanges_count', 'summary_1', 'summary_2', 'summary_3',
    ],
    note: [
      'summary_1 à summary_3 : le résumé, seulement si l’option est activée, en morceaux de 300 caractères au plus, à recoller bout à bout sans séparateur (les derniers sont absents quand il est court).',
      'summary_1 to summary_3: the summary, only when the option is on, in chunks of at most 300 characters, to join end to end with no separator (the last ones are absent when it is short).',
    ],
  },
  {
    nom: 'em_risk_changed',
    quand: ['Chaque nuit, quand le niveau change', 'Every night, when the level changes'],
    champs: ['niveau', 'ancien_niveau', 'score', 'raisons'],
    note: [
      'niveau et ancien_niveau : inconnu, faible, moyen ou eleve. raisons : jusqu’à trois codes séparés par des virgules (silence_60j, silence_30j, sans_reponse, non_lu, reclamation, negatif, insatisfait, injoignable, stop, bloque).',
      'niveau and ancien_niveau: inconnu, faible, moyen or eleve. raisons: up to three codes separated by commas (silence_60j, silence_30j, sans_reponse, non_lu, reclamation, negatif, insatisfait, injoignable, stop, bloque).',
    ],
  },
];

export const ATTRIBUTS_SIGNAUX: readonly EntreeAttribut[] = [
  { nom: 'em_contact_id', sens: ['Notre identifiant de fiche (contactId), pour nous renvoyer la fiche sans ambiguïté', 'Our contact id (contactId), to send the contact back to us unambiguously'] },
  { nom: 'em_last_intent', sens: ['L’intention de la dernière conversation analysée (mêmes valeurs que l’écran d’analyse)', 'The intent of the last analysed conversation (same values as the analysis screen)'] },
  { nom: 'em_last_sentiment', sens: ['Le sentiment de la dernière conversation analysée', 'The sentiment of the last analysed conversation'] },
  { nom: 'em_satisfaction', sens: ['La satisfaction, de 0 à 10. Absente d’une analyse, elle n’écrase pas la précédente', 'Satisfaction, from 0 to 10. Missing from an analysis, it does not overwrite the previous one'] },
  { nom: 'em_urgency', sens: ['L’urgence, de 0 à 10, même règle', 'Urgency, from 0 to 10, same rule'] },
  { nom: 'em_last_resolved', sens: ['La dernière conversation analysée est-elle résolue ?', 'Is the last analysed conversation resolved?'] },
  { nom: 'em_last_reply_at', sens: ['La date de la dernière réponse du contact', 'The date of the contact’s last reply'] },
  { nom: 'em_whatsapp_optout', sens: ['Le contact est-il désabonné ?', 'Has the contact unsubscribed?'] },
  { nom: 'em_rcs_optout', sens: ['A-t-il dit STOP sur le canal RCS ?', 'Did they say STOP on the RCS channel?'] },
  { nom: 'em_rcs_reachable', sens: ['Le dernier message RCS lui a-t-il été délivré ?', 'Was the last RCS message delivered to them?'] },
  { nom: 'em_risk_level', sens: ['Le risque de désengagement : inconnu, faible, moyen ou eleve, recalculé chaque nuit', 'The disengagement risk: inconnu, faible, moyen or eleve, recomputed every night'] },
  { nom: 'em_risk_score', sens: ['Le score de risque, de 0 à 100 (absent quand le niveau est inconnu)', 'The risk score, from 0 to 100 (absent when the level is inconnu)'] },
  { nom: 'em_risk_reasons', sens: ['Les raisons principales du niveau, jusqu’à trois codes séparés par des virgules', 'The main reasons for the level, up to three codes separated by commas'] },
];
