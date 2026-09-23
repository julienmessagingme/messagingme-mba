import type { GestePublication } from './api-agent-tools';
import type { OutilMbaVue, TypeOutilMba } from './api-mba-outils';
import { normaliserCodeSortie } from './agent-sorties';

/**
 * LES AIDES PURES DE L'ONGLET « OUTILS » DE L'AGENT DE META (spec 2026-09-21-outils-maison-mba, § 9).
 */
export type EtatChezMeta = 'chez_meta' | 'a_envoyer' | 'inconnu' | 'desactive' | 'desactive_a_retirer' | 'hors_meta';

/**
 * L'état de chaque ligne, calculé par le PLAN de publication, jamais par un drapeau tenu à part (§ 9.2).
 *
 * 🔴 Un connecteur à renvoyer (clé révoquée, adresse changée) rend TOUTES les lignes « À envoyer » : tous les
 * outils en dépendent, et sans ça aucun bouton ne permettrait de le réparer.
 * 🔴 Un outil DÉSACTIVÉ n'est jamais « Chez Meta » (plan, écart 4). ⚠️ Mais il y reste LISTÉ jusqu'au prochain
 * envoi, rien ne republiant au départ d'un collaborateur : tant que le plan porte son effacement, la ligne le dit
 * (`desactive_a_retirer`) et propose l'envoi.
 * 🔴 Un outil qui ne peut pas partir chez Meta (`publiable` faux : appel supprimé, outil illisible) n'y est jamais
 * « ✓ » : « À envoyer » si Meta le liste encore (l'envoi l'en retire), « Pas chez Meta » sinon.
 */
export function etatsChezMeta(
  outils: readonly OutilMbaVue[], gestes: readonly GestePublication[] | null,
): Map<string, EtatChezMeta> {
  const etats = new Map<string, EtatChezMeta>();
  const connecteur = gestes !== null && gestes.some((g) => g.type === 'connecteur_creer' || g.type === 'connecteur_modifier');
  const aEcrire = new Set((gestes ?? []).filter((g) => g.type === 'outil_creer' || g.type === 'outil_modifier').map((g) => g.nom));
  const aRetirer = new Set((gestes ?? []).filter((g) => g.type === 'outil_supprimer').map((g) => g.nom));
  for (const o of outils) {
    if (!o.actif) etats.set(o.id, aRetirer.has(o.name) ? 'desactive_a_retirer' : 'desactive');
    else if (gestes === null) etats.set(o.id, 'inconnu');
    else if (!o.publiable) etats.set(o.id, aRetirer.has(o.name) ? 'a_envoyer' : 'hors_meta');
    else etats.set(o.id, connecteur || aEcrire.has(o.name) ? 'a_envoyer' : 'chez_meta');
  }
  return etats;
}

/**
 * Les outils que la prochaine publication EFFACERAIT chez Meta et qui n'ont pas de ligne ici. 🔴 Ce ne sont PAS
 * seulement des outils supprimés ici : `planifierPublication` efface aussi ceux d'un ancien connecteur et ceux
 * qu'on a ajoutés À LA MAIN chez Meta. L'écran les dit donc « encore chez Meta, sans outil ici », jamais
 * « supprimés ici », et seul ce qu'on a supprimé dans la session part sans confirmation : tout autre effacement
 * se fait confirmer en le nommant (spec § 9.2 ; relecture du 2026-09-22, qui a trouvé la version précédente
 * capable d'effacer sans rien demander un outil que l'utilisateur venait de refuser d'effacer).
 */
export function chezMetaSansLigne(outils: readonly OutilMbaVue[], gestes: readonly GestePublication[] | null): string[] {
  if (gestes === null) return [];
  const noms = new Set(outils.map((o) => o.name));
  return gestes.filter((g) => g.type === 'outil_supprimer' && !noms.has(g.nom)).map((g) => g.nom);
}

/**
 * Les méthodes d'appel que le serveur range en `irreversible` (`risqueSelonMethode`, `src/agent/http-cible.ts`),
 * tenues égales par `tests/mba-outils-parite.test.ts`.
 */
export const METHODES_IRREVERSIBLES: readonly string[] = ['DELETE'];

