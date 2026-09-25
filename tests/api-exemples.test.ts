// tests/api-exemples.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import {
  BORNES, CODES_DOCUMENTES, EXEMPLES_CORPS, EXEMPLES_REPONSES,
  type RouteAvecCorps,
} from '../web/lib/api-exemples';
import { schemaClesFiche } from '../src/api/fiche';
import {
  schemaCorpsContact, schemaCorpsLot, schemaCorpsRecherche, schemaCorpsModification, MAX_BATCH,
} from '../src/http/v1-contacts';
import {
  schemaCorpsEnvoi, schemaDestinataireEnvoi, lireCible, MAX_RECIPIENTS, MAX_SKIPPED_REPORT, type RapportEnvoi,
} from '../src/http/v1-sends';
import { schemaMessageWhatsapp, type ReponseMessageSimple } from '../src/http/v1-messages';
import { schemaMessageRcs } from '../src/http/v1-messages-rcs';
import { validateParamMapping } from '../src/crm/template';
import { destinataireAvecVariablesInterdites } from '../src/api/variables';
import { cleIdempotence, DUREE_CLE_IDEMPOTENCE_MS } from '../src/api/idempotence';
import { STATUT_PAR_CODE, type CodeApi } from '../src/api/erreurs';
import { PLAFOND_API_DEFAUT } from '../src/auth/plafond-espace';
import { CODES_ECART } from '../src/api/sends-build';
import type { FicheApi, ResultatFiche } from '../src/api/contacts-v1';
import type { SuiviEnvoiApi } from '../src/api/suivi-envoi';
import { catalogueTemplates, catalogueScenarios, catalogueMessagesRcs } from '../src/http/v1-catalogues';
import type { MessageRcsCatalogue, ScenarioCatalogue, TemplateCatalogue } from '../src/http/v1-catalogues';
import { OUTILS_TIERS } from './outils-tiers';
import { FICHIERS_DOC, PAGES_DOC } from '../web/lib/doc-api-pages';

/**
 * LA PAGE DOCUMENTATION API NE PEUT PLUS DÉCRIRE UN CORPS QUE LE SERVEUR REFUSE (spec § 10).
 *
 * 🔴 CHAQUE CORPS D'EXEMPLE PASSE PAR LE VALIDATEUR ZOD DE SA ROUTE. La page a longtemps montré `optIn`, des
 * destinataires en chaînes et `/v1/messages`, bien après que le code eut changé : écrite à la main, elle ne
 * pouvait pas le savoir. Ses exemples vivent désormais dans `web/lib/api-exemples.ts`, que la page affiche et
 * que ce fichier éprouve.
 *
 * ⚠️ DES CONTRÔLES SONT AU TYPAGE, pas à l'exécution : la table des codes égale à `CodeApi` (dans les deux
 * sens), l'exhaustivité des validateurs par route, et les réponses montrées typées par leurs producteurs. Ils
 * tombent à `npm run typecheck`, qui tourne en CI.
 */

type Verdict = { ok: true } | { ok: false; raison: string };
const depuis = (r: { success: true } | { success: false; error: z.ZodError }): Verdict =>
  (r.success ? { ok: true } : { ok: false, raison: r.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join(' ; ') });

/**
 * Le validateur de CHAQUE route qui prend un corps. `Record` sur l'union : une route ajoutée à
 * `RouteAvecCorps` sans validateur ne compile pas.
 *
 * 🔴 CE SONT LES RÈGLES DES ROUTES, JAMAIS UNE COPIE : les schémas, `lireCible` et les bornes sont EXPORTÉS par
 * les routes, `cleIdempotence`, `validateParamMapping` et `destinataireAvecVariablesInterdites` sont les
 * fonctions qu'elles appellent, avec les MÊMES arguments. Seul l'ORDRE est reproduit ici, celui de la route, et
 * il ne change rien à la question posée (un exemple de la doc doit passer TOUTES les règles).
 *
 * ⚠️ `POST /v1/sends` : la clé d'idempotence est lue dans le CORPS seul (`cleIdempotence(undefined, …)`) : les
 * commandes de la page copient le corps, et le rejeu décrit par la page repose sur la clé qu'il porte. Un
 * destinataire mal formé est ÉCARTÉ par la route, il ne fait pas tomber l'envoi ; pour la doc, c'est quand même
 * un mensonge (l'exemple montrerait un destinataire qui ne part pas), donc chaque destinataire passe ici le
 * schéma de la route.
 * ⚠️ `POST /v1/contacts/batch` : le lot 1 tient les deux bornes de longueur du lot (vide, plus de `MAX_BATCH`)
 * dans son HANDLER, pas dans son schéma. Elles sont appliquées ici avec SA constante ; seul le lot 1 peut les
 * remonter dans le schéma. Les cas cassés du lot éprouvent donc le conteneur et l'élément, pas ces bornes.
 */
