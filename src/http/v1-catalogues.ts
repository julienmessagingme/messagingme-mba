// src/http/v1-catalogues.ts
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { TemplateSummary } from '../meta/templates';
import { carouselSendBlocker, headerMediaSendBlocker } from '../meta/template-components';
import { countTemplateVariables, parseParamHints } from '../crm/template';
import type { ParamSource } from '../crm/template';
import type { IndiceDuTemplate } from '../crm/template-hints.pg';
import type { ScenarioPublie } from '../workflow/store.pg';
import { entryNode } from '../workflow/engine';
import { modeleDOuverture, ouvertureApi } from '../workflow/ouverture-api';
import type { OuvertureApi } from '../workflow/ouverture-api';
import type { RcsOutbound } from '../rcs/types';
import { variablesDe } from '../rcs/variables';
import { estLienTraceAvecJeton } from '../links/rewrite';
import { refuser } from '../api/erreurs';
import { verdictModele } from '../api/modele-envoi';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';

/**
 * LES CATALOGUES DE L'API PUBLIQUE : ce qu'un intégrateur peut envoyer, lu sans ouvrir la console.
 *
 * 🔴 UN TEMPLATE ET UN MESSAGE RCS N'ENTRENT QUE S'ILS PEUVENT PARTIR PAR `POST /v1/sends`, et c'est ce qui
 * décide de ce qu'on écarte : un template non approuvé ou d'une catégorie que l'envoi ne connaît pas
 * (authentification), un en-tête qu'il ne sait pas remplir (localisation, texte à variable), un bouton de lien à
 * variable qu'aucun envoi ne remplit (tout ce qui n'est pas un lien tracé à jeton), ce que le moteur refuserait
 * avant de partir (carte ou lien de carte à variable, carte ou en-tête média sans visuel lisible) ; un message
 * RCS dont le contenu stocké n'est plus reconnu. Les montrer ferait construire un appel refusé.
 *
 * ⚠️ UN SCÉNARIO, LUI, ENTRE DÈS QU'IL EST PUBLIÉ, qu'il puisse partir ou non : la spec (§ 6) veut les scénarios
 * PUBLIÉS, et `opening` dit lequel peut partir (`null` : aucun ; `whatsapp_session` : seulement par son bloc
 * d'entrée, `entryNode`). Le taire ferait chercher à l'intégrateur un scénario qu'il voit dans la console.
 *
 * 🔴 CHAQUE TRI EST CELUI DE L'ENVOI, par SA fonction : `verdictModele` (statut et catégorie, lot 2),
 * `carouselSendBlocker` et `headerMediaSendBlocker` (le moteur, `src/campaign/engine.ts`), `modeleDOuverture`
 * (le template que `params` paramètre). Deux règles n'ont pas de fonction à l'envoi, parce que l'envoi ne les
 * VÉRIFIE pas, il se contente de ne rien fournir : `buildTemplateComponents` ne produit aucun paramètre d'en-tête
 * texte, et ne remplit une adresse de bouton que pour un lien tracé à jeton (`estLienTraceAvecJeton`, qui suit le
 * producteur de ces adresses). ⚠️ Seul reste imprévisible d'ici un visuel dont le re-téléversement échoue le jour
 * de l'envoi.
 *
 * 🔴 L'OUVERTURE D'UN SCÉNARIO VIENT DE `ouvertureApi`, LA FONCTION DE `/v1/sends`, jamais d'un calcul
 * voisin. Deux règles écrites en parallèle divergent un jour, et la divergence serait muette : le catalogue
 * annoncerait un scénario que l'envoi refuse. `tests/v1-catalogues.test.ts` tient la parité avec
 * `ouvertureApi` ET avec la console (`canalDOuverture`), sur les mêmes graphes.
 *
 * ⚠️ Le tenant vient à 100 % de `req.auth` (posé par la garde de clé d'API), jamais de l'URL. Droit
 * attendu : `sends:create`, celui des envois que ces lectures servent à construire.
 */

/** L'en-tête d'un template, tel que le catalogue le nomme. */
export type EnteteTemplate = 'none' | 'text' | 'image' | 'video' | 'document';

/**
 * Les formats d'en-tête qu'un envoi sait porter. Une `Map` et pas un objet littéral : sur un objet,
 * `ENTETES['toString']` rendrait une fonction pour un format que Meta inventerait demain.
 */
const ENTETES: ReadonlyMap<string, EnteteTemplate> = new Map<string, EnteteTemplate>([
  ['TEXT', 'text'], ['IMAGE', 'image'], ['VIDEO', 'video'], ['DOCUMENT', 'document'],
]);

export interface VariableDeTemplate {
  position: number;
  /** Le champ que la console associe à cette variable (`template_param_hints`), `null` s'il n'est pas connu. */
  source: ParamSource | null;
}

export interface TemplateCatalogue {
  name: string;
  language: string;
  category: 'marketing' | 'utility';
  /** ⚠️ Un carrousel a ses visuels PAR CARTE, sans en-tête de premier niveau : il vaut `none`. */
  header: EnteteTemplate;
  variables: VariableDeTemplate[];
}

