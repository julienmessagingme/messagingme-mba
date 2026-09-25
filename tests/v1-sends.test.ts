import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import { verdictLigne, type IdempotencyClaim } from '../src/api/idempotency-store.pg';
import { empreinteCorps } from '../src/api/idempotence';
import { formaterSuiviEnvoi } from '../src/api/suivi-envoi';
import { nomDuMessageRcs, PREFIXE_ENVOI_API } from '../src/api/cible-rcs';
import { appliquerConsentement, type IssueConsentement } from '../src/api/consentement';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { V1SendsRouteDeps, V1SendCreateInput } from '../src/http/v1-sends';
import type { BuiltRecipient, ContactEnvoi } from '../src/campaign/build';
import type { EnvoiApiBrut } from '../src/campaign/store.pg';
import type { ClesFiche, ModeCreation } from '../src/api/fiche';
import { modeleLuDe, verdictModele, type LectureModele } from '../src/api/modele-envoi';
import { catalogueTemplates } from '../src/http/v1-catalogues';
import type { TemplateSummary } from '../src/meta/templates';
import { lienTraceAvecJeton } from '../src/links/rewrite';
import type { WorkflowGraph, WorkflowNode } from '../src/workflow/graph';
import { cleApiDeTest } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';

/**
 * `POST /v1/sends` ET `GET /v1/sends/{sendId}` (spec 2026-09-24, § 3 et § 9).
 *
 * 🔴 LES TROIS DÉFAUTS DE LA SPEC ONT ICI LEUR TEST DE ROUTE, vérifié dans les deux sens : un contact bloqué
 * perdu en silence (1), l'API qui accepte ce que la console refuse (2), une cible `node` jugée sur le TYPE du
 * bloc au lieu de ce qu'il envoie en premier (3).
 *
 * ⚠️ Les cas de l'ancienne version de ce fichier sont conservés sous le nouveau contrat : destinataires
 * désignés par leur fiche (plus de chaînes nues), `out_of_window` devenu `window_closed`, `createMissing`
 * disparu (la création dépend de l'ouverture), `exigeFenetre24h` remplacé par `ouvertureApi` (ses cas vivent
 * dans `tests/ouverture-api.test.ts`).
 *
 * ⚠️ LES FICHES PORTENT DES IDENTIFIANTS AU FORMAT D'UN VRAI (`C1`…`C5`) : chaque destinataire passe par
 * `schemaClesFiche` (lot 1), dont `contactId` est un GUID. Un « c1 » serait écarté `invalid_recipient` avant
 * même d'atteindre la résolution, et presque tous les cas ci-dessous deviendraient verts ou rouges pour une
 * autre raison que la leur.
 *
 * ⚠️ LE CONSENTEMENT PASSE PAR LE VRAI `appliquerConsentement` (lot 1), sur un double du dépôt qui porte la
 * MÊME garde que `ecrireConsentementParId` : un `opted_in` ne lève jamais un STOP. C'est ce qui permet de
 * figer ici qu'un STOP ne se lève pas par un envoi, écritures et journal compris.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed() {}
}
const SEND_KEY = cleApiDeTest('envoi');
const NOSCOPE_KEY = cleApiDeTest('sans_scope');
const C1 = '11111111-1111-4111-8111-000000000001';
const C2 = '11111111-1111-4111-8111-000000000002';
const C3 = '11111111-1111-4111-8111-000000000003';
const C4 = '11111111-1111-4111-8111-000000000004';
const C5 = '11111111-1111-4111-8111-000000000005';

const PHONE = (n: number): string => `+3361234500${n}`;
const fiche = (id: string, n: number, over: Partial<ContactEnvoi> = {}): ContactEnvoi => ({
  id, phone_e164: PHONE(n), bsuid: null, profile_name: null, fields: {}, optInStatus: 'opted_in', bloque: false, rcsDesabonne: false, ...over,
});
const noeud = (id: string, type: WorkflowNode['type'], data: Record<string, unknown> = {}): WorkflowNode => ({ id, type, position: { x: 0, y: 0 }, data });

const G_TEMPLATE: WorkflowGraph = { nodes: [noeud('t', 'template', { templateName: 'promo' })], edges: [] };
const G_SESSION: WorkflowGraph = { nodes: [noeud('q', 'quick_message', { body: 'Bonjour' })], edges: [] };
const G_RCS: WorkflowGraph = { nodes: [noeud('r', 'rcs_message', { text: 'Carte' })], edges: [] };
const SCENARIOS: Record<string, WorkflowGraph> = { scn_template: G_TEMPLATE, scn_session: G_SESSION, scn_rcs: G_RCS, scn_vide: { nodes: [], edges: [] } };
/**
 * Les cibles `node` : `nod_<id du bloc>`.
 *
 * ⚠️ `debut` PRÉCÈDE la condition, et il est là pour le test du défaut 3 : sans lui, `cond` serait l'ENTRÉE
 * du scénario, et « juger depuis l'entrée » rendrait le même verdict que « juger depuis le bloc visé ». Un
 * template en entrée fait diverger les deux (l'entrée ouvre par un template, le bloc par un message de session).
 */
const G_NODES: WorkflowGraph = {
  nodes: [
    noeud('debut', 'template', { templateName: 'accueil' }),
    noeud('cond', 'condition'),
    noeud('qm', 'quick_message', { body: 'On en parle ?' }),
    noeud('rcs', 'rcs_message', { text: 'Carte' }),
    noeud('tpl', 'template', { templateName: 'relance' }),
    noeud('attente', 'wait', { seconds: 60 }),
    noeud('tpl2', 'template', { templateName: 'rappel' }),
  ],
  edges: [
    { id: 'e0', source: 'debut', target: 'cond' },
    { id: 'e1', source: 'cond', target: 'qm', sourceHandle: 'true' },
    { id: 'e2', source: 'attente', target: 'tpl2' },
  ],
};

interface Monde {
  fiches: Map<string, ContactEnvoi>;
  /** wa_id -> fenêtre ouverte. Absent = fermée. */
  fenetre: Map<string, boolean>;
  modele: LectureModele;
}