const VALIDATEURS: Record<RouteAvecCorps, (corps: unknown) => Verdict> = {
  'POST /v1/contacts': (c) => depuis(schemaCorpsContact.safeParse(c)),
  'POST /v1/contacts/batch': (c) => {
    const lot = schemaCorpsLot.safeParse(c);
    if (!lot.success) return depuis(lot);
    const { contacts } = lot.data;
    if (contacts.length === 0 || contacts.length > MAX_BATCH) return { ok: false, raison: `contacts : de 1 à ${MAX_BATCH} éléments` };
    for (const [i, el] of contacts.entries()) {
      const v = depuis(schemaCorpsContact.safeParse(el));
      if (!v.ok) return { ok: false, raison: `contacts.${i} : ${v.raison}` };
    }
    return { ok: true };
  },
  'POST /v1/contacts/search': (c) => depuis(schemaCorpsRecherche.safeParse(c)),
  'PATCH /v1/contacts/{contactId}': (c) => depuis(schemaCorpsModification.safeParse(c)),
  'POST /v1/sends': (c) => {
    const lu = schemaCorpsEnvoi.safeParse(c);
    if (!lu.success) return depuis(lu);
    const idem = cleIdempotence(undefined, lu.data);
    if (!idem.ok) return { ok: false, raison: `${idem.code} : ${idem.message}` };
    const params = validateParamMapping(lu.data.params ?? [], { accepterVariables: true });
    if (params === null) return { ok: false, raison: 'params : positions 1..N contiguës et sources valides attendues' };
    const cible = lireCible(lu.data, params);
    if ('message' in cible) return { ok: false, raison: cible.message };
    // Les destinataires TELS QUE REÇUS, comme la route : le refus tombe avant qu'aucun ne soit validé.
    const fautif = destinataireAvecVariablesInterdites(cible.kind, lu.data.recipients);
    if (fautif !== null) return { ok: false, raison: `recipients.${fautif}.variables : refusées sur un scénario ou un bloc` };
    for (const [i, brut] of lu.data.recipients.entries()) {
      const d = schemaDestinataireEnvoi.safeParse(brut);
      if (!d.success) { const v = depuis(d); return { ok: false, raison: `recipients.${i} : ${v.ok ? '' : v.raison}` }; }
    }
    return { ok: true };
  },
  'POST /v1/messages/whatsapp': (c) => depuis(schemaMessageWhatsapp.safeParse(c)),
  'POST /v1/messages/rcs': (c) => depuis(schemaMessageRcs.safeParse(c)),
};