/** Les valeurs permises saisies une par ligne : les vides et les doublons partent, l'ordre de saisie reste. */
export function valeursPermises(texte: string): string[] {
  return [...new Set(texte.split('\n').map((v) => v.trim()).filter((v) => v !== ''))];
}

/**
 * Les bornes de la route (`BORNES_OUTIL_MBA`, `src/http/mba-outils.ts`), appliquées AVANT l'envoi pour dire ce
 * qui manque au lieu d'un 400. `tests/mba-outils-parite.test.ts` tient les deux listes égales.
 */
export const BORNES_OUTIL = { titre: 120, texte: 2000, tag: 64, champ: 64, valeur: 120, valeurs: 50 } as const;

/**
 * Le connecteur unique d'Engage Me chez Meta. Recopie de `NOM_CONNECTEUR_RELAIS` (`src/mba/publication.ts`),
 * tenue égale par `tests/mba-outils-parite.test.ts`.
 */
export const CONNECTEUR_RELAIS = 'EngageMe';

/**
 * Les effacements chez Meta que le geste en cours n'a pas demandés : eux seuls se font confirmer.
 *
 * 🔴 LES OUTILS ET LES CONNECTEURS NE SE CONFONDENT PAS (relecture du 2026-09-22). `outilsAttendus` ne dispense
 * que des OUTILS ; seul le connecteur `EngageMe` (le nôtre, qui part quand plus aucun outil n'est exposé) est
 * toujours attendu. Une seule liste de noms faisait passer sans question un outil ajouté à la main chez Meta
 * sous le nom `EngageMe`, et tout ancien connecteur qu'on y aurait nommé.
 */
export function effacementsImprevus(gestes: readonly GestePublication[], outilsAttendus: ReadonlySet<string>): GestePublication[] {
  return gestes.filter((g) =>
    (g.type === 'outil_supprimer' && !outilsAttendus.has(g.nom))
    || (g.type === 'connecteur_supprimer' && g.nom !== CONNECTEUR_RELAIS));
}

/** Le nom vu par l'agent de Meta, calculé depuis le titre (même règle que les codes de sortie). */
export function nomTechniqueDepuisTitre(titre: string): string {
  return normaliserCodeSortie(titre);
}

/** Le trou laissé dans une consigne pré-remplie : tant qu'il est là, la consigne n'est pas écrite. */
export const PLACEHOLDER = '[décrivez la situation]';
const PLACEHOLDER_EN = '[describe the situation]';

export function consigneIncomplete(texte: string): boolean {
  return texte.includes(PLACEHOLDER) || texte.includes(PLACEHOLDER_EN);
}

type Bilingue = readonly [string, string];

interface TextesType { titre: Bilingue; badge: Bilingue; aide: Bilingue; quand: Bilingue; pasQuand: Bilingue }

/**
 * LES MOTS PAR TYPE D'OUTIL, dont les consignes pré-remplies (spec § 1).
 *
 * 🔴 DIRECTIVES, parce que c'est mesuré (2026-09-21) : une description vague perd face aux compétences de
 * l'agent de Meta, qui passe alors la main au lieu d'appeler l'outil.
 */
