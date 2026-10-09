import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { z as zod, type z } from 'zod';
import { contratOpenapi } from '../src/api/openapi';
import { ROUTES_V1 } from '../src/api/openapi/registre';
import { EVENEMENTS_OPENAPI, donneesDe, enveloppeEvenement } from '../src/api/openapi/evenements';
import * as R from '../src/api/openapi/reponses';
import { STATUT_PAR_CODE } from '../src/api/erreurs';
import { modulesDeRoutes } from '../src/server';
import {
  CHAMPS_DU_TYPE, TYPES_ABONNABLES, TYPE_BESOIN_REPONSE, TYPE_DU_SIGNAL, TYPE_ESSAI, donneesDuSignal, donneesEssai,
  donneesStatutModele, enveloppe, type TypeEvenement,
} from '../src/evenements/types';
import { creerDemandeALApplication } from '../src/evenements/besoin-reponse';
import { RAISONS_RISQUE } from '../src/engagement/risque';
import type { ContactDuSignal, ContenuSignal, Signal } from '../src/signaux/types';
import type { FicheApi, LastAnalysis, EngagementRisk, ResultatFiche } from '../src/api/contacts-v1';
import type { ConversationV1, MessageV1, PageV1 } from '../src/api/conversations-v1';
import type { SuiviEnvoiApi } from '../src/api/suivi-envoi';
import type { RapportEnvoi } from '../src/http/v1-sends';
import type { ReponseMessageSimple } from '../src/http/v1-messages';
import type { ChampV1 } from '../src/http/v1-contacts-admin';
import type {
  DeliveryV1, EssaiWebhookV1, JournalWebhookV1, ListeWebhooksV1, RejeuEchecsV1, RejeuV1, SecretTourneV1, WebhookCreeV1, WebhookV1,
} from '../src/http/v1-webhooks';
import type { ModeleCree, StatutLangue } from '../src/api/creer-modele';
import type {
  CatalogueMessagesRcsV1, CatalogueScenariosV1, CatalogueTemplatesV1, MessageRcsCatalogue, ScenarioCatalogue, TemplateCatalogue,
} from '../src/http/v1-catalogues';
import { ENDPOINTS, GROUPES_ENDPOINTS, cleEndpoint } from '../web/lib/api-doc-endpoints';
import { EXEMPLES_CORPS, EXEMPLES_REPONSES } from '../web/lib/api-exemples';
import { GardeUsageMemoire } from './aide/usage';

/**
 * LE CONTRAT OPENAPI DIT CE QUE L'API FAIT (lot 16). Il se dérive du registre (`src/api/openapi/registre.ts`) ; ce
 * fichier tient le registre égal à l'index de la doc (lui-même tenu égal aux routes MONTÉES par
 * `tests/api-doc-endpoints.test.ts`), fait passer chaque exemple de la doc dans les schémas du contrat, produit chaque
 * événement par les VRAIS constructeurs du serveur, et exige au typage que chaque schéma de réponse soit le type que sa
 * route rend.
 */

const cle = (r: { methode: string; chemin: string }): string => `${r.methode} ${r.chemin}`;
const route = (k: string) => {
  const r = ROUTES_V1.find((x) => cle(x) === k);
  if (!r) throw new Error(`route absente du registre : ${k}`);
  return r;
};

// ---------------------------------------------------------------------------------------------------------------------
// Au typage : chaque schéma de réponse EST le type que sa route rend, dans les deux sens, clés comprises.
// ---------------------------------------------------------------------------------------------------------------------
type Pareil<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Meme<A, B> = Pareil<A, B> extends true ? Pareil<keyof A, keyof B> : false;
type Sortie<S extends z.ZodType> = z.output<S>;

