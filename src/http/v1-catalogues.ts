// src/http/v1-catalogues.ts
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { TemplateSummary } from '../meta/templates';
import { carouselSendBlocker, headerMediaSendBlocker } from '../meta/template-components';
import { countTemplateVariables, parseParamHints } from '../crm/template';
import type { ParamSource } from '../crm/template';
import type { IndiceDuTemplate } from '../crm/template-hints.pg';
import type { ScenarioPublie } from '../workflow/store.pg';
import { ouvertureApi } from '../workflow/ouverture-api';
import type { OuvertureApi } from '../workflow/ouverture-api';
import type { RcsOutbound } from '../rcs/types';
import { variablesDe } from '../rcs/variables';
import { refuser } from '../api/erreurs';
import { verdictModele } from '../api/modele-envoi';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';

/**
 * LES CATALOGUES DE L'API PUBLIQUE : ce qu'un intégrateur peut envoyer, lu sans ouvrir la console.
 *
 * 🔴 CHAQUE LIGNE D'UN CATALOGUE PEUT PARTIR PAR `POST /v1/sends`, et c'est ce qui décide de ce qu'on
 * écarte : un template non approuvé ou d'une catégorie que l'envoi ne connaît pas (authentification), un
 * en-tête qu'il ne sait pas remplir (localisation), ce que le moteur refuserait avant de partir (carte ou
 * lien de carte à variable, carte ou en-tête média sans visuel lisible) ; un scénario jamais publié ; un
 * message RCS dont le contenu stocké n'est plus reconnu. Les montrer ferait construire un appel refusé.
 *
 * 🔴 CHAQUE TRI EST CELUI DE L'ENVOI, par SA fonction : `verdictModele` (statut et catégorie, lot 2),
 * `carouselSendBlocker` et `headerMediaSendBlocker` (le moteur, `src/campaign/engine.ts`). ⚠️ Seul reste
 * imprévisible d'ici un visuel dont le re-téléversement échoue le jour de l'envoi.
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
  /** `null` = ce scénario ne peut pas partir par l'API. `whatsapp_session` = il se vise par son premier bloc. */
  opening: OuvertureApi | null;
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
  return lignes.map((l) => ({
    code: l.code,
    name: l.name,
    opening: ouvertureApi(l.graph).ouverture,
    publishedAt: l.publishedAt,
  }));
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
 * ⚠️ Une panne de Meta sur `/v1/templates` remonte telle quelle au gestionnaire d'erreur global, donc en 5xx
 * SANS corps `{ error, code }` : le catalogue n'invente pas une liste vide, qui ferait croire à l'intégrateur
 * qu'il n'a aucun template approuvé. Tranché dans le plan du lot 4 : aucun code dédié (le § 9 et `CodeApi`
 * n'en ont pas) ; la page le dit dans sa section « Erreurs ».
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