function app(over: Partial<Omit<V1SendsRouteDeps, 'usage'>> = {}, monde: Partial<Monde> = {}) {
  const m: Monde = {
    fiches: new Map([[C1, fiche(C1, 1)], [C2, fiche(C2, 2)]]),
    fenetre: new Map([['33612345001', true], ['33612345002', true]]),
    modele: { statut: 'approuve', categorie: 'utility', variables: 0 },
    ...monde,
  };
  const cap = {
    sends: [] as Array<{ input: V1SendCreateInput; recipients: BuiltRecipient[] }>,
    enqueued: [] as Array<{ id: string; rate: number | null }>,
    resolutions: [] as Array<{ cles: ClesFiche; creer: ModeCreation }>,
    /** Chaque demande d'écriture de consentement qui atteint le dépôt, écrite ou non. */
    consentements: [] as Array<{ contactId: string; consent: 'opted_in' | 'opted_out'; source: string; lecturesAvant: number }>,
    /** Ce que le dépôt a VRAIMENT écrit. */
    ecritures: [] as Array<{ contactId: string; consent: 'opted_in' | 'opted_out' }>,
    /** Les lignes du journal d'audit. */
    audits: [] as Array<{ action: string; contactId: string }>,
    lectures: 0,
    fenetresDemandees: [] as string[][],
  };
  const idem = new Map<string, { hash: string; sendId?: string; response?: unknown }>();
  const keys = new FakeApiKeys()
    .add(SEND_KEY, { id: 'k1', tenantId: 't1', scopes: ['sends:create'] })
    .add(NOSCOPE_KEY, { id: 'k2', tenantId: 't1', scopes: ['contacts:write'] });

  /** Double du dépôt : la MÊME règle que `PgContactStore.ecrireConsentementParId` (lot 1). */
  const ecrireConsentementParId = async (_t: string, id: string, statut: 'opted_in' | 'opted_out', source: string): Promise<IssueConsentement> => {
    cap.consentements.push({ contactId: id, consent: statut, source, lecturesAvant: cap.lectures });
    const f = m.fiches.get(id);
    if (!f) return 'absente';
    if (f.optInStatus === statut) return 'inchange';
    if (statut === 'opted_in' && f.optInStatus === 'opted_out') return 'refuse';
    f.optInStatus = statut;
    cap.ecritures.push({ contactId: id, consent: statut });
    return 'change';
  };

  const sends: Omit<V1SendsRouteDeps, 'usage'> = {
    resolveScenario: async (_t, ref) => {
      if (ref === 'Ambigu') return { ok: false, reason: 'ambiguous', matches: [{ id: 'a', name: 'Ambigu', graph: G_TEMPLATE }, { id: 'b', name: 'Ambigu', graph: G_TEMPLATE }] };
      const graph = SCENARIOS[ref];
      return graph ? { ok: true, value: { id: `wf-${ref}`, name: ref, graph } } : { ok: false, reason: 'not_found' };
    },
    resolveNode: async (_t, code) => {
      const id = code.replace(/^nod_/, '');
      return G_NODES.nodes.some((n) => n.id === id)
        ? { ok: true, value: { workflowId: 'wf-nodes', nodeId: id, label: `Bloc ${id}`, graph: G_NODES } }
        : { ok: false, reason: 'not_found' };
    },
    lireModele: async () => m.modele,
    getWindowOpenByWaIds: async (_t, waIds) => { cap.fenetresDemandees.push(waIds); return new Map(waIds.map((w) => [w, m.fenetre.get(w) === true])); },
    getTenantPhoneNumberId: async () => 'pn-default',
    phoneNumberBelongsToTenant: async (pn) => pn === 'pn-mine',
    /** Double de la résolution du lot 1 : par contactId, numéro ou BSUID ; crée sur un numéro si on le demande. */
    resoudreFiche: async (tenant, cles, o) => {
      cap.resolutions.push({ cles, creer: o.creer });
      if (tenant !== 't1') return { ok: false, code: 'unknown_contact' };
      if (!cles.contactId && !cles.externalId && !cles.phone && !cles.bsuid) return { ok: false, code: 'invalid_recipient' };
      if (cles.phone !== undefined && !/^\+\d{8,15}$/.test(cles.phone)) return { ok: false, code: 'invalid_phone' };
      const toutes = [...m.fiches.values()];
      const trouvees = new Set<string>();
      if (cles.contactId) {
        if (!m.fiches.has(cles.contactId)) return { ok: false, code: 'unknown_contact' };
        trouvees.add(cles.contactId);
      }
      const parTel = cles.phone ? toutes.find((f) => f.phone_e164 === cles.phone) : undefined;
      if (parTel) trouvees.add(parTel.id);
      const parBsuid = cles.bsuid ? toutes.find((f) => f.bsuid === cles.bsuid) : undefined;
      if (parBsuid) trouvees.add(parBsuid.id);
      // L'identifiant externe : la fiche C1 porte `crm-7781` (le double ne connaît que celui-là).
      if (cles.externalId === 'crm-7781' && m.fiches.has(C1)) trouvees.add(C1);
      if (trouvees.size > 1) return { ok: false, code: 'identity_conflict' };
      const [id] = [...trouvees];
      if (id) return { ok: true, contactId: id, cree: false };
      if (o.creer === 'jamais' || !cles.phone) return { ok: false, code: 'unknown_contact' };
      const neuf = `n${m.fiches.size + 1}`;
      m.fiches.set(neuf, { ...fiche(neuf, 0), phone_e164: cles.phone, optInStatus: 'unknown' });
      return { ok: true, contactId: neuf, cree: true };
    },
    // Le VRAI `appliquerConsentement` du lot 1, comme le câblage de production (`depsConsentementDe`).
    appliquerConsentement: (tenant, contactId, consent, source) => appliquerConsentement(
      {
        ecrireConsentementParId,
        audit: async (_t, _acteur, action, cible) => { cap.audits.push({ action, contactId: cible.id }); },
      },
      tenant, contactId, consent, source,
    ),
    listContactsPourEnvoi: async (_t, ids) => {
      cap.lectures += 1;
      return ids.flatMap((id) => { const f = m.fiches.get(id); return f ? [{ ...f }] : []; });
    },
    createSend: async (input, recipients) => { cap.sends.push({ input, recipients }); return { campaignId: 'camp1', recipientCount: recipients.length }; },
    enqueue: async (id, _t, _n, rate) => { cap.enqueued.push({ id, rate }); },
    // Le MÊME verdict que le magasin : c'est sa fonction pure qui décide.
    idempotencyClaim: async (_t, key, empreinte): Promise<IdempotencyClaim> => {
      const ligne = idem.get(key);
      if (!ligne) { idem.set(key, { hash: empreinte }); return { claimed: true }; }
      return verdictLigne({ send_id: ligne.sendId ?? null, response: ligne.response ?? null, request_hash: ligne.hash }, empreinte);
    },
    idempotencyComplete: async (_t, key, sendId, response) => { const l = idem.get(key); if (l) { l.sendId = sendId; l.response = response; } },
    idempotencyRelease: async (_t, key) => { idem.delete(key); },
    lireEnvoi: async () => null,
    // La cible `rcsMessage` (lot 3) : un seul message dans la bibliothèque, un agent RCS actif.
    rcs: {
      messageRcsParNom: async (_t, nom) => (nom === 'relance-panier'
        ? { name: 'relance-panier', content: { kind: 'text', text: 'Votre commande {{commande}} est prête' } }
        : null),
      agentIdForTenant: async () => 'agent-1',
    },
    sleep: async () => {}, // pas de temporisation réelle dans les tests de retry
    ...over,
  };
  // Le module `/v1/contacts` n'est pas appelé ici : le double muet du lot 1 suffit à le monter.
  return { server: buildServer({ queue: new FakeQueue(), v1: { apiKeys: keys, contacts: contactsV1Muets(), sends } }), cap, idem, m };
}

const H = (key: string, idemKey?: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(idemKey ? { 'idempotency-key': idemKey } : {}) } });
const envoyer = (server: ReturnType<typeof app>['server'], payload: object, idemKey?: string, key = SEND_KEY) =>
  server.inject({ method: 'POST', url: '/v1/sends', ...H(key, idemKey), payload });

const TPL = { target: { template: { name: 'confirmation', language: 'fr' } } };
const SCN = (ref: string) => ({ target: { scenario: ref }, category: 'utility' as const });
const NODE = (code: string) => ({ target: { node: code }, category: 'utility' as const });
interface Rapport { sendId: string; opening: string; recipientCount: number; created: number; matched: number; skipped: Array<{ index: number; reason: string }>; skippedTotal: number }

describe('POST /v1/sends : cible template', () => {
  it('201 : catégorie LUE CHEZ META, ouverture whatsapp_template, campagne créée puis enfilée', async () => {
    const { server, cap } = app({}, { modele: { statut: 'approuve', categorie: 'marketing', variables: 0 } });
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-tpl');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ sendId: 'camp1', opening: 'whatsapp_template', recipientCount: 1, created: 0, matched: 1, skipped: [], skippedTotal: 0 });
    expect(cap.sends[0]!.input).toMatchObject({ category: 'marketing', templateName: 'confirmation', templateLanguage: 'fr', name: '[API] confirmation', phoneNumberId: 'pn-default' });
    expect(cap.sends[0]!.recipients.map((r) => r.toE164)).toEqual([PHONE(1)]);
    expect(cap.enqueued).toEqual([{ id: 'camp1', rate: null }]);
    await server.close();
  });

  it('🔴 elle ne transmet AUCUN choix de relance, et c’est ce qui lui garde la règle d’avant (0165)', async () => {
    // `insertCampaignRow` pose `reessai_par_campagne` sur `input.reessayer !== undefined` : ajouter
    // `reessayer: true` ici par symétrie avec la console ferait relancer chaque échec de l'API.
    const { server, cap } = app();
    await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-relance');
    expect(Object.keys(cap.sends[0]!.input)).not.toContain('reessayer');
    await server.close();
  });

  it('🔴 défaut 2 : un template absent ou non approuvé -> 404 template_not_found, RIEN n’est créé', async () => {
    const { server, cap } = app({}, { modele: { statut: 'absent' } });
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-absent');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'template_not_found' });
    expect(cap.sends).toHaveLength(0);
    expect(cap.resolutions).toHaveLength(0);
    await server.close();
  });

  it('catégorie illisible chez Meta -> 422 template_category_unknown, jamais « utility » par défaut', async () => {
    const { server, cap } = app({}, { modele: { statut: 'illisible' } });
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-illisible');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'template_category_unknown' });
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });

  it('⚠️ catégorie LUE mais non envoyable (authentication) -> 422 qui la nomme, sans inviter à réessayer', async () => {
    const { server, cap } = app({}, { modele: { statut: 'categorie_non_admise', categorie: 'authentication' } });
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-auth');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'template_category_unknown' });
    expect(res.json<{ error: string }>().error).toContain('authentication');
    expect(res.json<{ error: string }>().error).not.toMatch(/réessayez/);
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });

  it('une `category` envoyée sur un template -> 400 invalid_body : elle est lue chez Meta', async () => {
    const { server } = app();
    const res = await envoyer(server, { ...TPL, category: 'utility', recipients: [{ contactId: C1 }] }, 'i-cat');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(res.json<{ error: string }>().error).toContain('category');
    await server.close();
  });

  it('🔴 params malformé -> 400 déterministe, jamais un 500', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }], params: [{ position: 1, source: { key: 'prenom' } }] }, 'i-params-ko');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });
});