describe('🔴 chaque corps d’exemple passe le validateur de SA route', () => {
  it.each(Object.entries(EXEMPLES_CORPS))('%s', (_cle, exemple) => {
    const verdict = VALIDATEURS[exemple.route](exemple.corps);
    expect(verdict, `${exemple.route} refuse l’exemple : ${verdict.ok ? '' : verdict.raison}`).toEqual({ ok: true });
  });

  it('chaque route qui prend un corps a au moins un exemple à l’écran', () => {
    const montrees = new Set(Object.values(EXEMPLES_CORPS).map((e) => e.route));
    for (const route of Object.keys(VALIDATEURS)) expect(montrees.has(route as RouteAvecCorps), route).toBe(true);
  });

  /**
   * LA GARDE DE LA GARDE : un validateur qui accepterait tout ferait passer les cas ci-dessus sans rien
   * prouver. Chaque corps cassé ici l'est d'une façon que la SPEC refuse, et chacun est refusé par une règle
   * de la ROUTE (schéma, clé d'idempotence, `lireCible`, règle des variables), jamais par une copie écrite dans
   * ce fichier.
   */
  const { idempotencyKey: _sansCle, ...envoiSansCle } = EXEMPLES_CORPS.envoiTemplate.corps;
  const CASSES: Array<{ route: RouteAvecCorps; corps: unknown; pourquoi: string }> = [
    { route: 'POST /v1/contacts', corps: { ...EXEMPLES_CORPS.contactCreer.corps, consent: 'oui' }, pourquoi: 'consent vaut opted_in ou opted_out' },
    { route: 'POST /v1/contacts/batch', corps: { contacts: 'crm-7781' }, pourquoi: 'contacts est un tableau (le conteneur de la route)' },
    { route: 'POST /v1/contacts/batch', corps: { contacts: [{ ...EXEMPLES_CORPS.contactCreer.corps, consent: 'oui' }] }, pourquoi: 'chaque élément passe le schéma d’un contact' },
    { route: 'POST /v1/contacts/search', corps: { phone: '+33612345678', externalId: 'crm-7781' }, pourquoi: 'une recherche porte exactement une clé' },
    { route: 'PATCH /v1/contacts/{contactId}', corps: { fields: 'ville=Lyon' }, pourquoi: 'fields est un objet' },
    { route: 'POST /v1/sends', corps: { ...EXEMPLES_CORPS.envoiTemplate.corps, recipients: ['+33612345678'] }, pourquoi: 'un destinataire est un objet, plus un numéro' },
    { route: 'POST /v1/sends', corps: { ...EXEMPLES_CORPS.envoiTemplate.corps, category: 'utility' }, pourquoi: 'la catégorie d’un template est lue chez Meta, jamais donnée' },
    { route: 'POST /v1/sends', corps: envoiSansCle, pourquoi: 'la clé d’idempotence est obligatoire' },
    {
      route: 'POST /v1/sends',
      corps: { ...EXEMPLES_CORPS.envoiScenario.corps, recipients: [{ externalId: 'crm-7781', variables: { a: 'b' } }] },
      pourquoi: 'un scénario n’a aucun endroit où ranger des variables',
    },
    { route: 'POST /v1/messages/whatsapp', corps: { externalId: 'crm-7781' }, pourquoi: 'le texte manque' },
    { route: 'POST /v1/messages/rcs', corps: { ...EXEMPLES_CORPS.messageRcs.corps, text: 'a'.repeat(BORNES.texteRcs + 1) }, pourquoi: 'texte trop long' },
  ];
  it.each(CASSES)('refusé : $pourquoi', ({ route, corps }) => {
    expect(VALIDATEURS[route](corps).ok).toBe(false);
  });

  it('aucun exemple ne porte d’apostrophe droite : la commande curl met le corps entre apostrophes', () => {
    for (const [cle, e] of Object.entries(EXEMPLES_CORPS)) expect(JSON.stringify(e.corps).includes("'"), cle).toBe(false);
  });
});

describe('les codes documentés sont ceux du serveur', () => {
  type CodeDocumenteNom = (typeof CODES_DOCUMENTES)[number]['code'];
  /** Chaque code documenté existe côté serveur : sinon cette affectation ne compile pas. */
  const connus: readonly CodeApi[] = CODES_DOCUMENTES.map((c) => c.code);
  /** Et chaque code du serveur est documenté : sinon le type n'est pas `true`, et il NOMME le code oublié. */
  type NonDocumentes = Exclude<CodeApi, CodeDocumenteNom>;
  const exhaustif: [NonDocumentes] extends [never] ? true : NonDocumentes = true;

  it('la parité avec CodeApi tient (au typage), et aucun code n’est documenté deux fois', () => {
    expect(exhaustif).toBe(true);
    expect(new Set(connus).size).toBe(CODES_DOCUMENTES.length);
  });

  it('un code sans statut d’erreur n’existe qu’en motif d’écart', () => {
    for (const c of CODES_DOCUMENTES) if (c.statut === null) expect(c.ecart, c.code).toBe(true);
  });

  /**
   * 🔴 LE STATUT ANNONCÉ EST CELUI DE LA TABLE DU SERVEUR (`STATUT_PAR_CODE`), et les motifs d'écart annoncés
   * sont ceux que `POST /v1/sends` peut rendre (`CODES_ECART`), dans les deux sens : la page ne peut ni
   * promettre un 409 pour un 422, ni taire un motif d'écart que l'intégrateur recevra.
   */
  it('statut et motif d’écart : ceux du serveur, dans les deux sens', () => {
    for (const c of CODES_DOCUMENTES) expect(c.statut, c.code).toBe(STATUT_PAR_CODE[c.code]);
    const ecarts = CODES_DOCUMENTES.filter((c) => c.ecart).map((c) => c.code).sort();
    expect(ecarts).toEqual([...CODES_ECART].sort());
  });
});