const typeFiche: Meme<Sortie<typeof R.ficheApi>, FicheApi> = true;
const typeAnalyse: Meme<Sortie<typeof R.lastAnalysis>, LastAnalysis> = true;
const typeRisque: Meme<Sortie<typeof R.engagementRisk>, EngagementRisk> = true;
const typeResultat: Pareil<Sortie<typeof R.resultatFiche>, ResultatFiche> = true;
const typeConversation: Meme<Sortie<typeof R.conversationV1>, ConversationV1> = true;
const typeMessage: Meme<Sortie<typeof R.messageV1>, MessageV1> = true;
const typePage: Meme<Sortie<ReturnType<typeof R.pageV1<typeof R.messageV1>>>, PageV1<MessageV1>> = true;
const typeSuivi: Meme<Sortie<typeof R.suiviEnvoi>, SuiviEnvoiApi> = true;
const typeRapport: Meme<Sortie<typeof R.rapportEnvoi>, RapportEnvoi> = true;
const typeSimple: Meme<Sortie<typeof R.reponseMessageSimple>, ReponseMessageSimple> = true;
const typeChamp: Meme<Sortie<typeof R.champV1>, ChampV1> = true;
const typeWebhook: Meme<Sortie<typeof R.webhookV1>, WebhookV1> = true;
const typeDelivery: Meme<Sortie<typeof R.deliveryV1>, DeliveryV1> = true;
const typeModele: Meme<Sortie<typeof R.modeleCree>, ModeleCree> = true;
const typeLangue: Meme<Sortie<typeof R.statutLangue>, StatutLangue> = true;
const typeTemplate: Meme<Sortie<typeof R.templateCatalogue>, TemplateCatalogue> = true;
const typeScenario: Meme<Sortie<typeof R.scenarioCatalogue>, ScenarioCatalogue> = true;
const typeRcs: Meme<Sortie<typeof R.messageRcsCatalogue>, MessageRcsCatalogue> = true;
// Les réponses que les handlers construisent en littéral : chacune y est tenue par `satisfies` sur ce type.
const typeListeWebhooks: Meme<Sortie<typeof R.listeWebhooks>, ListeWebhooksV1> = true;
const typeWebhookCree: Meme<Sortie<typeof R.webhookCree>, WebhookCreeV1> = true;
const typeSecret: Meme<Sortie<typeof R.secretTourne>, SecretTourneV1> = true;
const typeEssai: Meme<Sortie<typeof R.essaiWebhook>, EssaiWebhookV1> = true;
const typeJournal: Meme<Sortie<typeof R.journalWebhook>, JournalWebhookV1> = true;
const typeRejeu: Meme<Sortie<typeof R.rejeu>, RejeuV1> = true;
const typeRejeuEchecs: Meme<Sortie<typeof R.rejeuEchecs>, RejeuEchecsV1> = true;
const typeCatTemplates: Meme<Sortie<typeof R.reponseTemplates>, CatalogueTemplatesV1> = true;
const typeCatScenarios: Meme<Sortie<typeof R.reponseScenarios>, CatalogueScenariosV1> = true;
const typeCatRcs: Meme<Sortie<typeof R.reponseMessagesRcs>, CatalogueMessagesRcsV1> = true;
void [
  typeFiche, typeAnalyse, typeRisque, typeResultat, typeConversation, typeMessage, typePage, typeSuivi, typeRapport,
  typeSimple, typeChamp, typeWebhook, typeDelivery, typeModele, typeLangue, typeTemplate, typeScenario, typeRcs,
  typeListeWebhooks, typeWebhookCree, typeSecret, typeEssai, typeJournal, typeRejeu, typeRejeuEchecs, typeCatTemplates,
  typeCatScenarios, typeCatRcs,
];

describe('🔴 le registre du contrat est l’API documentée (donc montée)', () => {
  it('les mêmes routes dans les deux sens, chacune avec le droit, le groupe et la phrase de la doc', () => {
    expect(ROUTES_V1.map(cle).sort()).toEqual(ENDPOINTS.map(cleEndpoint).sort());
    for (const e of ENDPOINTS) {
      const r = route(cleEndpoint(e));
      expect(r.droit, cleEndpoint(e)).toBe(e.droit);
      expect(r.groupe, cleEndpoint(e)).toBe(GROUPES_ENDPOINTS.find((g) => g.cle === e.groupe)!.titre[1]);
      expect(r.resume, cleEndpoint(e)).toBe(e.resume[1]);
    }
  });

  it('chaque code d’erreur nommé est un code de route (jamais un motif d’écart seul)', () => {
    for (const r of ROUTES_V1) for (const c of r.erreurs) expect(STATUT_PAR_CODE[c], `${cle(r)} : ${c}`).not.toBeNull();
  });
});