describe('POST /v1/sends : cible scénario', () => {
  it('un scénario qui ouvre par un template : 201, ouverture whatsapp_template, workflowId', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...SCN('scn_template'), recipients: [{ contactId: C1 }] }, 'i-scn');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ opening: 'whatsapp_template', recipientCount: 1 });
    expect(cap.sends[0]!.input).toMatchObject({ workflowId: 'wf-scn_template', category: 'utility', name: '[API] scn_template' });
    expect(cap.sends[0]!.input.startNodeId).toBeUndefined();
    await server.close();
  });

  it('🔴 défaut 2 : un scénario qui ouvre par un message de session -> 422 unsendable_target, comme la console', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...SCN('scn_session'), recipients: [{ contactId: C1 }] }, 'i-scn-session');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'unsendable_target' });
    // Le message DIT le chemin qui marche : viser le bloc.
    expect(res.json<{ error: string }>().error).toContain('node');
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });

  it('🔴 un scénario jamais publié -> 422 unsendable_target, et le message le dit', async () => {
    const { server } = app();
    const res = await envoyer(server, { ...SCN('scn_vide'), recipients: [{ contactId: C1 }] }, 'i-scn-vide');
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toMatch(/publi/);
    await server.close();
  });

  it('sans `category` ou avec une catégorie inconnue -> 400 ; des `params` sur un scénario qui ouvre en RCS -> 400', async () => {
    const { server } = app();
    expect((await envoyer(server, { target: { scenario: 'scn_template' }, recipients: [{ contactId: C1 }] }, 'i-sans-cat')).json()).toMatchObject({ code: 'invalid_body' });
    expect((await envoyer(server, { target: { scenario: 'scn_template' }, category: 'spam', recipients: [{ contactId: C1 }] }, 'i-cat-spam')).statusCode).toBe(400);
    // Un scénario qui ouvre en RCS n'a aucun template d'ouverture à paramétrer. (Ceux qui ouvrent par un
    // template acceptent `params` depuis le lot 3 : cf. le describe qui leur est consacré.)
    const params = [{ position: 1, source: { type: 'field', key: 'prenom' } }];
    const rcs = await envoyer(server, { ...SCN('scn_rcs'), recipients: [{ contactId: C1 }], params }, 'i-params');
    expect([rcs.statusCode, rcs.json<{ code: string }>().code]).toEqual([400, 'invalid_body']);
    await server.close();
  });

  it('introuvable -> 404 scenario_not_found ; nom ambigu -> 409 scenario_ambiguous ; bloc inconnu -> 404 node_not_found', async () => {
    const { server } = app();
    expect((await envoyer(server, { ...SCN('scn_absent'), recipients: [{ contactId: C1 }] }, 'i1')).json()).toMatchObject({ code: 'scenario_not_found' });
    const ambigu = await envoyer(server, { ...SCN('Ambigu'), recipients: [{ contactId: C1 }] }, 'i2');
    expect(ambigu.statusCode).toBe(409);
    expect(ambigu.json()).toMatchObject({ code: 'scenario_ambiguous' });
    const bloc = await envoyer(server, { ...NODE('nod_x'), recipients: [{ contactId: C1 }] }, 'i3');
    expect(bloc.statusCode).toBe(404);
    expect(bloc.json()).toMatchObject({ code: 'node_not_found' });
    await server.close();
  });

  it('la fenêtre n’est PAS interrogée pour un scénario ou un template', async () => {
    const { server, cap } = app();
    await envoyer(server, { ...SCN('scn_template'), recipients: [{ contactId: C1 }] }, 'i-nowin-1');
    await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-nowin-2');
    expect(cap.fenetresDemandees).toEqual([]);
    await server.close();
  });
});

describe('POST /v1/sends : cible node', () => {
  it('🔴 défaut 3 : un bloc CONDITION qui mène à un message rapide exige la fenêtre : fermée -> window_closed', async () => {
    const { server, cap } = app({}, { fenetre: new Map() });
    const res = await envoyer(server, { ...NODE('nod_cond'), recipients: [{ contactId: C1 }] }, 'i-cond');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ opening: 'whatsapp_session', recipientCount: 0, skipped: [{ index: 0, reason: 'window_closed' }], skippedTotal: 1 });
    expect(cap.sends[0]!.recipients).toEqual([]);
    await server.close();
  });

  it('bloc de session, fenêtre ouverte : 201, départ à CE bloc, libellé du bloc dans le nom', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...NODE('nod_qm'), recipients: [{ contactId: C1 }] }, 'i-qm');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ opening: 'whatsapp_session', recipientCount: 1 });
    expect(cap.sends[0]!.input).toMatchObject({ workflowId: 'wf-nodes', startNodeId: 'qm' });
    expect(cap.sends[0]!.input.name).toContain('Bloc qm');
    await server.close();
  });

  it('la fenêtre est interrogée avec le wa_id (chiffres nus), pas le E.164', async () => {
    const { server, cap } = app();
    await envoyer(server, { ...NODE('nod_qm'), recipients: [{ contactId: C1 }] }, 'i-waid');
    expect(cap.fenetresDemandees).toEqual([['33612345001']]);
    await server.close();
  });

  it('mélange ouvert / fermé : seul l’ouvert part', async () => {
    const { server, cap } = app({}, { fenetre: new Map([['33612345001', true], ['33612345002', false]]) });
    const res = await envoyer(server, { ...NODE('nod_qm'), recipients: [{ contactId: C1 }, { contactId: C2 }] }, 'i-mix');
    expect(res.json()).toMatchObject({ recipientCount: 1, skipped: [{ index: 1, reason: 'window_closed' }] });
    expect(cap.sends[0]!.recipients.map((r) => r.toE164)).toEqual([PHONE(1)]);
    await server.close();
  });

  it('ouverture de session : un numéro INCONNU est écarté unknown_contact, AUCUNE fiche créée', async () => {
    const { server, cap, m } = app();
    const res = await envoyer(server, { ...NODE('nod_qm'), recipients: [{ phone: '+33700000009' }] }, 'i-inconnu');
    expect(res.json()).toMatchObject({ created: 0, skipped: [{ index: 0, reason: 'unknown_contact' }] });
    expect(cap.resolutions[0]!.creer).toBe('jamais');
    expect(m.fiches.size).toBe(2);
    await server.close();
  });

  it('bloc TEMPLATE : ouverture whatsapp_template, fenêtre NON interrogée, un numéro inconnu est créé', async () => {
    const { server, cap } = app({}, { fenetre: new Map() });
    const res = await envoyer(server, { ...NODE('nod_tpl'), recipients: [{ phone: '+33700000008' }] }, 'i-bloc-tpl');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ opening: 'whatsapp_template', created: 1, recipientCount: 1, skipped: [] });
    expect(cap.fenetresDemandees).toEqual([]);
    expect(cap.resolutions[0]!.creer).toBe('phone');
    await server.close();
  });

  it('🔴 l’identifiant externe ATTEINT la résolution, avec le numéro, et le consentement n’y entre pas', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...TPL, recipients: [{ externalId: 'crm-7781', phone: PHONE(1), consent: 'opted_in' }] }, 'i-externe');
    expect(res.json()).toMatchObject({ recipientCount: 1, matched: 1, created: 0 });
    expect(cap.resolutions[0]!.cles).toEqual({ externalId: 'crm-7781', phone: PHONE(1) });
    await server.close();
  });

  it('bloc RCS : la fenêtre n’est PAS interrogée, et un numéro inconnu est CRÉÉ (joignable sans avoir écrit)', async () => {
    const { server, cap } = app({}, { fenetre: new Map() });
    const res = await envoyer(server, { ...NODE('nod_rcs'), recipients: [{ phone: '+33700000009' }] }, 'i-rcs');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ opening: 'rcs', created: 1, recipientCount: 1, skipped: [] });
    expect(cap.resolutions[0]!.creer).toBe('phone');
    expect(cap.fenetresDemandees).toEqual([]);
    expect(cap.sends[0]!.recipients.map((r) => r.toE164)).toEqual(['+33700000009']);
    await server.close();
  });

  it('bloc RCS : une fiche sans numéro est `no_phone`, un STOP RCS est `opted_out`', async () => {
    const fiches = new Map<string, ContactEnvoi>([
      [C3, fiche(C3, 3, { phone_e164: null, bsuid: 'BS3' })],
      [C4, fiche(C4, 4, { rcsDesabonne: true })],
    ]);
    const { server } = app({}, { fiches });
    const res = await envoyer(server, { ...NODE('nod_rcs'), recipients: [{ contactId: C3 }, { contactId: C4 }] }, 'i-rcs-ecarts');
    expect(res.json()).toMatchObject({ recipientCount: 0, skipped: [{ index: 0, reason: 'no_phone' }, { index: 1, reason: 'opted_out' }] });
    await server.close();
  });

  it('un bloc suivi d’une attente avant tout envoi -> 422 unsendable_target', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...NODE('nod_attente'), recipients: [{ contactId: C1 }] }, 'i-attente');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'unsendable_target' });
    expect(res.json<{ error: string }>().error).toContain('attente');
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });

  it('des params sur une cible node -> 400 (ils ne seraient jamais envoyés)', async () => {
    const { server, cap } = app();
    const params = [{ position: 1, source: { type: 'field', key: 'prenom' } }];
    const res = await envoyer(server, { ...NODE('nod_qm'), recipients: [{ contactId: C1 }], params }, 'i-node-params');
    expect(res.statusCode).toBe(400);
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });
});

