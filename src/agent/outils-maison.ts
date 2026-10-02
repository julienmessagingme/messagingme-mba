import type { OutilDefini, RisqueOutil } from './catalog';
import type { SortieAgent } from './agent-store';
import { paramsOutil, toolParamsToJsonSchema, type ParamOutil, type SchemaObjet } from './llm/tool-schema';

/**
 * Le catalogue des outils maison, et ce que le modèle voit d'un outil.
 *
 * Un catalogue plutôt qu'un formulaire libre : le comportement vient de `binding.handler`, et seuls existent
 * les handlers de `resolvers/mba.ts`. Un handler libre produirait un outil actif qui refuse à chaque appel.
 * Le client ne compose que le nom, les mots et les valeurs autorisées. Miroir de `HANDLERS`, tenu par
 * `tests/agent-outils-maison.test.ts`.
 */

/** Ce que le client peut composer sur un paramètre, en plus de rien. */
export type EditionParam =
  /** Rien : le paramètre est ce qu'il est. */
  | 'aucune'
  /** Le client liste les valeurs autorisées (les codes de ses blocs, les noms de ses champs). */
  | 'enum'
  /** L'énumération dérive de la fiche de l'agent et n'est jamais stockée (voir `outilsExposes`). */
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
 * Les sept outils maison. `envoyer_bloc` est déclaré irréversible : un message parti ne se rappelle pas et
 * il est facturé, donc le tronc commun le refuse tant que le client n'a pas coché l'autonomie sur cet outil.
 */
export const OUTILS_MAISON: readonly OutilCatalogue[] = [
  {
    handler: 'terminer',
    nomDefaut: 'mba_terminer',
    titre: { fr: 'Terminer par une règle d’arrêt', en: 'Finish through a stop rule' },
    // Le texte nomme l'onglet des règles d'arrêt : le paramètre `sortie` en dérive son énumération. C'est le
    // défaut d'un outil neuf ; les outils déjà posés gardent leur copie, que le client peut réécrire.
    description: {
      fr: 'À appeler quand la conversation a atteint un de ses aboutissements, c’est-à-dire une des règles d’arrêt de l’onglet « Objectif et transferts ». Rend la main au scénario par la sortie choisie.',
      en: 'Call when the conversation has reached one of its outcomes, that is one of the stop rules from the “Objective and handovers” tab. Hands back to the scenario through the chosen output.',
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
      fr: 'Rend ce que l’on sait déjà du contact : son nom, ses champs, et ce que la dernière analyse de ses conversations a constaté (intention, sentiment, satisfaction et urgence sur 10, résolue ou non, sujet), avec son résumé s’il existe. Aucun identifiant à fournir.',
      en: 'Returns what is already known about the contact: name, custom fields, and what the latest analysis of their conversations found (intent, sentiment, satisfaction and urgency out of 10, resolved or not, topic), with its summary if any. No identifier to provide.',
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
      // La clé vient du modèle : une injection peut viser le champ sur lequel une condition du scénario
      // branche. L'énumération fermée est la parade, d'où sa mise en avant à l'écran.
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
    // Irréversible : un message parti ne se rappelle pas, et il est facturé.
    risk: 'irreversible',
    // L'aide fait cocher les blocs dans une liste (`ChoixDeBlocs`) : le client ne voit nulle part leurs codes.
    params: [P(
      'code', 'Le code du bloc à envoyer.', 'enum',
      { fr: 'Les blocs que cet agent a le droit d’envoyer. Cochez-les ci-dessous : seuls ceux d’un scénario contenant un bloc Agent IA peuvent partir.', en: 'The blocks this agent may send. Tick them below: only those in a scenario containing an AI Agent block can be sent.' },
    )],
  },
];

const PAR_HANDLER = new Map(OUTILS_MAISON.map((o) => [o.handler, o]));

/**
 * Le `handler` d'un outil maison, ou la chaîne vide pour un outil qui n'en est pas un. En un seul endroit :
 * une lecture de travers du jsonb `binding` rendrait une chaîne vide, donc un outil qu'on croit absent.
 */
export function handlerMaison(outil: { origin: string; binding: Record<string, unknown> }): string {
  return outil.origin === 'mba' ? String(outil.binding.handler ?? '').trim() : '';
}

export function outilMaison(handler: string): OutilCatalogue | undefined {
  return PAR_HANDLER.get(handler.trim());
}

/**
 * Les paramètres à écrire en base pour un outil maison neuf. Une énumération dérivée n'est jamais stockée :
 * une copie divergerait au premier ajout de règle d'arrêt.
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
 * L'énumération de `terminer` est posée ici, depuis `fiche.sorties` seule : la fiche fait autorité, et une
 * copie dans `agent_tools.params` divergerait. Une dérivation vide retire l'outil au lieu de l'exposer sans
 * énumération, sinon le modèle inventerait un code que le bloc ne dessine pas. À distinguer d'une liste vide
 * remplie par le client (les tags autorisés), qui veut dire « aucune restriction ».
 */
export function outilExpose(outil: OutilDefini, sorties: readonly SortieAgent[]): OutilExpose | null {
  const params = paramsAvecDerivations(outil, sorties.map((s) => s.code));
  if (params === null) return null;
  return { name: outil.name, description: motsExposes(outil), parameters: toolParamsToJsonSchema(params) };
}

/**
 * La description et la clause « quand ne pas l'appeler », réunies parce que la surface d'appel n'accepte
 * qu'un texte. La clause est séparée par une ligne et annoncée : collée, elle se lirait comme une consigne
 * d'usage. Vide, rien n'est écrit (du contexte payé à chaque aller-retour pour rien).
 */
function motsExposes(outil: OutilDefini): string {
  const refus = outil.nePasUtiliser.trim();
  return refus === '' ? outil.description : `${outil.description}\n\nNE PAS l’appeler : ${refus}`;
}

/** Les outils qu'on envoie au modèle. Ceux qui n'ont aucune valeur possible sont retirés, pas offerts vides. */
export function outilsExposes(outils: readonly OutilDefini[], sorties: readonly SortieAgent[]): OutilExpose[] {
  return outils.map((o) => outilExpose(o, sorties)).filter((o): o is OutilExpose => o !== null);
}

/** Les paramètres d'un outil, énumérations dérivées appliquées, ou `null` si une dérivation est vide.
 *  Passe par `paramsOutil`, le point de passage unique de la séparation des sources. */
function paramsAvecDerivations(outil: OutilDefini, codesSortie: string[]): ParamOutil[] | null {
  const modele = outilMaison(String(outil.binding.handler ?? ''));
  const params = paramsOutil(outil.params);
  // Un handler sorti du catalogue (ligne ancienne) garde ses paramètres tels quels : il ne doit pas faire
  // tomber la construction du schéma de tout un tour.
  if (!modele) return params;
  const derives = new Set(modele.params.filter((p) => p.edition === 'derive_des_sorties').map((p) => p.name));
  if (derives.size === 0) return params;
  if (codesSortie.length === 0 && params.some((p) => derives.has(p.name))) return null;
  return params.map((p) => (derives.has(p.name) ? { ...p, enum: codesSortie } : p));
}
