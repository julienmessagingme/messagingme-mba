import type { OutilDefini, RisqueOutil } from './catalog';
import type { SortieAgent } from './agent-store';
import { paramsOutil, toolParamsToJsonSchema, type ParamOutil, type SchemaObjet } from './llm/tool-schema';

/**
 * Le CATALOGUE des outils maison, et ce que le modèle voit d'un outil.
 *
 * 🔴 POURQUOI UN CATALOGUE ET NON UN FORMULAIRE LIBRE. Le comportement d'un outil maison vient de son
 * `binding.handler`, et les seuls handlers qui existent sont ceux de `resolvers/mba.ts`. Une console qui
 * laisserait écrire un handler quelconque produirait un outil ACTIF, exposé au modèle, et qui refuse à chaque
 * appel : le client verrait un agent qui « ne fait rien » sans aucune trace lisible. Le client choisit donc
 * dans cette liste, et ne compose que ce qui lui appartient vraiment : le nom, les mots, et les valeurs
 * autorisées là où on lui en laisse.
 *
 * ⚠️ Ce fichier est le miroir de `HANDLERS` dans `src/agent/resolvers/mba.ts`. `tests/agent-outils-maison.test.ts`
 * casse si l'un porte un handler que l'autre ignore : un handler ajouté au résolveur sans entrée ici serait
 * inatteignable, et une entrée ici sans handler serait un outil mort-né.
 */

/** Ce que le client peut composer sur un paramètre, en plus de rien. */
export type EditionParam =
  /** Rien : le paramètre est ce qu'il est. */
  | 'aucune'
  /** Le client liste les valeurs autorisées (les codes de ses blocs, les noms de ses champs). */
  | 'enum'
  /** L'énumération DÉRIVE de la fiche de l'agent et n'est jamais stockée (voir `outilsExposes`). */
  | 'derive_des_sorties';

export interface ParamCatalogue extends ParamOutil {
  edition: EditionParam;
  /** Ce qu'on dit au client à propos de cette liste, dans sa langue à lui. */
  aideEnum?: { fr: string; en: string };
}

export interface OutilCatalogue {
  /** Clé de `binding.handler`, et identifiant du modèle de cet outil dans la console. */
  handler: string;
  /** Nom exposé au modèle par défaut. Le client peut le changer : un nom parlant fait un meilleur agent. */
  nomDefaut: string;
  titre: { fr: string; en: string };
  description: { fr: string; en: string };
  nePasUtiliser: { fr: string; en: string };
  risk: RisqueOutil;
  params: ParamCatalogue[];
}

const P = (
  name: string, description: string, edition: EditionParam = 'aucune', aideEnum?: { fr: string; en: string },
): ParamCatalogue => ({
  name, type: 'string', source: 'modele', required: true, description, edition, ...(aideEnum ? { aideEnum } : {}),
});

/**
 * Les sept outils maison.
 *
 * `envoyer_bloc` est déclaré IRRÉVERSIBLE, et c'est un choix, pas une classification par défaut : un message
 * parti chez un contact ne se rappelle pas, et il est facturé. Le tronc commun refuse alors l'appel tant que
 * le client n'a pas coché l'autonomie sur CET outil (`src/agent/executor.ts`). C'est ce qui rend ce drapeau
 * vivant dès L1, au lieu d'un réglage qui n'aurait servi qu'aux familles HTTP et MCP.
 */