describe('POST /v1/sends : le template d’un bloc est lu chez Meta, comme celui d’un scénario', () => {
  /**
   * 🔴 LE DÉFAUT : une cible `node` prenait la catégorie DÉCLARÉE, sans jamais lire le template qu'elle fait
   * partir. Le catalogue publie `entryNode` : le bloc d'entrée d'un scénario qui ouvre par un template marketing,
   * visé avec `category: "utility"`, partait aux contacts sans consentement et hors du plafond marketing. La cible
   * scénario, elle, lisait la catégorie chez Meta et gardait la plus stricte.
   */
  const INCONNU = new Map<string, ContactEnvoi>([[C1, fiche(C1, 1, { optInStatus: 'unknown' })]]);

  it('🔴 le bloc d’ENTRÉE d’un scénario à template marketing, visé en « utility » : marketing, et qui n’a pas consenti est écarté', async () => {
    const lus: string[] = [];
    const { server, cap } = app(
      { lireModele: async (_t, nom, langue) => { lus.push(`${nom}|${langue}`); return { statut: 'approuve', categorie: 'marketing', variables: 0 }; } },
      { fiches: INCONNU },
    );
    const res = await envoyer(server, { ...NODE('nod_debut'), recipients: [{ contactId: C1 }] }, 'i-node-marketing');
    expect(res.statusCode).toBe(201);
    // Le template qui part DE CE BLOC, dans la langue de l'exécuteur (`fr` par défaut).
    expect(lus).toEqual(['accueil|fr']);
    expect(res.json()).toMatchObject({ opening: 'whatsapp_template', recipientCount: 0, skipped: [{ index: 0, reason: 'no_consent' }] });
    expect(cap.sends[0]!.input).toMatchObject({ category: 'marketing', startNodeId: 'debut' });
    await server.close();
  });

  it('un bloc template ailleurs dans le graphe : c’est SON template qui est lu, pas celui de l’entrée', async () => {
    const lus: string[] = [];
    const { server } = app({ lireModele: async (_t, nom, langue) => { lus.push(`${nom}|${langue}`); return { statut: 'approuve', categorie: 'utility', variables: 0 }; } });
    expect((await envoyer(server, { ...NODE('nod_tpl'), recipients: [{ contactId: C1 }] }, 'i-node-relance')).statusCode).toBe(201);
    expect(lus).toEqual(['relance|fr']);
    await server.close();
  });

  it('une déclaration plus STRICTE que la lecture est gardée : marketing déclaré sur un template utility reste marketing', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { target: { node: 'nod_tpl' }, category: 'marketing', recipients: [{ contactId: C1 }] }, 'i-node-strict');
    expect(res.statusCode).toBe(201);
    expect(cap.sends[0]!.input.category).toBe('marketing');
    await server.close();
  });

  it('illisible : 422 template_category_unknown ; absent : 404 ; non envoyable : 422 unsendable_target ; rien n’est créé', async () => {
    const cas: Array<[LectureModele, number, string]> = [
      [{ statut: 'illisible' }, 422, 'template_category_unknown'],
      [{ statut: 'absent' }, 404, 'template_not_found'],
      [{ statut: 'categorie_non_admise', categorie: 'authentication' }, 422, 'template_category_unknown'],
      [{ statut: 'non_envoyable', raison: 'son en-tête texte porte une variable, qu’aucun envoi ne remplit' }, 422, 'unsendable_target'],
    ];
    for (const [modele, statut, code] of cas) {
      const { server, cap } = app({}, { modele });
      const res = await envoyer(server, { ...NODE('nod_debut'), recipients: [{ contactId: C1 }] }, `i-node-${modele.statut}`);
      expect([res.statusCode, res.json<{ code: string }>().code], modele.statut).toEqual([statut, code]);
      expect(cap.sends, modele.statut).toEqual([]);
      expect(cap.resolutions, modele.statut).toEqual([]);
      await server.close();
    }
  });

  it('⚠️ le nombre de variables ne se compare pas : un bloc résout les siennes par les sources de la console', async () => {
    // `params` est refusé sur un bloc (400) : exiger qu'il couvre les variables du template refuserait tout
    // bloc dont le template en porte une, alors que l'exécuteur les résout contact par contact.
    const { server } = app({}, { modele: { statut: 'approuve', categorie: 'utility', variables: 2 } });
    expect((await envoyer(server, { ...NODE('nod_tpl'), recipients: [{ contactId: C1 }] }, 'i-node-vars')).statusCode).toBe(201);
    await server.close();
  });

  it('un bloc qui ouvre par un message de session ou en RCS n’est pas lu chez Meta, et garde la catégorie déclarée', async () => {
    let lectures = 0;
    const { server, cap } = app({ lireModele: async () => { lectures += 1; return { statut: 'absent' }; } });
    expect((await envoyer(server, { ...NODE('nod_qm'), recipients: [{ contactId: C1 }] }, 'i-node-qm')).statusCode).toBe(201);
    expect((await envoyer(server, { ...NODE('nod_rcs'), recipients: [{ contactId: C1 }] }, 'i-node-rcs')).statusCode).toBe(201);
    expect(lectures).toBe(0);
    expect(cap.sends.map((e) => e.input.category)).toEqual(['utility', 'utility']);
    await server.close();
  });
});

describe('POST /v1/sends et GET /v1/templates jugent un template de la MÊME façon', () => {
  /**
   * 🔴 LE DÉFAUT : le catalogue écartait un en-tête texte à variable, un bouton de lien à variable non tracé, un
   * carrousel ou un visuel que le moteur refuse ; l'envoi les acceptait en 201, puis chaque destinataire échouait.
   * Les deux jugent désormais par `raisonNonEnvoyable`, construite par `modeleLuDe` : la lecture partagée de
   * production (`templateVarInfo`) est exactement `verdictModele(modeleLuDe(tpl))`, ce que ce double reproduit.
   */
  const base = (over: Partial<TemplateSummary>): TemplateSummary => ({
    id: 'x', name: 'confirmation', status: 'APPROVED', category: 'UTILITY', language: 'fr', body: 'Votre commande est prête.',
    headerFormat: null, isCarousel: false, editable: true, ...over,
  });
  const carte = { mediaUrl: 'https://exemple.test/carte.jpg', mediaFormat: 'IMAGE' as const, body: 'Découvrez', buttons: [] };
  const CAS: Array<[string, TemplateSummary]> = [
    ['ordinaire', base({})],
    ['en-tête texte fixe', base({ headerFormat: 'TEXT', headerText: 'Votre commande' })],
    ['en-tête texte à variable', base({ headerFormat: 'TEXT', headerText: 'Commande {{1}}' })],
    ['bouton de lien fixe', base({ buttons: [{ type: 'URL', text: 'Voir', url: 'https://exemple.test/commande' }] })],
    ['bouton de lien à variable', base({ buttons: [{ type: 'URL', text: 'Voir', url: 'https://exemple.test/p/{{1}}' }] })],
    ['bouton de lien tracé à jeton', base({ buttons: [{ type: 'URL', text: 'Voir', url: lienTraceAvecJeton('https://api.messagingme.app', 'k3f9qa01j8z3') }] })],
    ['carrousel envoyable', base({ isCarousel: true, carousel: { cards: [carte, carte] } })],
    ['carrousel à variable', base({ isCarousel: true, carousel: { cards: [carte, { ...carte, body: 'Pour {{1}}' }] } })],
    ['carte sans visuel', base({ isCarousel: true, carousel: { cards: [{ ...carte, mediaUrl: undefined }] } })],
    ['image avec adresse', base({ headerFormat: 'IMAGE', headerMediaUrl: 'https://exemple.test/visuel.jpg' })],
    ['image sans adresse', base({ headerFormat: 'IMAGE' })],
    ['en-tête de localisation', base({ headerFormat: 'LOCATION' })],
    ['en attente', base({ status: 'PENDING' })],
    ['authentification', base({ category: 'AUTHENTICATION' })],
  ];

  it.each(CAS)('%s', async (_nom, t) => {
    const auCatalogue = catalogueTemplates([t], []).length === 1;
    const { server, cap } = app({ lireModele: async (_t, _n, langue) => verdictModele(modeleLuDe(t), langue) });
    const res = await envoyer(server, { target: { template: { name: t.name, language: 'fr' } }, recipients: [{ contactId: C1 }] }, 'i-parite');
    expect(res.statusCode === 201, `catalogue ${auCatalogue}, envoi ${res.statusCode} ${res.body}`).toBe(auCatalogue);
    expect(cap.sends.length === 1).toBe(auCatalogue);
    await server.close();
  });

  it('🔴 les cas d’écart existent des deux côtés : six acceptés, et un refusé dit pourquoi en 422 unsendable_target', async () => {
    // Sans ce témoin, une règle qui écarterait TOUT (ou rien) rendrait la parité ci-dessus verte.
    const acceptes = CAS.filter(([, t]) => catalogueTemplates([t], []).length === 1).map(([n]) => n);
    expect(acceptes).toEqual(['ordinaire', 'en-tête texte fixe', 'bouton de lien fixe', 'bouton de lien tracé à jeton', 'carrousel envoyable', 'image avec adresse']);
    const t = base({ headerFormat: 'TEXT', headerText: 'Commande {{1}}' });
    const { server, cap } = app({ lireModele: async (_t, _n, langue) => verdictModele(modeleLuDe(t), langue) });
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-entete-var');
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([422, 'unsendable_target']);
    // Le message dit POURQUOI, et où chercher ce qui peut partir.
    expect(res.json<{ error: string }>().error).toMatch(/en-tête texte porte une variable/);
    expect(res.json<{ error: string }>().error).toContain('GET /v1/templates');
    expect(cap.sends).toEqual([]);
    expect(cap.resolutions).toEqual([]);
    await server.close();
  });

  it('le template d’ouverture d’un scénario est jugé de même', async () => {
    const t = base({ buttons: [{ type: 'URL', text: 'Voir', url: 'https://exemple.test/p/{{1}}' }] });
    const { server, cap } = app({ lireModele: async (_t, _n, langue) => verdictModele(modeleLuDe(t), langue) });
    const res = await envoyer(server, { ...SCN('scn_template'), recipients: [{ contactId: C1 }] }, 'i-scn-non-envoyable');
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([422, 'unsendable_target']);
    expect(cap.sends).toEqual([]);
    await server.close();
  });
});

