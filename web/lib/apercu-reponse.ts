// ⚠️ IMPORTS RELATIFS, PAS L'ALIAS `@/`. Ce module est une lib PURE : il est chargé par vitest (ici et
// depuis la suite racine, qui importe `../web/lib/...`), où l'alias de Next n'est pas résolu.
import { entryNodeOf, envoieVraiment, type GraphLike } from './campaign-eligibility';
import { boutonsDe } from './mesures-scenario';

/**
 * CE QUE LE PROSPECT RECEVRA EN RÉPONSE, pour l'aperçu d'une publicité Click-to-WhatsApp.
 *
 * 🔴 LES DEUX DESTINATIONS NE SE CONNAISSENT PAS DE LA MÊME FAÇON, ET L'ÉCRAN DOIT LE DIRE.
 * Un SCÉNARIO est déterministe : son premier message est lisible dans le graphe publié, donc on montre le
 * VRAI texte. L'agent de Meta COMPOSE sa réponse : aucune lecture ne peut la prédire, donc on montre une
 * illustration, et elle est marquée comme telle à l'écran. Montrer un exemple sans le dire ferait croire au
 * client qu'il a validé des mots qui ne partiront jamais ; ne rien montrer du tout le priverait de l'allure
 * de l'enchaînement, qui est justement ce qu'il vient vérifier.
 *
 * 🔴 ON LIT LE GRAPHE PUBLIÉ, JAMAIS LE BROUILLON. Un lead publicitaire parcourt ce qui est EN LIGNE
 * (`WorkflowSummary.graph`), pas ce qui est en cours d'édition (`draftGraph`). Prendre le brouillon
 * montrerait un message que personne ne recevra tant que le scénario n'est pas republié.
 *
 * ⚠️ LE PARCOURS S'ARRÊTE DÈS QU'IL DEVIENT INDÉCIDABLE, et il le dit. Un `condition` dépend du contact,
 * qui n'existe pas encore ; une sortie multiple aussi. Deviner une branche produirait un aperçu faux la
 * moitié du temps, ce qui est pire qu'un aperçu qui avoue. On ne traverse donc que les blocs qui n'envoient
 * rien ET n'ont qu'une seule sortie libre, exactement comme le moteur le ferait sans donnée de contact.
 */

/** Les blocs dont le CORPS est un texte WhatsApp affichable tel quel. */
const BLOCS_TEXTE = new Set(['quick_message', 'question']);

export type ReponsePrevue =
  /** Le premier message part vraiment, et on en connaît le texte. */
  | { genre: 'message'; texte: string; boutons: string[] }
  /** Un modèle approuvé : la console n'en a que le nom, son texte vit chez Meta. */
  | { genre: 'modele'; nom: string | null }
  /** Un formulaire WhatsApp : il s'ouvre chez le prospect, il n'a pas de corps à montrer. */
  | { genre: 'formulaire' }
  /** Un agent IA maison : comme l'agent de Meta, il compose. */
  | { genre: 'agent_ia' }
  /** Le premier envoi n'est pas un message WhatsApp (RCS, e-mail). */
  | { genre: 'autre_canal'; type: string }
  /** Le parcours bute sur un embranchement avant d'avoir envoyé quoi que ce soit. */
  | { genre: 'indecidable'; type: string }
  /** Le scénario ne contient aucun envoi atteignable depuis son entrée. */
  | { genre: 'aucun_envoi' }
  /** Graphe vide : rien n'est publié. */
  | { genre: 'vide' };

export function premiereReponse(graph: GraphLike): ReponsePrevue {
  const entree = entryNodeOf(graph);
  if (entree === null) return { genre: 'vide' };

  const parId = new Map(graph.nodes.map((n) => [n.id, n]));
  const vus = new Set<string>();
  let id: string = entree.id;

  for (;;) {
    // ⚠️ GARDE DE BOUCLE. Un scénario peut boucler sur lui-même (l'éditeur le permet, et
    // `mesures-scenario` porte déjà un cas de test pour ça) : sans elle, l'aperçu figerait l'onglet.
    if (vus.has(id)) return { genre: 'aucun_envoi' };
    vus.add(id);

    const node = parId.get(id);
    if (node === undefined) return { genre: 'aucun_envoi' };

    if (node.type === 'template') {
      const nom = String(node.data.templateName ?? '').trim();
      return { genre: 'modele', nom: nom === '' ? null : nom };
    }
    if (node.type === 'rcs_message' || node.type === 'email') {
      return { genre: 'autre_canal', type: node.type };
    }
    // 🔴 `envoieVraiment` DÉCIDE, ET C'EST LE MIROIR DU MOTEUR : un bloc non configuré est un PASSE-PLAT,
    // le parcours continue au lieu de s'y arrêter. Une copie de cette règle ici divergerait le jour où le
    // moteur bouge ; elle est donc importée, pas récrite.
    if (BLOCS_TEXTE.has(node.type) && envoieVraiment(node)) {
      // ⚠️ `boutonsDe` EST IMPORTÉ, ET C'EST UN PIÈGE ÉVITÉ. Les lignes d'un bloc QUESTION portent leur
      // libellé dans `title`, les réponses rapides dans `text` : une lecture uniforme afficherait des
      // boutons vides sur la moitié des scénarios. La bonne version existait déjà.
      return {
        genre: 'message',
        texte: String(node.data.body ?? '').trim(),
        boutons: boutonsDe(node).map((b) => b.texte.trim()).filter((s) => s !== ''),
      };
    }
    if (node.type === 'flow' && envoieVraiment(node)) return { genre: 'formulaire' };
    if (node.type === 'agent' && envoieVraiment(node)) return { genre: 'agent_ia' };
    if (node.type === 'condition') return { genre: 'indecidable', type: node.type };

    const sorties = graph.edges.filter((e) => e.source === id);
    // Zéro sortie : le parcours s'arrête sans avoir rien envoyé. Plusieurs sorties, ou une sortie TYPÉE
    // (`sourceHandle`), veulent dire que le chemin dépend de quelque chose qu'on n'a pas.
    if (sorties.length === 0) return { genre: 'aucun_envoi' };
    const seule = sorties[0];
    if (sorties.length > 1 || seule === undefined || seule.sourceHandle) {
      return { genre: 'indecidable', type: node.type };
    }
    id = seule.target;
  }
}