export const TEXTES_PAR_TYPE: Record<TypeOutilMba, TextesType> = {
  tag: {
    titre: ['Poser un tag', 'Tag the contact'],
    badge: ['Tag', 'Tag'],
    aide: ['Une étiquette précise sur la fiche du client', 'A specific tag on the customer record'],
    quand: [
      `Appelle cet outil dès que le client ${PLACEHOLDER}. Il sait déjà qui est le client : ne lui demande rien. Confirme-lui ensuite que c’est pris en compte. Ne passe pas la main pour cette demande.`,
      `Call this tool as soon as the customer ${PLACEHOLDER_EN}. It already knows who the customer is: ask nothing. Then confirm it is taken into account. Do not hand over for this request.`,
    ],
    pasQuand: ['N’appelle pas cet outil si le client ne l’a pas demandé.', 'Do not call this tool if the customer did not ask for it.'],
  },
  champ: {
    titre: ['Enregistrer une information', 'Save a detail'],
    badge: ['Information', 'Detail'],
    aide: ['Un champ de la fiche, rempli par l’agent', 'A record field, filled by the agent'],
    quand: [
      `Appelle cet outil dès que le client te donne ${PLACEHOLDER}. Passe la valeur telle qu’il l’a donnée. Confirme-lui ensuite que c’est enregistré. Ne passe pas la main pour cette demande.`,
      `Call this tool as soon as the customer gives you ${PLACEHOLDER_EN}. Pass the value as given. Then confirm it is saved. Do not hand over for this request.`,
    ],
    pasQuand: [
      'N’appelle pas cet outil tant que le client n’a pas donné l’information : ne l’invente jamais.',
      'Do not call this tool until the customer has given the detail: never make it up.',
    ],
  },
  bloc: {
    titre: ['Envoyer un bloc', 'Send a block'],
    badge: ['Bloc', 'Block'],
    aide: ['Un message d’un de vos scénarios', 'A message from one of your scenarios'],
    // 🔴 L'AGENT ANNONCE L'ENVOI EN UNE PHRASE (essais réels du 2026-09-22) : le message part après SON tour
    // (`src/mba/fin-de-tour.ts`), et c'est cette phrase qui dit que son tour est fini. « N'écris rien » le
    // contredisait. « Ne passe pas la main » : sans outil sous la main, il escaladait vers un humain.
    quand: [
      `Appelle cet outil dès que le client ${PLACEHOLDER}. Le message part tout seul quelques secondes après : dis-lui seulement, en une phrase courte, que tu le lui envoies, sans en donner le contenu. Ne passe pas la main pour cette demande.`,
      `Call this tool as soon as the customer ${PLACEHOLDER_EN}. The message is sent automatically a few seconds later: just tell them, in one short sentence, that you are sending it, without giving its content. Do not hand over for this request.`,
    ],
    pasQuand: [
      'N’appelle pas cet outil deux fois pour le même message du client.',
      'Do not call this tool twice for the same customer message.',
    ],
  },
  scenario: {
    titre: ['Lancer un scénario', 'Start a scenario'],
    badge: ['Scénario', 'Scenario'],
    aide: ['Du début, puis la main revient à l’agent', 'From the start, then back to the agent'],
    // 🔴 « SI UN PARCOURS VIENT DÉJÀ D'ÊTRE LANCÉ » A FAIT ESCALADER L'AGENT (essai réel du 2026-09-22, 16 h 32) : il
    // l'a lu comme « déjà lancé plus tôt dans la conversation », s'est interdit l'outil, et a passé la main à un
    // humain faute d'autre moyen. La borne est le MESSAGE du client, pas la conversation.
    quand: [
      `Appelle cet outil dès que le client ${PLACEHOLDER}, même si tu l’as déjà fait plus tôt dans la conversation. Engage Me prend alors la conversation et te la rend à la fin du parcours : dis seulement au client, en une phrase courte, que tu lances ça pour lui, puis n’écris plus rien. Ne passe pas la main pour cette demande.`,
      `Call this tool as soon as the customer ${PLACEHOLDER_EN}, even if you already did earlier in the conversation. Engage Me then takes the conversation and hands it back at the end of the journey: just tell the customer, in one short sentence, that you are starting it, then write nothing more. Do not hand over for this request.`,
    ],
    pasQuand: [
      'N’appelle pas cet outil deux fois pour le même message du client.',
      'Do not call this tool twice for the same customer message.',
    ],
  },
  connecteur: {
    titre: ['Appeler un connecteur API', 'Call an API connector'],
    badge: ['Connecteur API', 'API connector'],
    aide: ['Un appel déclaré dans Connecteurs API', 'A call declared in API connectors'],
    quand: [
      `Appelle cet outil dès que le client ${PLACEHOLDER}. Il sait déjà qui est le client. Confirme-lui ensuite ce que la réponse indique. Ne passe pas la main pour cette demande.`,
      `Call this tool as soon as the customer ${PLACEHOLDER_EN}. It already knows who the customer is. Then tell them what the response says. Do not hand over for this request.`,
    ],
    pasQuand: ['N’appelle pas cet outil si le client ne l’a pas demandé.', 'Do not call this tool if the customer did not ask for it.'],
  },
};