export const OUTILS_MAISON: readonly OutilCatalogue[] = [
  {
    handler: 'terminer',
    nomDefaut: 'mba_terminer',
    titre: { fr: 'Terminer par une règle d’arrêt', en: 'Finish through a stop rule' },
    description: {
      fr: 'À appeler quand la conversation a atteint un de ses aboutissements. Rend la main au scénario par la sortie choisie.',
      en: 'Call when the conversation has reached one of its outcomes. Hands back to the scenario through the chosen output.',
    },
    nePasUtiliser: {
      fr: 'Ne pas appeler pour passer la main à un humain : il y a un outil pour ça.',
      en: 'Do not call to hand over to a human: there is a dedicated tool.',
    },
    risk: 'read',
    params: [{
      ...P('sortie', 'Le code de la règle d’arrêt atteinte.'),
      edition: 'derive_des_sorties',
    }],
  },
  {
    handler: 'escalader',
    nomDefaut: 'mba_escalader_humain',
    titre: { fr: 'Passer la main à un humain', en: 'Hand over to a human' },
    description: {
      fr: 'À appeler dès que la demande sort du périmètre, ou que le contact le demande. La conversation arrive dans l’inbox.',
      en: 'Call as soon as the request is out of scope, or the contact asks for it. The conversation lands in the inbox.',
    },
    nePasUtiliser: {
      fr: 'Ne pas appeler par prudence sur une question à laquelle les sources répondent.',
      en: 'Do not call out of caution on a question the sources answer.',
    },
    risk: 'write',
    params: [],
  },
  {
    handler: 'chercher_connaissance',
    nomDefaut: 'mba_chercher_connaissance',
    titre: { fr: 'Chercher dans la base de connaissance', en: 'Search the knowledge base' },
    description: {
      fr: 'À appeler AVANT de répondre à toute question de fond. Rend les fiches qui traitent le sujet, ou rien.',
      en: 'Call BEFORE answering any substantive question. Returns the entries covering the topic, or nothing.',
    },
    nePasUtiliser: {
      fr: 'Ne pas répondre de mémoire quand cet outil ne rend rien.',
      en: 'Do not answer from memory when this tool returns nothing.',
    },
    risk: 'read',
    params: [P('requete', 'La question, dans les mots du contact.')],
  },
  {
    handler: 'lire_contact',
    nomDefaut: 'mba_lire_contact',
    titre: { fr: 'Lire la fiche du contact', en: 'Read the contact record' },
    description: {
      fr: 'Rend ce que l’on sait déjà du contact : son nom, ses champs. Aucun identifiant à fournir.',
      en: 'Returns what is already known about the contact: name, custom fields. No identifier to provide.',
    },
    nePasUtiliser: {
      fr: 'Ne rend jamais la fiche de quelqu’un d’autre : inutile de le demander.',
      en: 'Never returns anyone else’s record: no point asking.',
    },
    risk: 'read',
    params: [],
  },
  {
    handler: 'poser_tag',
    nomDefaut: 'mba_poser_tag',
    titre: { fr: 'Poser un tag sur le contact', en: 'Tag the contact' },
    description: {
      fr: 'Marque le contact, pour le retrouver ensuite dans le mini-CRM ou déclencher une automation.',
      en: 'Marks the contact, to find them later in the mini-CRM or trigger an automation.',
    },
    nePasUtiliser: {
      fr: 'Ne pas inventer de tag hors de la liste autorisée.',
      en: 'Do not invent a tag outside the allowed list.',
    },
    risk: 'write',
    params: [P(
      'tag', 'Le tag à poser.', 'enum',
      { fr: 'Les tags que cet agent a le droit de poser. Vide, il peut en poser n’importe lequel.', en: 'The tags this agent may set. Left empty, it can set any.' },
    )],
  },
  {
    handler: 'ecrire_variable',
    nomDefaut: 'mba_ecrire_variable',
    titre: { fr: 'Enregistrer une information sur le contact', en: 'Record information about the contact' },
    description: {
      fr: 'Écrit une valeur dans un champ du contact, pour qu’un bloc plus loin dans le scénario la réutilise.',
      en: 'Writes a value into a contact field, so a later block in the scenario can reuse it.',
    },
    nePasUtiliser: {
      fr: 'Ne pas écrire dans un champ absent de la liste autorisée.',
      en: 'Do not write into a field missing from the allowed list.',
    },
    risk: 'write',
    params: [
      // ⚠️ La CLÉ vient du modèle : une injection peut viser le champ sur lequel une condition du scénario
      // branche. L'énumération fermée est la parade, et c'est pour ça que l'écran la met en avant.
      P(
        'cle', 'Le champ à renseigner.', 'enum',
        { fr: 'Les champs que cet agent a le droit d’écrire. À remplir : sans liste, il peut écrire dans n’importe lequel.', en: 'The fields this agent may write. Fill it in: without a list, it can write into any of them.' },
      ),
      P('valeur', 'La valeur à enregistrer.'),
    ],
  },
  {
    handler: 'envoyer_bloc',
    nomDefaut: 'mba_envoyer_bloc',
    titre: { fr: 'Envoyer un bloc de votre scénario', en: 'Send a block from your scenario' },
    description: {
      fr: 'Envoie un bloc que vous avez dessiné : une photo, un message, un formulaire. Le parcours ne bouge pas, l’agent garde la main.',
      en: 'Sends a block you designed: a photo, a message, a form. The journey does not move, the agent keeps the floor.',
    },
    nePasUtiliser: {
      fr: 'Ne pas appeler pour dire ce qu’un message écrit dirait aussi bien.',
      en: 'Do not call for something a written message would say just as well.',
    },
    // Un message parti chez un contact ne se rappelle pas, et il est facturé : c'est la définition même de
    // l'irréversible, et le tronc commun le refuse tant que le client n'a pas coché l'autonomie.
    risk: 'irreversible',
    params: [P(
      'code', 'Le code du bloc à envoyer.', 'enum',
      { fr: 'Les codes de blocs que cet agent a le droit d’envoyer (ceux de vos scénarios, en « nod_… »).', en: 'The block codes this agent may send (from your scenarios, as “nod_…”).' },
    )],
  },
];

const PAR_HANDLER = new Map(OUTILS_MAISON.map((o) => [o.handler, o]));

/** Le modèle d'outil correspondant à ce handler, ou `undefined`. Sert à refuser un handler inventé. */
export function outilMaison(handler: string): OutilCatalogue | undefined {
  return PAR_HANDLER.get(handler.trim());
}

/**
 * Les paramètres à ÉCRIRE en base pour un outil maison neuf.
 *
 * 🔴 Une énumération DÉRIVÉE n'est jamais stockée. Deux copies (la fiche et la colonne) divergeraient au
 * premier ajout de règle d'arrêt, et le modèle terminerait alors par une sortie que le bloc ne dessine pas.
 */