describe('POST /v1/sends : les destinataires', () => {
  it('🔴 défaut 1 : un contact BLOQUÉ est écarté blocked_contact, jamais compté puis perdu', async () => {
    const { server, cap } = app({}, { fiches: new Map([[C1, fiche(C1, 1, { bloque: true })]]) });
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-bloque');
    expect(res.json()).toMatchObject({ matched: 1, recipientCount: 0, skipped: [{ index: 0, reason: 'blocked_contact' }], skippedTotal: 1 });
    expect(cap.sends[0]!.recipients).toEqual([]);
    await server.close();
  });

  it('🔴 aucune perte silencieuse : chaque destinataire finit envoyé OU écarté, une seule fois, avec son index', async () => {
    const fiches = new Map<string, ContactEnvoi>([
      [C1, fiche(C1, 1, { fields: { prenom: 'Camille' } })],
      [C2, fiche(C2, 2, { bloque: true })],
      [C3, fiche(C3, 3, { optInStatus: 'opted_out' })],
      [C4, fiche(C4, 4, { optInStatus: 'unknown' })],
      [C5, fiche(C5, 5)],
    ]);
    const { server } = app({}, { fiches, modele: { statut: 'approuve', categorie: 'marketing', variables: 1 } });
    const recipients = [
      { contactId: C1 },                        // 0 : part
      null,                                       // 1 : invalid_recipient
      { phone: 'pas-un-numero' },                 // 2 : invalid_phone
      { bsuid: 'inconnu' },                       // 3 : unknown_contact (un envoi ne fonde pas une fiche sur un BSUID)
      { contactId: C1 },                        // 4 : duplicate
      { contactId: C1, phone: PHONE(2) },       // 5 : identity_conflict
      { contactId: C2 },                        // 6 : blocked_contact
      { contactId: C3 },                        // 7 : opted_out
      { contactId: C4 },                        // 8 : no_consent
      { contactId: C5 },                        // 9 : missing_variable (pas de prénom)
      { phone: '+33700000001' },                  // 10 : créé, puis no_consent (marketing)
    ];
    const params = [{ position: 1, source: { type: 'field', key: 'prenom' } }];
    const res = await envoyer(server, { ...TPL, recipients, params }, 'i-invariant');
    const body = res.json<Rapport>();
    expect(body.skipped).toEqual([
      { index: 1, reason: 'invalid_recipient' },
      { index: 2, reason: 'invalid_phone' },
      { index: 3, reason: 'unknown_contact' },
      { index: 4, reason: 'duplicate' },
      { index: 5, reason: 'identity_conflict' },
      { index: 6, reason: 'blocked_contact' },
      { index: 7, reason: 'opted_out' },
      { index: 8, reason: 'no_consent' },
      { index: 9, reason: 'missing_variable' },
      { index: 10, reason: 'no_consent' },
    ]);
    expect(body.recipientCount + body.skippedTotal).toBe(recipients.length);
    expect(new Set(body.skipped.map((s) => s.index)).size).toBe(body.skipped.length);
    expect(body).toMatchObject({ recipientCount: 1, created: 1, matched: 6 });
    await server.close();
  });

  it('l’adresse WhatsApp vient de la FICHE : désignée par son BSUID, une fiche à numéro part sur son numéro', async () => {
    const { server, cap } = app({}, { fiches: new Map([[C1, fiche(C1, 1, { bsuid: 'BS1' })]]) });
    await envoyer(server, { ...TPL, recipients: [{ bsuid: 'BS1' }] }, 'i-adresse');
    expect(cap.sends[0]!.recipients.map((r) => r.toE164)).toEqual([PHONE(1)]);
    await server.close();
  });

  it('un destinataire en chaîne nue (ancienne forme) est écarté invalid_recipient, il ne fait pas tomber l’envoi', async () => {
    const { server } = app();
    const res = await envoyer(server, { ...TPL, recipients: [PHONE(1), { contactId: C1 }] }, 'i-chaine');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ recipientCount: 1, skipped: [{ index: 0, reason: 'invalid_recipient' }] });
    await server.close();
  });

  it('un `contactId` qui n’est pas au format d’un identifiant est écarté invalid_recipient, sans aller le chercher', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: 'pas-un-uuid' }, { contactId: C1 }] }, 'i-pas-uuid');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ recipientCount: 1, skipped: [{ index: 0, reason: 'invalid_recipient' }] });
    expect(cap.resolutions.map((r) => r.cles.contactId)).toEqual([C1]);
    await server.close();
  });
});

describe('POST /v1/sends : le consentement par destinataire', () => {
  it('🔴 il est écrit AVANT la lecture des fiches, donc avant le tri marketing, et il est journalisé', async () => {
    const { server, cap } = app({}, { modele: { statut: 'approuve', categorie: 'marketing', variables: 0 }, fiches: new Map([[C1, fiche(C1, 1, { optInStatus: 'unknown' })]]) });
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1, consent: 'opted_in' }] }, 'i-consent');
    expect(res.json()).toMatchObject({ recipientCount: 1, skippedTotal: 0 });
    expect(cap.consentements).toEqual([{ contactId: C1, consent: 'opted_in', source: 'api', lecturesAvant: 0 }]);
    expect(cap.audits).toEqual([{ action: 'contact.optin', contactId: C1 }]);
    await server.close();
  });

  it('opted_out : écrit avec sa source, puis ce destinataire est écarté opted_out', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1, consent: 'opted_out', consentSource: 'formulaire-site' }] }, 'i-optout');
    expect(res.json()).toMatchObject({ recipientCount: 0, skipped: [{ index: 0, reason: 'opted_out' }] });
    expect(cap.consentements).toEqual([{ contactId: C1, consent: 'opted_out', source: 'formulaire-site', lecturesAvant: 0 }]);
    expect(cap.ecritures).toEqual([{ contactId: C1, consent: 'opted_out' }]);
    await server.close();
  });

  it('🔴 un STOP ne se lève pas par un envoi : `opted_in` sur une fiche désabonnée, écarté opted_out, rien d’écrit ni journalisé', async () => {
    // Décision de Julien du 2026-09-24, codée au lot 1. Un template UTILITY : seul le désabonnement peut
    // écarter ce destinataire, donc s'il partait, c'est que le STOP aurait été levé.
    const { server, cap, m } = app({}, { fiches: new Map([[C1, fiche(C1, 1, { optInStatus: 'opted_out' })]]) });
    const res = await envoyer(server, { ...TPL, recipients: [{ phone: PHONE(1), consent: 'opted_in' }] }, 'i-stop');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ matched: 1, recipientCount: 0, skipped: [{ index: 0, reason: 'opted_out' }], skippedTotal: 1 });
    expect(cap.ecritures).toEqual([]);
    expect(cap.audits).toEqual([]);
    expect(m.fiches.get(C1)!.optInStatus).toBe('opted_out');
    expect(cap.sends[0]!.recipients).toEqual([]);
    await server.close();
  });

  it('🔴 le refus porté par un DOUBLON n’est pas perdu : une seule écriture, le refus l’emporte, rien ne part', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1, consent: 'opted_in' }, { contactId: C1, consent: 'opted_out', consentSource: 'crm' }] }, 'i-doublon');
    expect(cap.consentements.map((c) => ({ consent: c.consent, source: c.source }))).toEqual([{ consent: 'opted_out', source: 'crm' }]);
    expect(res.json()).toMatchObject({ recipientCount: 0, skipped: [{ index: 0, reason: 'opted_out' }, { index: 1, reason: 'duplicate' }] });
    expect(cap.sends[0]?.recipients ?? []).toEqual([]);
    await server.close();
  });

  it('🔴 un doublon SANS consentement puis un doublon qui refuse : le refus est écrit, la personne n’est pas servie', async () => {
    const { server, cap, m } = app();
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }, { contactId: C1, consent: 'opted_out' }] }, 'i-doublon-2');
    expect(cap.ecritures).toEqual([{ contactId: C1, consent: 'opted_out' }]);
    expect(m.fiches.get(C1)!.optInStatus).toBe('opted_out');
    expect(res.json()).toMatchObject({ recipientCount: 0, skipped: [{ index: 0, reason: 'opted_out' }, { index: 1, reason: 'duplicate' }] });
    await server.close();
  });

  it('deux fois le même accord sur un doublon : une seule écriture', async () => {
    const { server, cap } = app({}, { fiches: new Map([[C1, fiche(C1, 1, { optInStatus: 'unknown' })]]) });
    await envoyer(server, { ...TPL, recipients: [{ contactId: C1, consent: 'opted_in' }, { contactId: C1, consent: 'opted_in' }] }, 'i-doublon-3');
    expect(cap.consentements.map((c) => c.consent)).toEqual(['opted_in']);
    await server.close();
  });

  it('un `consent` vide (variable de profil absente) vaut ABSENCE, comme sur /v1/contacts : le destinataire part', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1, consent: '', consentSource: ' ' }] }, 'i-consent-vide');
    expect(res.json()).toMatchObject({ recipientCount: 1, skippedTotal: 0 });
    expect(cap.consentements).toEqual([]);
    await server.close();
  });

  it('un `consent` inconnu (« oui ») écarte ce destinataire invalid_recipient, sans rien écrire', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1, consent: 'oui' }, { contactId: C2 }] }, 'i-consent-oui');
    expect(res.json()).toMatchObject({ recipientCount: 1, skipped: [{ index: 0, reason: 'invalid_recipient' }] });
    expect(cap.consentements).toEqual([]);
    await server.close();
  });
});