describe('les bornes affichées sont celles des routes', () => {
  it('lot, destinataires, écarts détaillés, durée de la clé d’idempotence : les constantes des routes', () => {
    expect(BORNES.contactsParLot).toBe(MAX_BATCH);
    expect(BORNES.destinatairesParEnvoi).toBe(MAX_RECIPIENTS);
    expect(BORNES.ecartsDetailles).toBe(MAX_SKIPPED_REPORT);
    expect(BORNES.dureeIdempotenceHeures * 3_600_000).toBe(DUREE_CLE_IDEMPOTENCE_MS);
  });

  it('le plafond de l’espace affiché est le défaut de la configuration (minute ET heure)', () => {
    expect({ minute: BORNES.plafondEspaceMinute, heure: BORNES.plafondEspaceHeure }).toEqual(PLAFOND_API_DEFAUT);
  });

  it('longueurs de texte et d’identifiant externe : ce que les validateurs acceptent, pas un caractère de plus', () => {
    const wa = EXEMPLES_CORPS.messageWhatsapp.corps;
    expect(schemaMessageWhatsapp.safeParse({ ...wa, text: 'a'.repeat(BORNES.texteWhatsapp) }).success).toBe(true);
    expect(schemaMessageWhatsapp.safeParse({ ...wa, text: 'a'.repeat(BORNES.texteWhatsapp + 1) }).success).toBe(false);
    const rcs = EXEMPLES_CORPS.messageRcs.corps;
    expect(schemaMessageRcs.safeParse({ ...rcs, text: 'a'.repeat(BORNES.texteRcs) }).success).toBe(true);
    expect(schemaMessageRcs.safeParse({ ...rcs, text: 'a'.repeat(BORNES.texteRcs + 1) }).success).toBe(false);
    expect(schemaClesFiche.safeParse({ externalId: 'x'.repeat(BORNES.externalId) }).success).toBe(true);
    expect(schemaClesFiche.safeParse({ externalId: 'x'.repeat(BORNES.externalId + 1) }).success).toBe(false);
  });

  it('débit et destinataires par envoi : ce que le schéma de l’envoi accepte, pas une unité de plus', () => {
    const corps = EXEMPLES_CORPS.envoiTemplate.corps;
    // Spec § 3 : `ratePerMinute` hors de 1 à 80 rend 400, donc la borne vit dans le schéma de l'envoi.
    expect(schemaCorpsEnvoi.safeParse({ ...corps, ratePerMinute: BORNES.debitParMinute }).success).toBe(true);
    expect(schemaCorpsEnvoi.safeParse({ ...corps, ratePerMinute: BORNES.debitParMinute + 1 }).success).toBe(false);
    expect(schemaCorpsEnvoi.safeParse({ ...corps, ratePerMinute: 0 }).success).toBe(false);
    const un = corps.recipients[0];
    expect(schemaCorpsEnvoi.safeParse({ ...corps, recipients: Array(BORNES.destinatairesParEnvoi).fill(un) }).success).toBe(true);
    expect(schemaCorpsEnvoi.safeParse({ ...corps, recipients: Array(BORNES.destinatairesParEnvoi + 1).fill(un) }).success).toBe(false);
  });
});