export interface ScenarioCatalogue {
  code: string | null;
  name: string;
  /** `null` = ce scénario ne peut pas partir par l'API. `whatsapp_session` = il se vise par son bloc d'entrée. */
  opening: OuvertureApi | null;
  /**
   * Le template que `params` paramètre quand on vise le SCÉNARIO, pour une ouverture `whatsapp_template` ;
   * `null` sinon. ⚠️ Son nombre de variables n'est pas ici : il se lit chez Meta, donc dans `GET /v1/templates`
   * (la ligne du même nom et de la même langue). Le relire ici coûterait la liste complète du WABA par appel.
   */
  openingTemplate: { name: string; language: string } | null;
  /** Le code `nod_` du bloc d'entrée, celui qu'on vise en cible `node` (seul chemin d'un `whatsapp_session`). */
  entryNode: string | null;
  publishedAt: string | null;
}

export interface MessageRcsCatalogue {
  name: string;
  kind: RcsOutbound['kind'];
  /** Les `{{nom}}` du message, dans l'ordre de première apparition (`variablesDe`). */
  variables: string[];
}

/** Nom et langue en une clé sans ambiguïté (un nom de template ne peut pas contenir de quoi la casser). */
const cleTemplate = (name: string, language: string): string => JSON.stringify([name, language]);

/**
 * Ce template porte-t-il un paramètre qu'AUCUN chemin d'envoi ne remplit ? Meta refuserait alors chaque message
 * (132000), sans qu'aucun refus ne le dise avant l'envoi.
 *
 * - un en-tête TEXTE à variable : `buildTemplateComponents` ne produit que l'en-tête MÉDIA ;
 * - un bouton de lien de premier niveau dont l'adresse porte une variable, sauf un lien tracé à jeton : c'est le
 *   seul suffixe que l'envoi fournit (`suffixesBoutons`). Les boutons de CARTE sont jugés par `carouselSendBlocker`.
 */
function parametreSansSource(t: TemplateSummary): boolean {
  if (t.headerFormat === 'TEXT' && countTemplateVariables(t.headerText ?? '') > 0) return true;
  return (t.buttons ?? []).some((b) => b.type === 'URL' && countTemplateVariables(b.url ?? '') > 0 && !estLienTraceAvecJeton(b.url ?? ''));
}

/** Le code public d'un bloc, sous la forme que `mintNodeCodes` pose (le seul qu'une cible `node` retrouve). */
const CODE_DE_BLOC = /^nod_[a-z0-9]+_[0-9A-HJKMNP-TV-Z]{26}$/;