describe('POST /v1/sends : idempotence', () => {
  const CORPS = { ...TPL, recipients: [{ contactId: C1 }] };

  it('clé dans le CORPS seulement : acceptée, et le rejeu rend le même rapport sans seconde campagne', async () => {
    const { server, cap } = app();
    const r1 = await envoyer(server, { ...CORPS, idempotencyKey: 'k-corps' });
    const r2 = await envoyer(server, { ...CORPS, idempotencyKey: 'k-corps' });
    expect(r1.statusCode).toBe(201);
    expect(r2.json()).toEqual(r1.json());
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });

  it('clé en en-tête puis dans le corps, même demande : même empreinte, rejeu', async () => {
    const { server, cap } = app();
    const r1 = await envoyer(server, CORPS, 'k-mixte');
    const r2 = await envoyer(server, { ...CORPS, idempotencyKey: 'k-mixte' });
    expect(r2.statusCode).toBe(201);
    expect(r2.json()).toEqual(r1.json());
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });

  it('les deux, identiques : accepté', async () => {
    const { server } = app();
    expect((await envoyer(server, { ...CORPS, idempotencyKey: 'k-deux' }, 'k-deux')).statusCode).toBe(201);
    await server.close();
  });

  it('les deux, DIFFÉRENTES : 400 invalid_body, rien n’est créé', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...CORPS, idempotencyKey: 'k-b' }, 'k-a');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(cap.sends).toHaveLength(0);
    await server.close();
  });

  it('aucune clé : 400 idempotency_key_required', async () => {
    const { server } = app();
    const res = await envoyer(server, CORPS);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'idempotency_key_required' });
    await server.close();
  });

  it('🔴 la même clé avec un AUTRE corps : 422 idempotency_key_reused, jamais le rejeu silencieux du premier', async () => {
    const { server, cap } = app();
    const r1 = await envoyer(server, CORPS, 'k-reuse');
    const r2 = await envoyer(server, { ...TPL, recipients: [{ contactId: C2 }] }, 'k-reuse');
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(422);
    expect(r2.json()).toMatchObject({ code: 'idempotency_key_reused' });
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });

  it('un envoi identique en cours : 409 idempotency_in_progress', async () => {
    const { server, idem } = app();
    idem.set('k-busy', { hash: empreinteCorps(CORPS) });
    const res = await envoyer(server, CORPS, 'k-busy');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'idempotency_in_progress' });
    await server.close();
  });

  it('🔴 le rejeu d’un envoi SCELLÉ rend son rapport même si le template a changé depuis, et rien ne repart', async () => {
    // La clé est lue AVANT le numéro, la cible et le template : un rejeu légitime ne doit pas dépendre de
    // lectures qui bougent après coup, sinon l'intégrateur conclut à tort que rien n'est parti.
    const { server, cap, m } = app();
    const r1 = await envoyer(server, CORPS, 'k-scelle');
    m.modele = { statut: 'absent' };
    const r2 = await envoyer(server, CORPS, 'k-scelle');
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r2.json()).toEqual(r1.json());
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });

  it('un refus de cible LIBÈRE la clé : le même appel repart une fois le template approuvé', async () => {
    const { server, cap, m, idem } = app({}, { modele: { statut: 'absent' } });
    const r1 = await envoyer(server, CORPS, 'k-libere');
    expect(r1.statusCode).toBe(404);
    expect(idem.has('k-libere')).toBe(false);
    m.modele = { statut: 'approuve', categorie: 'utility', variables: 0 };
    const r2 = await envoyer(server, CORPS, 'k-libere');
    expect(r2.statusCode).toBe(201);
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });

  it('scelle l’idempotence AVANT enqueue : un échec d’enqueue -> 201 sans release (pas de double envoi au retry)', async () => {
    const order: string[] = [];
    let released = false;
    const { server } = app({
      createSend: async (_i, recipients) => { order.push('createSend'); return { campaignId: 'campX', recipientCount: recipients.length }; },
      idempotencyComplete: async () => { order.push('complete'); },
      enqueue: async () => { order.push('enqueue'); throw new Error('pg-boss down'); },
      idempotencyRelease: async () => { released = true; },
    });
    const res = await envoyer(server, CORPS, 'k-seal');
    expect(res.statusCode).toBe(201);
    expect(order).toEqual(['createSend', 'complete', 'enqueue', 'enqueue', 'enqueue']);
    expect(released).toBe(false);
    await server.close();
  });

  it('enqueue : échec TRANSITOIRE -> retry -> succès', async () => {
    let attempts = 0;
    let released = false;
    const { server } = app({
      enqueue: async () => { attempts += 1; if (attempts < 3) throw new Error('pg-boss saturé'); },
      idempotencyRelease: async () => { released = true; },
    });
    expect((await envoyer(server, CORPS, 'k-retry')).statusCode).toBe(201);
    expect(attempts).toBe(3);
    expect(released).toBe(false);
    await server.close();
  });

  it('enqueue : échec PERSISTANT -> borné à 3 tentatives, 201, idempotence toujours scellée', async () => {
    let attempts = 0;
    let released = false;
    const { server } = app({
      enqueue: async () => { attempts += 1; throw new Error('pg-boss down'); },
      idempotencyRelease: async () => { released = true; },
    });
    expect((await envoyer(server, CORPS, 'k-retry-ko')).statusCode).toBe(201);
    expect(attempts).toBe(3);
    expect(released).toBe(false);
    await server.close();
  });

  it('échec AVANT scellement (createSend lève) -> release (retry propre)', async () => {
    let released = false;
    const { server } = app({
      createSend: async () => { throw new Error('db down'); },
      idempotencyRelease: async () => { released = true; },
    });
    await expect(envoyer(server, CORPS, 'k-fail')).resolves.toMatchObject({ statusCode: 500 });
    expect(released).toBe(true);
    await server.close();
  });
});