/**
 * LES RÉPONSES MONTRÉES ONT LE TYPE DE CE QUE LEURS ROUTES RENDENT (au typage, donc à `npm run typecheck`).
 *
 * `Lecture<T>` : un exemple écrit `as const` est en lecture seule à toute profondeur, on le compare donc au
 * type du producteur rendu en lecture seule. Un champ MANQUANT ou MAL TYPÉ ne compile pas ; `MemesCles`
 * ferme l'autre sens (un champ EN TROP), que l'affectation seule laisserait passer, et nomme la clé fautive.
 *
 * ⚠️ Une réponse reste sans producteur typé, parce que sa route la rend par un objet littéral : `contactModifie`
 * (`{ contactId }`). `messageEnvoye` a le sien (`ReponseMessageSimple`, posé en `satisfies` sur les deux routes) :
 * son `conversationId` peut valoir `null` en RCS, et l'exemple, écrit en chaîne, l'aurait tu. Les réponses de
 * catalogue sont comparées plus bas à ce que produisent les fonctions de la route.
 */
type Lecture<T> = T extends ReadonlyArray<infer U>
  ? ReadonlyArray<Lecture<U>>
  : T extends object ? { readonly [K in keyof T]: Lecture<T[K]> } : T;
type MemesCles<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never]
  ? true
  : [enTrop: Exclude<keyof A, keyof B>, manquant: Exclude<keyof B, keyof A>];
/** Deux types ÉGAUX, dans les deux sens : l'affectation seule laisserait l'exemple plus étroit que la route. */
type Egal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const suivi: Lecture<SuiviEnvoiApi> = EXEMPLES_REPONSES.envoiSuivi;
const suiviCles: MemesCles<typeof EXEMPLES_REPONSES.envoiSuivi, SuiviEnvoiApi> = true;
const suiviLigneCles: MemesCles<(typeof EXEMPLES_REPONSES.envoiSuivi.recipients)[number], SuiviEnvoiApi['recipients'][number]> = true;
const cree: Lecture<RapportEnvoi> = EXEMPLES_REPONSES.envoiCree;
const creeCles: MemesCles<typeof EXEMPLES_REPONSES.envoiCree, RapportEnvoi> = true;
const envoye: Lecture<ReponseMessageSimple> = EXEMPLES_REPONSES.messageEnvoye;
const envoyeCles: MemesCles<typeof EXEMPLES_REPONSES.messageEnvoye, ReponseMessageSimple> = true;
// 🔴 `conversationId` : `string | null` des DEUX côtés. Écrit en chaîne, l'exemple promettait une chaîne à tout coup.
const envoyeConversation: Egal<(typeof EXEMPLES_REPONSES.messageEnvoye)['conversationId'], ReponseMessageSimple['conversationId']> = true;
const envoyeCanal: Egal<(typeof EXEMPLES_REPONSES.messageEnvoye)['channel'], ReponseMessageSimple['channel']> = true;
const fiche: Lecture<FicheApi> = EXEMPLES_REPONSES.contactLu;
const ficheCles: MemesCles<typeof EXEMPLES_REPONSES.contactLu, FicheApi> = true;
const trouve: Lecture<{ contact: FicheApi | null }> = EXEMPLES_REPONSES.contactTrouve;
const lot: ReadonlyArray<Lecture<ResultatFiche>> = EXEMPLES_REPONSES.contactsLot.results;
const ecrit: Lecture<Pick<Extract<ResultatFiche, { status: 'created' | 'updated' }>, 'contactId' | 'status'>> = EXEMPLES_REPONSES.contactEcrit;
// Les lignes de catalogue montrées ont les TYPES que la route rend (les clés sont comparées plus bas, à l'exécution).
const tpls: ReadonlyArray<Lecture<TemplateCatalogue>> = EXEMPLES_REPONSES.templates.templates;
const scns: ReadonlyArray<Lecture<ScenarioCatalogue>> = EXEMPLES_REPONSES.scenarios.scenarios;
const rcsLus: ReadonlyArray<Lecture<MessageRcsCatalogue>> = EXEMPLES_REPONSES.messagesRcs.rcsMessages;

describe('les réponses montrées ont le type de leurs producteurs', () => {
  it('suivi d’un envoi, rapport 201, fiche lue, recherche, lot, écriture, message simple (tenus au typage)', () => {
    expect([suiviCles, suiviLigneCles, creeCles, ficheCles, envoyeCles, envoyeConversation, envoyeCanal]).toEqual([true, true, true, true, true, true, true]);
    expect([suivi, cree, fiche, trouve, lot, ecrit, tpls, scns, rcsLus, envoye].every((v) => v !== null)).toBe(true);
  });
});