export function paramsInitiaux(modele: OutilCatalogue): ParamOutil[] {
  return modele.params.map(({ edition, aideEnum: _aide, enum: valeurs, ...p }) => (
    edition !== 'derive_des_sorties' && valeurs && valeurs.length > 0 ? { ...p, enum: valeurs } : p
  ));
}

/** Ce qu'un outil expose au modèle : son nom, ses mots, et son schéma. */
export interface OutilExpose {
  name: string;
  description: string;
  parameters: SchemaObjet;
}

/**
 * Ce que le modèle voit d'un outil, ou `null` quand il ne doit rien en voir.
 *
 * 🔴 C'EST ICI QUE L'ÉNUMÉRATION DE `terminer` EST POSÉE, à partir de `fiche.sorties` et de rien d'autre.
 * La fiche fait autorité : c'est là que le client déclare ses règles d'arrêt, et c'est de là que le builder
 * tire les handles du bloc. Recopier ces codes dans `agent_tools.params` créerait une seconde vérité qui
 * divergerait au premier ajout, et le modèle terminerait alors par une sortie que le bloc ne dessine pas,
 * donc par une conversation qui remonte en inbox sans que personne comprenne pourquoi.
 *
 * ⚠️ Une dérivation VIDE retire l'outil, elle ne l'expose pas sans énumération. Sans cette règle, un agent
 * dont la fiche n'a aucune règle d'arrêt exposerait un `terminer` acceptant n'importe quelle chaîne : le
 * modèle en inventerait une, le bloc n'aurait pas ce handle, et la conversation remonterait en inbox sans
 * explication. Ne rien offrir est plus honnête : l'agent sort alors par les sorties automatiques du bloc,
 * ce que l'écran des règles d'arrêt annonce déjà. La distinction avec une liste vide REMPLIE PAR LE CLIENT
 * (les tags autorisés, par exemple) est nette : là, vide veut dire « aucune restriction ».
 */
export function outilExpose(outil: OutilDefini, sorties: readonly SortieAgent[]): OutilExpose | null {
  const params = paramsAvecDerivations(outil, sorties.map((s) => s.code));
  if (params === null) return null;
  return { name: outil.name, description: motsExposes(outil), parameters: toolParamsToJsonSchema(params) };
}

/**
 * Les DEUX textes d'un outil, réunis en un seul, parce que la surface d'appel n'en accepte qu'un.
 *
 * 🔴 LA CLAUSE « QUAND NE PAS L'APPELER » N'ATTEIGNAIT PAS LE MODÈLE, jusqu'au 2026-08-29. La colonne existe
 * depuis la migration 0086, la route l'exige pour un connecteur, l'écran l'affiche, l'IA de construction la
 * rédige, et le CLAUDE.md dit d'elle qu'« elle évite les appels de trop ». Mais `outilExpose` ne construisait
 * que la description, et la requête du runtime ne lisait même pas la colonne. Le client faisait donc un
 * travail sans effet, sur le seul levier qui décide quand un outil se déclenche.
 *
 * ⚠️ Elle est séparée par une ligne et ANNONCÉE, pas simplement collée : deux paragraphes accolés se lisent
 * comme une seule consigne, et une clause de refus noyée dans une description d'usage est une clause qu'un
 * modèle applique mal. Vide, on n'écrit rien du tout : une rubrique vide est du contexte payé à chaque
 * aller-retour pour dire qu'il n'y a rien à dire.
 */
function motsExposes(outil: OutilDefini): string {
  const refus = outil.nePasUtiliser.trim();
  return refus === '' ? outil.description : `${outil.description}\n\nNE PAS l’appeler : ${refus}`;
}

/** Les outils qu'on envoie au modèle. Ceux qui n'ont aucune valeur possible sont RETIRÉS, pas offerts vides. */
export function outilsExposes(outils: readonly OutilDefini[], sorties: readonly SortieAgent[]): OutilExpose[] {
  return outils.map((o) => outilExpose(o, sorties)).filter((o): o is OutilExpose => o !== null);
}

/** Les paramètres d'un outil, énumérations dérivées appliquées, ou `null` si une dérivation est vide. Passe
 *  par `paramsOutil`, jamais par une seconde lecture de `params` : c'est le point de passage unique de la
 *  séparation des sources. */
function paramsAvecDerivations(outil: OutilDefini, codesSortie: string[]): ParamOutil[] | null {
  const modele = outilMaison(String(outil.binding.handler ?? ''));
  const params = paramsOutil(outil.params);
  // Un outil dont le handler n'est plus au catalogue (ligne écrite par une version antérieure) garde ses
  // paramètres tels quels : il ne doit pas faire tomber la construction du schéma de tout un tour.
  if (!modele) return params;
  const derives = new Set(modele.params.filter((p) => p.edition === 'derive_des_sorties').map((p) => p.name));
  if (derives.size === 0) return params;
  if (codesSortie.length === 0 && params.some((p) => derives.has(p.name))) return null;
  return params.map((p) => (derives.has(p.name) ? { ...p, enum: codesSortie } : p));
}
