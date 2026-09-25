import type { WorkflowNodeType } from './api';
import type { NomIcone } from './icones';

// Métadonnées d'affichage des types de node (blocs). Les libellés portent les DEUX langues ([fr, en]) :
// c'est une constante module (useT inappelable ici), résolue au rendu via t(...meta.label). Partagé par
// le builder de scénario et la page Contenu > Blocs (source unique, pas de duplication).
export const NODE_META: Record<WorkflowNodeType, { icone: NomIcone; label: [string, string] }> = {
  template: { icone: 'envoi', label: ['Envoi template', 'Send template'] },
  quick_message: { icone: 'automation', label: ['Message rapide', 'Quick message'] },
  // Ce bloc EST l'« assigner à un agent » : il passe le fil à un humain et le fait apparaître dans
  // « À traiter ». Il s'appelait « Inbox », un nom de destination qui ne disait pas ce qu'il FAIT.
  inbox: { icone: 'humain', label: ['Assigner à un agent', 'Assign to an agent'] },
  flow: { icone: 'formulaire', label: ['Formulaire', 'Form'] },
  question: { icone: 'question', label: ['Question', 'Question'] },
  tag: { icone: 'etiquette', label: ['Ajout de tag', 'Add tag'] }, // legacy : plus dans la palette, gardé pour le rendu des anciens blocs
  field: { icone: 'modifier', label: ['Ajout de champ', 'Add field'] }, // legacy : idem
  condition: { icone: 'condition', label: ['Condition', 'Condition'] },
  wait: { icone: 'attente', label: ['Attente', 'Wait'] },
  action: { icone: 'reglages', label: ['Action', 'Action'] },
  rcs_message: { icone: 'mobile', label: ['Message RCS', 'RCS message'] },
  email: { icone: 'email', label: ['Envoi de mail', 'Send email'] },
  agent: { icone: 'robot', label: ['Agent IA', 'AI agent'] },
  // Il ne DÉCRIT aucun appel, il en DÉSIGNE un, mis au point dans Tools > Connecteurs API. Le nom dit donc
  // « appel », pas « HTTP » : le client a branché un système, il ne code pas une requête.
  http: { icone: 'outils', label: ['Appel API', 'API call'] },
  // « Fonction » et non « JavaScript » : ce que le client fait, c'est transformer une valeur. Le langage est
  // un détail de l'écran, pas le sujet du bloc.
  js: { icone: 'fonction', label: ['Fonction JS', 'JS function'] },
  // Blocs RETIRÉS du produit. Ces entrées ne servent plus qu'à RENDRE lisiblement un ancien scénario qui en
  // contient encore : ils ne sont plus dans la palette, et le moteur les traverse sans rien faire.
  mba_handoff: { icone: 'supprimer', label: ['Bloc MBA (retiré)', 'MBA block (removed)'] },
  mba_disable: { icone: 'supprimer', label: ['Bloc MBA (retiré)', 'MBA block (removed)'] },
};

// La palette ne propose plus `tag`/`field` séparés : le bloc « Action » les regroupe (ajouter/retirer tag, màj/vider champ).
// `question` est dans la liste NORMALE, pas dans une quatrieme liste gatee : rien ne le conditionne, il
// part sur le numero WhatsApp deja rattache. Une liste de plus aurait demande de mettre a jour ses TROIS
// lecteurs (palette, menu du fil, puces de Contenu > Blocs), la derive exacte du commit c1b8441.
export const NODE_ORDER: WorkflowNodeType[] = ['template', 'quick_message', 'question', 'flow', 'action', 'condition', 'wait', 'inbox', 'js'];

// Bloc RCS : présenté à part et GRISÉ tant que le tenant n'a pas d'agent RCS rattaché. Même doctrine que les
// blocs MBA. Le canal est construit de bout en bout, mais un agent doit être déposé et approuvé par Google et
// les opérateurs avant qu'un seul message puisse partir : proposer le bloc avant, c'est promettre un envoi qui
// finirait en erreur.
export const RCS_NODE_ORDER: WorkflowNodeType[] = ['rcs_message'];

// Bloc Email : présenté à part et GRISÉ tant qu'aucune boîte SMTP n'est connectée (Compte > Boîtes email).
// Même doctrine que RCS_NODE_ORDER : le bloc se prépare, mais ne peut rien envoyer sans boîte derrière.
export const EMAIL_NODE_ORDER: WorkflowNodeType[] = ['email'];

// Bloc Agent IA : présenté à part et GRISÉ tant que le workspace n'a AUCUN agent actif. Même doctrine que
// les deux ci-dessus : un bloc agent sans agent derrière ne peut pas tenir une conversation, et le proposer
// promettrait une réponse qui ne viendrait jamais.
export const AGENT_NODE_ORDER: WorkflowNodeType[] = ['agent'];

// Bloc « Appel API » : présenté à part et GRISÉ tant qu'aucun appel n'est déclaré dans Tools > Connecteurs
// API. Même doctrine que RCS, Email et Agent IA : un bloc qui ne pourrait désigner aucun appel promettrait un
// aller-retour qui n'aurait jamais lieu.
export const HTTP_NODE_ORDER: WorkflowNodeType[] = ['http'];

// Bloc « Fonction JS » : il ne dépend d'AUCUN branchement (ni connecteur, ni boîte mail, ni agent), donc il
// est dans la liste normale. Sa seule condition est d'avoir un champ à transformer, et un espace sans champ
// personnalisé le verra dans la palette avec deux sélecteurs vides, ce qui se comprend tout seul.