describe('les réponses de catalogue montrées ont EXACTEMENT les champs que la route rend', () => {
  const cles = (o: object): string[] => Object.keys(o).sort();

  it('templates', () => {
    const [rendu] = catalogueTemplates([{
      id: 'x', name: 'a', status: 'APPROVED', category: 'UTILITY', language: 'fr', body: 'Bonjour {{1}}',
      headerFormat: null, isCarousel: false, editable: true,
    }], []);
    expect(cles(EXEMPLES_REPONSES.templates)).toEqual(['templates']);
    expect(cles(EXEMPLES_REPONSES.templates.templates[0])).toEqual(cles(rendu!));
    expect(cles(EXEMPLES_REPONSES.templates.templates[0].variables[0])).toEqual(cles(rendu!.variables[0]!));
  });

  it('scénarios', () => {
    const [rendu] = catalogueScenarios([{ code: 'scn_x', name: 'a', publishedAt: null, graph: { nodes: [], edges: [] } }]);
    expect(cles(EXEMPLES_REPONSES.scenarios)).toEqual(['scenarios']);
    for (const s of EXEMPLES_REPONSES.scenarios.scenarios) expect(cles(s)).toEqual(cles(rendu!));
  });

  /**
   * 🔴 LE CODE DE BLOC MONTRÉ A LA FORME QUE LE CATALOGUE REND. Un code d'exemple d'une autre forme (un ULID en
   * minuscules, par exemple) serait copié par l'intégrateur comme modèle, et ne désignerait jamais un bloc réel.
   */
  it('chaque entryNode montré est un code que le catalogue rendrait', () => {
    for (const s of EXEMPLES_REPONSES.scenarios.scenarios) {
      const graph = { nodes: [{ id: 'e', type: 'quick_message' as const, position: { x: 0, y: 0 }, data: { body: 'Coucou', code: s.entryNode } }], edges: [] };
      const [rendu] = catalogueScenarios([{ code: s.code, name: s.name, publishedAt: null, graph }]);
      expect(rendu!.entryNode, s.name).toBe(s.entryNode);
    }
  });

  it('messages RCS', () => {
    const [rendu] = catalogueMessagesRcs([{ name: 'a', content: { kind: 'text', text: 'Bonjour' } }]);
    expect(cles(EXEMPLES_REPONSES.messagesRcs)).toEqual(['rcsMessages']);
    expect(cles(EXEMPLES_REPONSES.messagesRcs.rcsMessages[0])).toEqual(cles(rendu!));
  });
});

/**
 * 🔴 LES EXEMPLES SE RÉPONDENT, comme les routes : l'intégrateur qui suit la page lit le scénario dans le
 * catalogue, cherche son template d'ouverture dans le catalogue des templates, et construit `params` d'après ses
 * variables. Un exemple d'appel qui décrirait un autre nombre de variables que le template annoncé montrerait
 * un appel que la route refuse en 422, sans qu'aucun validateur de forme ne le voie.
 */
describe('les exemples de la page se répondent', () => {
  const [parTemplate, parSession] = EXEMPLES_REPONSES.scenarios.scenarios;

  it('l’appel de scénario décrit EXACTEMENT les variables du template d’ouverture annoncé, sans source « variable »', () => {
    expect(EXEMPLES_CORPS.envoiScenario.corps.target.scenario).toBe(parTemplate.code);
    const modele = EXEMPLES_REPONSES.templates.templates.find(
      (t) => t.name === parTemplate.openingTemplate?.name && t.language === parTemplate.openingTemplate?.language,
    );
    expect(modele, 'le template d’ouverture du scénario montré est absent du catalogue montré').toBeDefined();
    const params = EXEMPLES_CORPS.envoiScenario.corps.params;
    expect(params.map((p) => p.position)).toEqual(modele!.variables.map((v) => v.position));
    const sources: string[] = params.map((p) => p.source.type);
    expect(sources).not.toContain('variable');
  });

  it('l’appel de bloc vise le bloc d’entrée du scénario qui ouvre en session', () => {
    expect(parSession.opening).toBe('whatsapp_session');
    expect(EXEMPLES_CORPS.envoiBloc.corps.target.node).toBe(parSession.entryNode);
  });
});