describe('POST /v1/sends : forme, numéro, débit, droits', () => {
  it('ratePerMinute : entier de 1 à 80, sinon 400 (plus de ramenage ni d’extinction silencieuse)', async () => {
    const { server, cap } = app();
    for (const [i, r] of ([0, 81, 2.5, '20'] as const).entries()) {
      expect((await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }], ratePerMinute: r }, `i-rate-${i}`)).statusCode, String(r)).toBe(400);
    }
    expect((await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }], ratePerMinute: 20 }, 'i-rate-ok')).statusCode).toBe(201);
    expect(cap.enqueued).toEqual([{ id: 'camp1', rate: 20 }]);
    await server.close();
  });

  it('`createMissing` a disparu : 400 invalid_body qui le nomme', async () => {
    const { server } = app();
    const res = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }], createMissing: false }, 'i-cm');
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('createMissing');
    await server.close();
  });

  it('recipients vide ou de plus de 50 ; cible absente -> 400 qui décrit les cibles', async () => {
    const { server } = app();
    expect((await envoyer(server, { ...TPL, recipients: [] }, 'i-vide')).statusCode).toBe(400);
    const beaucoup = Array.from({ length: 51 }, () => ({ contactId: C1 }));
    expect((await envoyer(server, { ...TPL, recipients: beaucoup }, 'i-51')).statusCode).toBe(400);
    const sansCible = await envoyer(server, { recipients: [{ contactId: C1 }] }, 'i-sans-cible');
    expect(sansCible.statusCode).toBe(400);
    expect(sansCible.json<{ error: string }>().error).toContain('template');
    await server.close();
  });

  it('une chaîne VIDE vaut absence au premier niveau : phoneNumberId prend le numéro par défaut, category est ignorée ou requise', async () => {
    const { server, cap } = app();
    const vide = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }], phoneNumberId: '' }, 'i-pn-vide');
    expect(vide.statusCode).toBe(201);
    expect(cap.sends[0]!.input.phoneNumberId).toBe('pn-default');
    expect((await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }], category: '' }, 'i-cat-vide-tpl')).statusCode).toBe(201);
    const scn = await envoyer(server, { target: { scenario: 'scn_template' }, category: '', recipients: [{ contactId: C1 }] }, 'i-cat-vide-scn');
    expect(scn.statusCode).toBe(400);
    expect(scn.json()).toMatchObject({ code: 'invalid_body' });
    expect(scn.json().error).toMatch(/requise/);
    await server.close();
  });

  it('phoneNumberId d’un autre espace -> 400 invalid_body ; espace sans numéro -> 409 no_whatsapp_number', async () => {
    const { server } = app();
    expect((await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }], phoneNumberId: 'pn-autrui' }, 'i-pn')).json()).toMatchObject({ code: 'invalid_body' });
    await server.close();
    const sans = app({ getTenantPhoneNumberId: async () => null });
    const res = await envoyer(sans.server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-sans-pn');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'no_whatsapp_number' });
    await sans.server.close();
  });

  it('sans clé -> 401 unauthorized ; sans le droit sends:create -> 403 missing_scope', async () => {
    const { server } = app();
    const sans = await server.inject({ method: 'POST', url: '/v1/sends', headers: { 'content-type': 'application/json' }, payload: { ...TPL, recipients: [{ contactId: C1 }] } });
    expect(sans.statusCode).toBe(401);
    expect(sans.json()).toMatchObject({ code: 'unauthorized' });
    const scope = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-scope', NOSCOPE_KEY);
    expect(scope.statusCode).toBe(403);
    expect(scope.json()).toMatchObject({ code: 'missing_scope' });
    await server.close();
  });
});

describe('GET /v1/sends/{sendId}', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const BRUT: EnvoiApiBrut = {
    id: ID, status: 'running', createdAt: '2026-09-24T10:00:00.000Z', channel: 'whatsapp', templateName: 'confirmation', templateLanguage: 'fr',
    name: '[API] confirmation',
    workflowCode: null, startNodeId: null, graph: null,
    counts: { pending: 0, sending: 0, sent: 1, failed: 0, skipped: 0 },
    recipientsTotal: 1,
    recipients: [{ contactId: C1, externalId: 'crm-7781', rang: 1, canalEtage: 'whatsapp', status: 'sent', messageId: 'wamid.A', error: null, errorCode: null, sentAt: '2026-09-24T10:00:05.000Z', deliveryStatus: 'delivered', deliveryError: null }],
  };

  it('trouvé : 200 et le CONTRAT de l’API, pas l’objet de la console', async () => {
    const { server } = app({ lireEnvoi: async (id, t) => (id === ID && t === 't1' ? BRUT : null) });
    const res = await server.inject({ method: 'GET', url: `/v1/sends/${ID}`, ...H(SEND_KEY) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(formaterSuiviEnvoi(BRUT));
    await server.close();
  });

  it('inconnu -> 404 send_not_found ; identifiant qui n’est pas un uuid -> 404 aussi, sans lecture, jamais un 500', async () => {
    let lectures = 0;
    const { server } = app({ lireEnvoi: async () => { lectures += 1; return null; } });
    const inconnu = await server.inject({ method: 'GET', url: '/v1/sends/22222222-2222-4222-8222-222222222222', ...H(SEND_KEY) });
    expect(inconnu.statusCode).toBe(404);
    expect(inconnu.json()).toMatchObject({ code: 'send_not_found' });
    const pasUuid = await server.inject({ method: 'GET', url: '/v1/sends/inconnu', ...H(SEND_KEY) });
    expect(pasUuid.statusCode).toBe(404);
    expect(pasUuid.json()).toMatchObject({ code: 'send_not_found' });
    expect(lectures).toBe(1);
    await server.close();
  });
});

describe('POST /v1/sends : la cible rcsMessage et les variables par destinataire (lot 3)', () => {
  const RCS = (nom = 'relance-panier') => ({ target: { rcsMessage: nom }, category: 'utility' as const });

  it('🔴 201 : ouverture rcs, campagne RCS SANS numéro WhatsApp (l’espace n’en a même aucun), variables gardées', async () => {
    const { server, cap } = app({ getTenantPhoneNumberId: async () => null });
    const res = await envoyer(server, { ...RCS(), recipients: [{ contactId: C1, variables: { commande: '8412' } }] }, 'i-rcs-1');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ opening: 'rcs', recipientCount: 1, skipped: [] });
    expect(cap.sends[0]!.input).toMatchObject({
      channel: 'rcs', rcsAgentId: 'agent-1', phoneNumberId: '', name: '[API] relance-panier', category: 'utility',
      templateName: '', templateLanguage: '', paramMapping: [],
      rcsMessage: { kind: 'text', text: 'Votre commande {{commande}} est prête' },
    });
    expect(cap.sends[0]!.recipients).toEqual([{ contactId: C1, toE164: PHONE(1), resolvedParams: [], variables: { commande: '8412' } }]);
    await server.close();
  });

  it('un phoneNumberId fourni est IGNORÉ sur une cible rcsMessage (§ 3 : il reste optionnel, et un RCS part de l’agent)', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...RCS(), phoneNumberId: 'pn-autrui', recipients: [{ contactId: C1 }] }, 'i-rcs-pn');
    expect(res.statusCode).toBe(201);
    expect(cap.sends[0]!.input.phoneNumberId).toBe('');
    await server.close();
  });

  it('message inconnu : 404 ; contenu illisible : 422 ; canal éteint : 409 ; ni campagne, ni fiche résolue', async () => {
    const { server, cap } = app({
      rcs: {
        messageRcsParNom: async (_t, nom) => (nom === 'illisible' ? { name: 'illisible', content: null } : null),
        agentIdForTenant: async () => 'agent-1',
      },
    });
    const r1 = await envoyer(server, { ...RCS('inconnu'), recipients: [{ contactId: C1 }] }, 'i-rcs-404');
    expect([r1.statusCode, r1.json<{ code: string }>().code]).toEqual([404, 'rcs_message_not_found']);
    const r2 = await envoyer(server, { ...RCS('illisible'), recipients: [{ contactId: C1 }] }, 'i-rcs-422');
    expect([r2.statusCode, r2.json<{ code: string }>().code]).toEqual([422, 'unsendable_target']);
    expect(cap.sends).toEqual([]);
    expect(cap.resolutions).toEqual([]);
    await server.close();
    const eteint = app({ rcs: { messageRcsParNom: async () => ({ name: 'x', content: { kind: 'text', text: 'x' } }), agentIdForTenant: async () => null } });
    const r3 = await envoyer(eteint.server, { ...RCS('x'), recipients: [{ contactId: C1 }] }, 'i-rcs-409');
    expect([r3.statusCode, r3.json<{ code: string }>().code]).toEqual([409, 'rcs_not_enabled']);
    expect(eteint.cap.sends).toEqual([]);
    await eteint.server.close();
  });

  it('sans category : 400 ; params non vides : 400 ; une liste params VIDE vaut son absence', async () => {
    const { server, cap } = app();
    const sansCat = await envoyer(server, { target: { rcsMessage: 'relance-panier' }, recipients: [{ contactId: C1 }] }, 'i-rcs-cat');
    expect([sansCat.statusCode, sansCat.json<{ code: string }>().code]).toEqual([400, 'invalid_body']);
    const params = [{ position: 1, source: { type: 'literal', value: 'x' } }];
    expect((await envoyer(server, { ...RCS(), params, recipients: [{ contactId: C1 }] }, 'i-rcs-params')).statusCode).toBe(400);
    expect((await envoyer(server, { ...RCS(), params: [], recipients: [{ contactId: C1 }] }, 'i-rcs-params-vides')).statusCode).toBe(201);
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });

  it('🔴 un nom plus long que la bibliothèque n’en accepte : 400 invalid_body, rien n’est cherché', async () => {
    const { server, cap } = app();
    expect((await envoyer(server, { ...RCS('x'.repeat(121)), recipients: [{ contactId: C1 }] }, 'i-rcs-121')).statusCode).toBe(400);
    expect(cap.sends).toEqual([]);
    await server.close();
  });

  it('🔴 un nom de 120 caractères n’est PAS coupé : le suivi relit le message entier', async () => {
    const nom = 'x'.repeat(120);
    const { server, cap } = app({ rcs: { messageRcsParNom: async (_t, n) => ({ name: n, content: { kind: 'text', text: 'Bonjour' } }), agentIdForTenant: async () => 'agent-1' } });
    await envoyer(server, { ...RCS(nom), recipients: [{ contactId: C1 }] }, 'i-rcs-120');
    expect(cap.sends[0]!.input.name).toBe(`${PREFIXE_ENVOI_API}${nom}`);
    expect(nomDuMessageRcs(cap.sends[0]!.input.name)).toBe(nom);
    await server.close();
  });

  it('🔴 variables sur un scénario ou un bloc : 400 invalid_body, AVANT toute résolution de fiche', async () => {
    const { server, cap } = app();
    const r1 = await envoyer(server, { ...SCN('scn_template'), recipients: [{ contactId: C1 }, { contactId: C2, variables: { a: 'b' } }] }, 'i-var-scn');
    expect([r1.statusCode, r1.json<{ code: string }>().code]).toEqual([400, 'invalid_body']);
    expect(r1.json<{ error: string }>().error).toContain('recipients.1.variables');
    const r2 = await envoyer(server, { ...NODE('nod_qm'), recipients: [{ contactId: C1, variables: { a: 'b' } }] }, 'i-var-node');
    expect([r2.statusCode, r2.json<{ code: string }>().code]).toEqual([400, 'invalid_body']);
    expect(cap.resolutions).toEqual([]);
    expect(cap.sends).toEqual([]);
    await server.close();
  });

  it('un nom de variable invalide ÉCARTE ce destinataire (invalid_recipient), sans faire tomber l’envoi', async () => {
    const { server } = app();
    const res = await envoyer(server, { ...RCS(), recipients: [{ contactId: C1, variables: { 'a b': 'x' } }, { contactId: C2 }] }, 'i-var-nom');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ recipientCount: 1, skipped: [{ index: 0, reason: 'invalid_recipient' }] });
    await server.close();
  });

  it('🔴 STOP RCS : opted_out ; fiche sans numéro : no_phone (le tri du lot 2, sur l’ouverture rcs)', async () => {
    const fiches = new Map<string, ContactEnvoi>([
      [C3, fiche(C3, 3, { rcsDesabonne: true })],
      [C4, fiche(C4, 4, { phone_e164: null, bsuid: 'BS4' })],
    ]);
    const { server } = app({}, { fiches });
    const res = await envoyer(server, { ...RCS(), recipients: [{ contactId: C3 }, { contactId: C4 }] }, 'i-rcs-ecarts');
    expect(res.json()).toMatchObject({ recipientCount: 0, skipped: [{ index: 0, reason: 'opted_out' }, { index: 1, reason: 'no_phone' }] });
    await server.close();
  });

  it('template : la source « variable » lit la variable du destinataire, sinon missing_variable à son index', async () => {
    const { server, cap } = app({}, { modele: { statut: 'approuve', categorie: 'utility', variables: 1 } });
    const res = await envoyer(server, {
      ...TPL, params: [{ position: 1, source: { type: 'variable', key: 'commande' } }],
      recipients: [{ contactId: C1, variables: { commande: '8412' } }, { contactId: C2 }],
    }, 'i-tpl-var');
    expect(res.statusCode).toBe(201);
    expect(cap.sends[0]!.recipients.map((r) => r.resolvedParams)).toEqual([['8412']]);
    expect(res.json()).toMatchObject({ skipped: [{ index: 1, reason: 'missing_variable' }] });
    await server.close();
  });
});