export function catalogueTemplates(
  templates: readonly TemplateSummary[],
  indices: readonly IndiceDuTemplate[],
): TemplateCatalogue[] {
  const sources = new Map<string, Map<number, ParamSource>>();
  for (const i of indices) {
    // Relu par le MÊME validateur qu'à l'écriture : la colonne est un jsonb, et ce qui en sort part vers un
    // tiers. Un indice illisible devient « aucune source connue », jamais une valeur inventée.
    const [valide] = parseParamHints([{ position: i.position, source: i.source }]) ?? [];
    if (!valide) continue;
    const cle = cleTemplate(i.name, i.language);
    const parPosition = sources.get(cle) ?? new Map<number, ParamSource>();
    parPosition.set(valide.position, valide.source);
    sources.set(cle, parPosition);
  }

  const sortie: TemplateCatalogue[] = [];
  for (const t of templates) {
    // MAX des positions {{n}}, pas leur nombre : un corps `{{1}} … {{3}}` attend trois paramètres.
    const nombre = countTemplateVariables(t.body);
    /**
     * Statut et catégorie : la lecture de `POST /v1/sends` (`verdictModele`), jamais une règle voisine. Ce
     * qu'on lui passe est construit comme la lecture partagée le construit (`templateVarInfo`,
     * `src/workflow/wiring.ts`) : Meta rend la catégorie en majuscules, elle la passe en minuscules, et une
     * catégorie vide y est absente (donc illisible, jamais « utility »).
     */
    const verdict = verdictModele({
      count: nombre,
      statut: t.status,
      langue: t.language,
      ...(t.category ? { category: t.category.toLowerCase() } : {}),
    }, t.language);
    if (verdict.statut !== 'approuve') continue;
    const header = t.headerFormat === null ? 'none' : ENTETES.get(t.headerFormat);
    if (!header) continue;
    /**
     * Ce que le moteur d'envoi refuse AVANT de partir, par SES fonctions. ⚠️ À l'envoi, chaque visuel est
     * RE-TÉLÉVERSÉ depuis son adresse pour obtenir son identifiant (`prepareCarouselMedia`,
     * `prepareHeaderMedia`) ; le catalogue ne téléverse rien, donc l'adresse tient lieu d'identifiant : sans
     * elle, l'envoi n'en aura jamais.
     */
    if (t.carousel && carouselSendBlocker(t.carousel.cards.map((c) => ({ ...c, mediaId: c.mediaId ?? c.mediaUrl }))) !== null) continue;
    if (headerMediaSendBlocker(t.headerFormat ?? undefined, t.headerMediaUrl) !== null) continue;
    if (parametreSansSource(t)) continue;
    const parPosition = sources.get(cleTemplate(t.name, t.language));
    sortie.push({
      name: t.name,
      language: t.language,
      category: verdict.categorie,
      header,
      variables: Array.from({ length: nombre }, (_, k) => ({
        position: k + 1,
        source: parPosition?.get(k + 1) ?? null,
      })),
    });
  }
  return sortie.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

export function catalogueScenarios(lignes: readonly ScenarioPublie[]): ScenarioCatalogue[] {
  return lignes.map((l) => {
    const opening = ouvertureApi(l.graph).ouverture;
    // Le template qui part n'existe que pour une ouverture par template : sur un RCS, le premier template trouvé
    // est le repli de la sortie « non joignable », que `params` ne paramètre pas (la route refuse `params`).
    const modele = opening === 'whatsapp_template' ? modeleDOuverture(l.graph) : null;
    // Le bloc d'entrée est celui d'où `ouvertureApi` part sans point de départ : le viser rend la même ouverture.
    const entree = entryNode(l.graph);
    const code = l.graph.nodes.find((n) => n.id === entree)?.data.code;
    return {
      code: l.code,
      name: l.name,
      opening,
      openingTemplate: modele ? { name: modele.templateName, language: modele.language } : null,
      entryNode: typeof code === 'string' && CODE_DE_BLOC.test(code) ? code : null,
      publishedAt: l.publishedAt,
    };
  });
}

export function catalogueMessagesRcs(
  messages: ReadonlyArray<{ name: string; content: RcsOutbound | null }>,
): MessageRcsCatalogue[] {
  const sortie: MessageRcsCatalogue[] = [];
  for (const m of messages) {
    // `null` = contenu stocké dont la forme n'est plus reconnue (`parseStoredRcsOutbound`) : il ne partirait pas.
    if (!m.content) continue;
    sortie.push({ name: m.name, kind: m.content.kind, variables: variablesDe(m.content) });
  }
  return sortie.sort((a, b) => a.name.localeCompare(b.name));
}

export interface V1CataloguesRouteDeps {
  /** Le garde d'usage, injecté au bootstrap. OBLIGATOIRE, comme sur les autres modules /v1. */
  usage: ApiUsageGuard;
  /** Les templates du WABA de l'espace, tels que Meta les rend. `[]` quand l'espace n'a pas de WABA. */
  templates(tenantId: string): Promise<TemplateSummary[]>;
  /** Tous les indices « variable vers champ » de l'espace, en UNE requête. */
  indicesDeVariables(tenantId: string): Promise<IndiceDuTemplate[]>;
  /** Les scénarios dont le graphe PUBLIÉ porte au moins un bloc. */
  scenariosPublies(tenantId: string): Promise<ScenarioPublie[]>;
  /** La bibliothèque RCS, suppressions douces exclues. */
  messagesRcs(tenantId: string): Promise<ReadonlyArray<{ name: string; content: RcsOutbound | null }>>;
}

/**
 * Guard attendu : `[makeRequireApiKey, requireScope('sends:create')]`, posé par l'entrée `v1` du registre.
 *
 * ⚠️ Une panne de Meta sur `/v1/templates` remonte telle quelle au gestionnaire d'erreur global
 * (`setErrorHandler`, `src/server.ts`), jamais en liste vide, qui ferait croire à l'intégrateur qu'il n'a aucun
 * template approuvé. Ce qu'il rend, SANS `code` dans les deux cas : un REFUS de Meta (`MetaApiError`) sort en
 * 422 `{ error: "Meta: …" }` ; une panne réseau ou toute autre exception sort en 500 au corps opaque, qu'un
 * proxy peut remplacer par sa propre page. `tests/v1-catalogues.test.ts` fige les deux. Aucun code dédié : c'est
 * une décision de spec (§ 9, `CodeApi`), laissée à Julien (`todo.md`) ; la page dit l'exception.
 */
export function registerV1Catalogues(app: FastifyInstance, deps: V1CataloguesRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/v1/templates', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;
    if (!await compterOuRefuser(deps.usage, req, reply, 'catalogues.read')) return reply;
    const [templates, indices] = await Promise.all([deps.templates(tenantId), deps.indicesDeVariables(tenantId)]);
    return reply.code(200).send({ templates: catalogueTemplates(templates, indices) });
  });

  app.get('/v1/scenarios', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;
    if (!await compterOuRefuser(deps.usage, req, reply, 'catalogues.read')) return reply;
    return reply.code(200).send({ scenarios: catalogueScenarios(await deps.scenariosPublies(tenantId)) });
  });

  app.get('/v1/rcs-messages', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;
    if (!await compterOuRefuser(deps.usage, req, reply, 'catalogues.read')) return reply;
    return reply.code(200).send({ rcsMessages: catalogueMessagesRcs(await deps.messagesRcs(tenantId)) });
  });
}