describe('les exemples de la doc passent dans les schémas du contrat', () => {
  it('chaque corps d’exemple valide le corps de sa route', () => {
    for (const [nom, ex] of Object.entries(EXEMPLES_CORPS)) {
      const r = route(ex.route);
      expect(r.corps, nom).toBeDefined();
      const lu = r.corps!.safeParse(ex.corps);
      expect(lu.success, `${nom} : ${lu.success ? '' : JSON.stringify(lu.error.issues)}`).toBe(true);
    }
  });

  /** Chaque réponse d'exemple, et la route qui la rend. Exhaustif : un exemple ajouté sans sa route ne compile pas. */
  const ROUTE_DE_LA_REPONSE: Readonly<Record<keyof typeof EXEMPLES_REPONSES, string | null>> = {
    contactEcrit: 'POST /v1/contacts', contactsLot: 'POST /v1/contacts/batch', contactLu: 'GET /v1/contacts/{contactId}',
    contactTrouve: 'POST /v1/contacts/search', contactModifie: 'PATCH /v1/contacts/{contactId}',
    messageEnvoye: 'POST /v1/messages/whatsapp', envoiCree: 'POST /v1/sends', envoiSuivi: 'GET /v1/sends/{sendId}',
    templates: 'GET /v1/templates', scenarios: 'GET /v1/scenarios', messagesRcs: 'GET /v1/rcs-messages', erreur: null,
    conversationLue: 'GET /v1/conversations/{conversationId}', conversations: 'GET /v1/conversations',
    messageLu: 'GET /v1/messages/{messageId}', champs: 'GET /v1/fields', champCree: 'POST /v1/fields',
    ficheEffacee: 'DELETE /v1/contacts/{contactId}', webhook: 'GET /v1/webhooks/{webhookId}', webhooks: 'GET /v1/webhooks',
    webhookCree: 'POST /v1/webhooks', envoisWebhook: 'GET /v1/webhooks/{webhookId}/deliveries', modeleCree: 'POST /v1/templates',
    statutModele: 'GET /v1/templates/{name}', messagesDuFil: 'GET /v1/conversations/{conversationId}/messages',
  };

  it('chaque réponse d’exemple valide la réponse de sa route, sans une clé de plus', () => {
    for (const [nom, k] of Object.entries(ROUTE_DE_LA_REPONSE)) {
      const exemple = EXEMPLES_REPONSES[nom as keyof typeof EXEMPLES_REPONSES];
      if (k === null) {
        expect(Object.keys(exemple).sort(), nom).toEqual(['code', 'error']);
        expect(Object.keys(STATUT_PAR_CODE), nom).toContain((exemple as { code: string }).code);
        continue;
      }
      const schema = route(k).succes.schema;
      if (schema === null || schema === 'binaire') throw new Error(`${nom} : ${k} ne rend pas de JSON`);
      const lu = schema.safeParse(exemple);
      expect(lu.success, `${nom} : ${lu.success ? '' : JSON.stringify(lu.error.issues)}`).toBe(true);
      // `z.object` retire une clé inconnue au lieu de refuser : la relire égale à l'exemple dit qu'il n'y en avait pas.
      expect(lu.data, nom).toEqual(exemple);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Les événements : produits par les constructeurs du serveur, pas recopiés.
// ---------------------------------------------------------------------------------------------------------------------
const ID = '0b9d7a42-3c1e-4f5a-8d2b-6e7f8a9b0c1d';
const LE = '2026-10-09T10:00:00.000Z';
const CONTACT: ContactDuSignal = {
  contactId: '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01', telephone: '+33612345678', nom: 'Camille', externalId: 'crm-7781',
  optOutWhatsapp: false, optOutRcs: false, derniereAnalyse: null,
};
const SIGNAUX: ReadonlyArray<{ s: Signal; contenu: ContenuSignal }> = [
  {
    s: { nom: 'em_replied', id: ID, le: LE, waId: '33612345678', canal: 'whatsapp', bouton: 'Oui', messageId: 'wamid.x' },
    contenu: { nom: 'em_replied', canal: 'whatsapp', bouton: 'Oui' },
  },
  {
    s: { nom: 'em_message_delivered', id: ID, le: LE, waId: '33612345678', canal: 'whatsapp', messageId: 'wamid.y' },
    contenu: { nom: 'em_message_delivered', canal: 'whatsapp', origine: 'api', sendId: ID },
  },
  {
    s: { nom: 'em_message_read', id: ID, le: LE, waId: '33612345678', canal: 'rcs', messageId: 'rcs-1' },
    contenu: { nom: 'em_message_read', canal: 'rcs', origine: null, sendId: null },
  },
  {
    s: { nom: 'em_message_failed', id: ID, le: LE, waId: '33612345678', canal: 'whatsapp', messageId: 'wamid.z', motif: 'x', codeMeta: 131026 },
    contenu: { nom: 'em_message_failed', canal: 'whatsapp', origine: 'campagne', sendId: ID, motif: 'undeliverable', codeMeta: 131026 },
  },
  {
    s: { nom: 'em_link_clicked', id: ID, le: LE, contactId: CONTACT.contactId, lien: 'k3f9qa' },
    contenu: { nom: 'em_link_clicked', lien: 'k3f9qa', template: 'confirmation_commande', destination: 'https://www.exemple.fr/' },
  },
  {
    s: { nom: 'em_opted_out', id: ID, le: LE, waId: '33612345678', canal: 'whatsapp' },
    contenu: { nom: 'em_opted_out', canal: null, source: 'api' },
  },
  {
    s: { nom: 'em_conversation_analyzed', id: ID, le: LE, conversationId: ID },
    contenu: {
      nom: 'em_conversation_analyzed',
      analyse: {
        intent: 'question', sentiment: 'positif', satisfaction: 8, urgence: null, resolved: true, topic: 'livraison',
        actionSuggestion: 'aucune', handledBy: 'humain', exchangesCount: 4, summary: null,
      },
    },
  },
  {
    s: { nom: 'em_risk_changed', id: ID, le: LE, contactId: CONTACT.contactId, niveau: 'eleve', ancienNiveau: null, score: 70, raisons: [RAISONS_RISQUE[0]] },
    contenu: { nom: 'em_risk_changed', niveau: 'eleve', ancienNiveau: null, score: 70, raisons: [RAISONS_RISQUE[0]] },
  },
];

async function donneesDeLaDemande(): Promise<Record<string, unknown>> {
  let corps = '';
  const demande = creerDemandeALApplication({
    adresse: async () => ({ active: true, rang: 1 }),
    limiteAdresses: async () => null,
    fiche: async () => ({ ...CONTACT }),
    conversationId: async () => ID,
    messageRecu: async () => ({ type: 'text', text: 'Bonjour', transcription: null }),
    creerEnvoiNeuf: async (l) => { corps = l.corps; return ID; },
    enfiler: async () => undefined,
    maintenant: () => new Date(LE),
  });
  await demande.demander(ID, '33612345678', { adresseId: ID, messageDeclencheur: 'wamid.x', contenu: '' });
  return (JSON.parse(corps) as { data: Record<string, unknown> }).data;
}

describe('🔴 les événements du contrat sont ceux que le serveur envoie', () => {
  it('un schéma par type, avec les champs de CHAMPS_DU_TYPE, dans leur ordre', () => {
    expect(EVENEMENTS_OPENAPI.map((e) => e.type)).toEqual(Object.keys(CHAMPS_DU_TYPE));
    for (const t of Object.keys(CHAMPS_DU_TYPE) as TypeEvenement[]) expect(Object.keys(donneesDe(t).shape), t).toEqual([...CHAMPS_DU_TYPE[t]]);
  });

  it('chaque événement produit par le serveur valide son schéma, sans une clé de plus', async () => {
    const produits: Array<{ type: TypeEvenement; data: Record<string, unknown> }> = [
      ...SIGNAUX.map(({ s, contenu }) => ({
        type: TYPE_DU_SIGNAL[s.nom],
        data: donneesDuSignal(s, { id: ID, le: LE, contact: CONTACT, contenu }, { type: 'text', text: 'Bonjour', transcription: null }),
      })),
      {
        type: 'template.status_changed',
        data: donneesStatutModele({ event: 'REJECTED', message_template_id: '1489201163476524', message_template_name: 'commande_prete', message_template_language: 'fr', reason: 'INVALID_FORMAT' }),
      },
      { type: TYPE_BESOIN_REPONSE, data: await donneesDeLaDemande() },
      { type: TYPE_ESSAI, data: donneesEssai() },
    ];
    // Tous les types sont produits : un type ajouté au serveur sans son cas ici ferait passer ce test à vide.
    expect(produits.map((p) => p.type).sort()).toEqual([...TYPES_ABONNABLES, TYPE_BESOIN_REPONSE, TYPE_ESSAI].sort());
    for (const p of produits) {
      const lu = donneesDe(p.type).safeParse(p.data);
      expect(lu.success, `${p.type} : ${lu.success ? '' : JSON.stringify(lu.error.issues)}`).toBe(true);
      expect(lu.data, p.type).toEqual(p.data);
      const env = enveloppe({ id: 'evt_0123456789abcdef0123456789abcdef', type: p.type, le: LE, tenantId: ID, data: p.data });
      expect(enveloppeEvenement.safeParse(env).success, p.type).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Le document.
// ---------------------------------------------------------------------------------------------------------------------
type Objet = Record<string, unknown>;
const doc = contratOpenapi('https://api.exemple.fr') as Objet & { paths: Record<string, Record<string, Objet>>; webhooks: Objet };

function tousLesRefs(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => tousLesRefs(x, out));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === '$ref' && typeof x === 'string') out.push(x);
      else tousLesRefs(x, out);
    }
  }
  return out;
}

describe('le document est un OpenAPI 3.1 bien formé', () => {
  it('sa version, son serveur, une opération par route du registre', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers).toEqual([{ url: 'https://api.exemple.fr' }]);
    const operations = Object.entries(doc.paths).flatMap(([chemin, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${chemin}`));
    expect(operations.sort()).toEqual(ROUTES_V1.map(cle).sort());
  });

  it('des operationId uniques, chaque paramètre de chemin déclaré, un droit et une réponse de succès par opération', () => {
    const ids = Object.values(doc.paths).flatMap((ops) => Object.values(ops).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ROUTES_V1.length);
    for (const [chemin, ops] of Object.entries(doc.paths)) {
      const attendus = [...chemin.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      for (const [m, o] of Object.entries(ops)) {
        const declares = ((o.parameters ?? []) as Objet[]).filter((p) => p.in === 'path').map((p) => p.name).sort();
        expect(declares, `${m} ${chemin}`).toEqual(attendus);
        expect(typeof o['x-required-scope'], `${m} ${chemin}`).toBe('string');
        expect(Object.keys(o.responses as Objet).some((s) => s.startsWith('2')), `${m} ${chemin}`).toBe(true);
        expect(Object.keys(o.responses as Objet), `${m} ${chemin}`).toContain('401');
      }
    }
  });

  it('chaque référence se résout dans le document, et aucun schéma ne déclare sa propre version', () => {
    const refs = tousLesRefs(doc);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/'), ref).toBe(true);
      const cible = ref.slice(2).split('/').reduce<unknown>((o, k) => (o as Objet | undefined)?.[k], doc);
      expect(cible, ref).toBeDefined();
    }
    expect(JSON.stringify(doc)).not.toContain('"$schema"');
  });

  /** Le JSON Schema ÉMIS, pas le Zod d'origine : c'est lui que lisent un outil de requêtes et un générateur de client. */
  const corpsEmis = (k: string): z.ZodType => {
    const [methode, chemin] = k.split(' ');
    const op = doc.paths[chemin!]?.[methode!.toLowerCase()] as { requestBody?: { content: { 'application/json': { schema: unknown } } } } | undefined;
    if (!op?.requestBody) throw new Error(`pas de corps émis pour ${k}`);
    return zod.fromJSONSchema(op.requestBody.content['application/json'].schema as Parameters<typeof zod.fromJSONSchema>[0]);
  };

  it('🔴 chaque corps d’exemple de la doc valide le JSON Schema émis de sa route', () => {
    for (const [nom, ex] of Object.entries(EXEMPLES_CORPS)) {
      const lu = corpsEmis(ex.route).safeParse(ex.corps);
      expect(lu.success, `${nom} : ${lu.success ? '' : JSON.stringify(lu.error.issues)}`).toBe(true);
    }
  });

  it('🔴 un champ que la route exige est requis dans le JSON Schema émis, même passé par un preprocess', () => {
    const { category: _c, ...modeleSansCategorie } = EXEMPLES_CORPS.modeleMeta.corps;
    expect(corpsEmis('POST /v1/templates').safeParse(modeleSansCategorie).success).toBe(false);
    expect(route('POST /v1/templates').corps!.safeParse(modeleSansCategorie).success).toBe(false);
    const lieu = { to: '33612345678', type: 'location', location: { longitude: 2.35, name: 'Paris' } };
    expect(corpsEmis('POST /v1/messages').safeParse(lieu).success).toBe(false);
    expect(corpsEmis('POST /v1/messages').safeParse({ ...lieu, location: { ...lieu.location, latitude: 48.85 } }).success).toBe(true);
  });

  it('l’erreur n’exige que error (le gestionnaire commun rend { error } seul), et les webhooks ne demandent pas de clé', () => {
    const composants = doc.components as { schemas: { Error: { required: string[] } }; securitySchemes: { bearer: { description: string } } };
    expect(composants.schemas.Error.required).toEqual(['error']);
    expect(composants.securitySchemes.bearer.description).not.toMatch(/oauth/i);
    for (const [type, w] of Object.entries(doc.webhooks)) {
      const post = (w as { post: { security: unknown[]; parameters: Array<{ name: string }> } }).post;
      expect(post.security, type).toEqual([]);
      expect(post.parameters.map((p) => p.name), type).toEqual(['webhook-id', 'webhook-timestamp', 'webhook-signature']);
    }
  });

  it('une section webhooks par type d’événement, et aucune réponse ni événement fermé à un champ ajouté demain', () => {
    expect(Object.keys(doc.webhooks)).toEqual(Object.keys(CHAMPS_DU_TYPE));
    const reponses = Object.values(doc.paths).flatMap((ops) => Object.values(ops).map((o) => o.responses));
    expect(JSON.stringify([reponses, doc.webhooks])).not.toContain('"additionalProperties":false');
  });
});

describe('GET /openapi.json', () => {
  async function servir(base: string | null) {
    const m = modulesDeRoutes({ openapi: { contrat: contratOpenapi } } as never, new GardeUsageMemoire(), undefined, base).find((x) => x.nom === 'openapi');
    if (!m) throw new Error('le registre n’a pas d’entrée openapi');
    expect(m.acces).toBe('anonyme');
    expect(m.fourni).toBe(true);
    const app = Fastify({ logger: false });
    m.monte(app, {} as never);
    await app.ready();
    return app.inject({ method: 'GET', url: '/openapi.json' });
  }

  it('public, lisible d’un navigateur, égal au contrat', async () => {
    const r = await servir('https://api.exemple.fr');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(r.json()).toEqual(doc);
  });

  it('sans PUBLIC_API_URL, un serveur relatif plutôt qu’une adresse inventée', async () => {
    const r = await servir(null);
    expect(r.json().servers).toEqual([{ url: '/' }]);
  });

  it('câblé en production : sans sa dépendance, le registre ne le monte pas', () => {
    expect(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')).toMatch(/\n {4}openapi: \{ contrat: contratOpenapi \},\n/);
  });
});