export const HTTP_GATE_TITRE: [string, string] = [
  'Disponible quand vous aurez déclaré un appel dans Tools > Connecteurs API',
  'Available once you declare a call in Tools > API connectors',
];

/** Nombre maximal de destinataires d'un bloc « Envoi de mail ». ⚠️ MIROIR de MAX_DESTINATAIRES_EMAIL
 *  (src/workflow/engine.ts), qui fait AUTORITÉ : c'est lui qui tronque, le bouton « + » n'est qu'un confort.
 *  La valeur est recopiée plutôt qu'importée pour ne pas tirer du code serveur dans le bundle client ;
 *  `tests/web-email-recipients-parity.test.ts` casse dès que les deux divergent. */
export const MAX_DESTINATAIRES_EMAIL = 3;

// Infobulles des deux blocs GATÉS, définies ICI parce qu'elles sont affichées à DEUX endroits : la palette et
// le menu qui s'ouvre quand on tire un fil. Les recopier d'un côté à l'autre est exactement la faute qui a
// rendu ces deux blocs inatteignables au fil (la palette a été mise à jour, le menu oublié).
export const RCS_GATE_TITRE: [string, string] = [
  'Disponible quand votre agent RCS sera déposé et validé',
  'Available once your RCS agent is filed and approved',
];
export const EMAIL_GATE_TITRE: [string, string] = [
  'Disponible dès qu’une boîte email est connectée (menu Compte > Boîtes email)',
  'Available once an email mailbox is connected (Account menu > Email accounts)',
];
export const AGENT_GATE_TITRE: [string, string] = [
  'Disponible dès qu’un agent IA est actif (menu AI Agent)',
  'Available once an AI agent is active (AI Agent menu)',
];

/**
 * Les sorties que la PLATEFORME pose elle-même sur un bloc agent, toujours présentes, par opposition aux
 * règles d'arrêt que le client déclare sur la fiche de son agent.
 *
 * ⚠️ MIROIR de `src/agent/sorties.ts` et du handle `timeout` du bloc Question. Les codes sont recopiés
 * plutôt qu'importés pour ne pas tirer du code serveur dans le bundle client, comme
 * `MAX_DESTINATAIRES_EMAIL` ci-dessus ; `tests/web-agent-sorties-parity.test.ts` casse dès qu'ils divergent.
 *
 * `timeout` n'a PAS de préfixe `sortie:`, et c'est voulu : c'est le même handle que le bloc Question, pour
 * qu'il n'y ait qu'un seul vocabulaire dans le builder.
 */
export const AGENT_SORTIES_RESERVEES: Array<{ handle: string; icone: NomIcone; label: [string, string]; aide: [string, string] }> = [
  {
    handle: 'timeout',
    icone: 'chrono',
    label: ['Pas de réponse', 'No reply'],
    aide: ['Le contact ne répond plus depuis le délai réglé sur la fiche', 'The contact has gone silent for the delay set on the agent'],
  },
  {
    handle: 'sortie:sans_source',
    icone: 'connaissance',
    label: ['Aucune source', 'No source'],
    aide: [
      'L’agent n’a rien trouvé dans sa base de connaissance : brancher un humain ou vos coordonnées',
      'The agent found nothing in its knowledge base: connect a human or your contact details',
    ],
  },
  {
    handle: 'sortie:humain',
    icone: 'humain',
    label: ['Transfert à un humain', 'Handed to a human'],
    aide: [
      'L’agent a passé la main : brancher ce qui doit suivre (message d’attente, tag, fin de parcours)',
      'The agent handed over: connect what should follow (waiting message, tag, end of journey)',
    ],
  },
  {
    handle: 'sortie:plafond',
    icone: 'refuse',
    label: ['Plafond atteint', 'Cap reached'],
    aide: ['Tours, appels d’outils ou budget épuisés', 'Turns, tool calls or budget exhausted'],
  },
  {
    // Pas de ⚠ ici : c'est déjà le glyphe de la pastille « ne mène nulle part », qui s'affiche sur la même
    // carte. Deux sens pour un même signe à trois lignes d'écart se lisent mal.
    handle: 'sortie:echec',
    icone: 'echec',
    label: ['Échec technique', 'Technical failure'],
    aide: ['Le modèle ou un envoi a échoué : prévoir un repli', 'The model or a send failed: plan a fallback'],
  },
];


/** Repli pour un type de node NON encore connu du front (ex. un type ajouté côté backend avant son UI, comme
 *  `condition` en attendant la Phase 3). Évite un crash de rendu (`NODE_META[type].icone` sur `undefined`) qui
 *  démonterait toute la page builder / « Contenu > Blocs ». */
const UNKNOWN_NODE_META: { icone: NomIcone; label: [string, string] } = { icone: 'bloc', label: ['Bloc', 'Block'] };

/** Métadonnées d'un type de node, TOLÉRANT un type inconnu (renvoie un repli neutre au lieu de `undefined`). À
 *  utiliser partout où le type provient de données de graphe (potentiellement en avance sur le front). */
export function nodeMetaOf(type: string): { icone: NomIcone; label: [string, string] } {
  return (NODE_META as Record<string, { icone: NomIcone; label: [string, string] }>)[type] ?? UNKNOWN_NODE_META;
}