describe('🔴 le module d’exemples ne nomme aucun outil tiers', () => {
  const module = readFileSync(new URL('../web/lib/api-exemples.ts', import.meta.url), 'utf8');
  it.each(OUTILS_TIERS.map(([nom, motif]) => ({ nom, motif })))('$nom', ({ motif }) => {
    expect(module).not.toMatch(motif);
  });
});

/**
 * LA DOCUMENTATION, PAGE PAR PAGE (refonte du 2026-09-25). Elle vivait dans UN fichier ; elle en compte désormais
 * plusieurs, déclarés dans UNE liste fermée (`FICHIERS_DOC`, `web/lib/doc-api-pages.ts`), et ce sont eux que ces
 * gardes lisent, jamais tout `web/`.
 *
 * 🔴 AUCUNE GARDE NE PASSE À VIDE : une liste de fichiers où l'on ne trouve plus ce qu'on cherchait rendrait un
 * vert qui ne prouve rien. Chaque garde exige donc d'avoir TROUVÉ l'élément attendu (chaque exemple affiché au
 * moins une fois, l'adresse dérivée exactement une fois), et la liste elle-même est comparée au dossier.
 */
describe('la documentation API (liste fermée de ses fichiers)', () => {
  const lire = (f: string): string => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const sansCommentaires = (texte: string): string => texte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sources = FICHIERS_DOC.map((f) => ({ f, code: sansCommentaires(lire(f)) }));
  const tout = sources.map((s) => s.code).join('\n');

  /** Les pages réellement posées sous `web/app/developers/api/`, plus la page MCP, qui prend le même cadre. */
  function pagesDuDossier(dossier: string): string[] {
    return readdirSync(new URL(`../${dossier}`, import.meta.url), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? pagesDuDossier(`${dossier}/${e.name}`) : e.name === 'page.tsx' ? [`${dossier}/${e.name}`] : []);
  }

  it('🔴 la liste est FERMÉE : chaque page du dossier y figure, et rien de plus', () => {
    const posees = [...pagesDuDossier('web/app/developers/api'), 'web/app/developers/mcp/page.tsx'].sort();
    expect(posees.length).toBeGreaterThanOrEqual(8);
    expect(PAGES_DOC.map((p) => p.fichier).sort()).toEqual(posees);
    for (const p of PAGES_DOC) expect(FICHIERS_DOC, p.fichier).toContain(p.fichier);
  });

  it('🔴 aucun fichier n’écrit d’objet JSON à la main : tout corps et toute réponse viennent du module', () => {
    // Un `{ "clé": …` dans la doc est un exemple que la suite ne verrait pas, donc un exemple qui peut mentir.
    for (const s of sources) expect(s.code, s.f).not.toMatch(/\{\s*\\?"[A-Za-z_]+\\?"\s*:/);
  });

  it('🔴 CHAQUE exemple du module est affiché par au moins une page', () => {
    for (const cle of Object.keys(EXEMPLES_CORPS)) expect(tout, `EXEMPLES_CORPS.${cle} n’est affiché nulle part`).toContain(`EXEMPLES_CORPS.${cle}`);
    for (const cle of Object.keys(EXEMPLES_REPONSES)) expect(tout, `EXEMPLES_REPONSES.${cle} n’est affiché nulle part`).toContain(`EXEMPLES_REPONSES.${cle}`);
  });

  it('elle dérive son adresse de BASE, en UN seul endroit (la règle de web/lib/api-base.test.ts)', () => {
    const definitions = sources.filter((s) => /const ADRESSE_API\b/.test(s.code));
    expect(definitions.map((s) => s.f)).toHaveLength(1);
    expect(definitions[0]!.code).toMatch(/const ADRESSE_API = BASE\./);
  });

  it.each(FICHIERS_DOC.flatMap((f) => OUTILS_TIERS.map(([nom, motif]) => ({ f, nom, motif }))))('🔴 $f ne nomme pas $nom', ({ f, motif }) => {
    expect(lire(f)).not.toMatch(motif);
  });
});