describe('POST /v1/sends : les params d’un scénario qui ouvre par un template (correctif du lot 3)', () => {
  /**
   * 🔴 LE DÉFAUT : `params` était refusé sur toute cible scénario, alors qu'une campagne de scénario transmet ses
   * variables à son template d'ouverture (`startWorkflow`, `src/campaign/engine.ts`) et que la console
   * l'accepte. Un scénario qui ouvre par un template à variable rendait donc 201, puis chaque destinataire
   * échouait chez Meta (le template partait sans ses variables).
   */
  const PRENOM = [{ position: 1, source: { type: 'field', key: 'prenom' } }];
  const CAMILLE = new Map<string, ContactEnvoi>([[C1, fiche(C1, 1, { fields: { prenom: 'Camille' } })]]);

  it('🔴 le template d’ouverture attend une variable et aucun params ne la couvre : 422 unsendable_target, rien n’est créé', async () => {
    const { server, cap } = app({}, { modele: { statut: 'approuve', categorie: 'utility', variables: 1 } });
    const res = await envoyer(server, { ...SCN('scn_template'), recipients: [{ contactId: C1 }] }, 'i-scn-sans-params');
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([422, 'unsendable_target']);
    expect(res.json<{ error: string }>().error).toContain('promo');
    expect(cap.sends).toEqual([]);
    expect(cap.resolutions).toEqual([]);
    await server.close();
  });

  it('params qui la couvrent : 201, le mapping est gardé et la valeur part résolue avec le destinataire', async () => {
    const lus: string[] = [];
    const { server, cap } = app(
      { lireModele: async (_t, nom, langue) => { lus.push(`${nom}|${langue}`); return { statut: 'approuve', categorie: 'utility', variables: 1 }; } },
      { fiches: CAMILLE },
    );
    const res = await envoyer(server, { ...SCN('scn_template'), params: PRENOM, recipients: [{ contactId: C1 }] }, 'i-scn-params');
    expect(res.statusCode).toBe(201);
    // Le template d'OUVERTURE, lu chez Meta dans la langue du bloc (`fr` par défaut, comme l'exécuteur).
    expect(lus).toEqual(['promo|fr']);
    expect(cap.sends[0]!.input).toMatchObject({ workflowId: 'wf-scn_template', paramMapping: PRENOM });
    expect(cap.sends[0]!.recipients.map((r) => r.resolvedParams)).toEqual([['Camille']]);
    await server.close();
  });

  it('un nombre de params différent de celui du template : 422 ; la source « variable » sur un scénario : 400', async () => {
    const { server, cap } = app({}, { modele: { statut: 'approuve', categorie: 'utility', variables: 2 }, fiches: CAMILLE });
    const trop = await envoyer(server, { ...SCN('scn_template'), params: PRENOM, recipients: [{ contactId: C1 }] }, 'i-scn-compte');
    expect([trop.statusCode, trop.json<{ code: string }>().code]).toEqual([422, 'unsendable_target']);
    const variable = await envoyer(server, {
      ...SCN('scn_template'), params: [{ position: 1, source: { type: 'variable', key: 'commande' } }], recipients: [{ contactId: C1 }],
    }, 'i-scn-variable');
    expect([variable.statusCode, variable.json<{ code: string }>().code]).toEqual([400, 'invalid_body']);
    expect(cap.sends).toEqual([]);
    await server.close();
  });

  it('le template d’ouverture illisible chez Meta : 422 template_category_unknown ; absent : 404 template_not_found', async () => {
    const illisible = app({}, { modele: { statut: 'illisible' } });
    const r1 = await envoyer(illisible.server, { ...SCN('scn_template'), recipients: [{ contactId: C1 }] }, 'i-scn-illisible');
    expect([r1.statusCode, r1.json<{ code: string }>().code]).toEqual([422, 'template_category_unknown']);
    expect(illisible.cap.sends).toEqual([]);
    await illisible.server.close();
    const absent = app({}, { modele: { statut: 'absent' } });
    const r2 = await envoyer(absent.server, { ...SCN('scn_template'), recipients: [{ contactId: C1 }] }, 'i-scn-absent');
    expect([r2.statusCode, r2.json<{ code: string }>().code]).toEqual([404, 'template_not_found']);
    await absent.server.close();
  });

  it('🔴 la catégorie lue chez Meta ne se relâche jamais : un template marketing annoncé utility écarte qui n’a pas consenti', async () => {
    const { server, cap } = app({}, {
      modele: { statut: 'approuve', categorie: 'marketing', variables: 0 },
      fiches: new Map([[C1, fiche(C1, 1, { optInStatus: 'unknown' })]]),
    });
    const res = await envoyer(server, { ...SCN('scn_template'), recipients: [{ contactId: C1 }] }, 'i-scn-marketing');
    expect(res.json()).toMatchObject({ recipientCount: 0, skipped: [{ index: 0, reason: 'no_consent' }] });
    expect(cap.sends[0]!.input.category).toBe('marketing');
    await server.close();
  });

  it('un scénario qui ouvre en RCS n’est pas lu chez Meta, et garde la catégorie déclarée', async () => {
    let lectures = 0;
    const { server, cap } = app({ lireModele: async () => { lectures += 1; return { statut: 'absent' }; } });
    const res = await envoyer(server, { ...SCN('scn_rcs'), recipients: [{ contactId: C1 }] }, 'i-scn-rcs');
    expect(res.statusCode).toBe(201);
    expect(lectures).toBe(0);
    expect(cap.sends[0]!.input.category).toBe('utility');
    await server.close();
  });

  it('comme la cible template : un template à une variable sans params -> 422, et le bon nombre -> 201', async () => {
    const { server, cap } = app({}, { modele: { statut: 'approuve', categorie: 'utility', variables: 1 }, fiches: CAMILLE });
    const sans = await envoyer(server, { ...TPL, recipients: [{ contactId: C1 }] }, 'i-tpl-sans-params');
    expect([sans.statusCode, sans.json<{ code: string }>().code]).toEqual([422, 'unsendable_target']);
    const avec = await envoyer(server, { ...TPL, params: PRENOM, recipients: [{ contactId: C1 }] }, 'i-tpl-avec-params');
    expect(avec.statusCode).toBe(201);
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });
});
