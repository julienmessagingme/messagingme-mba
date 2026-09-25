import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import { estLourde, unitesDe } from '../src/api/usage-guard';
import { GardeUsageMemoire } from '../src/api/usage-guard.memoire';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { DepsRepondre } from '../src/inbox/repondre';
import type { OrigineMessage } from '../src/inbox/origine';
import type { ClesFiche, ModeCreation } from '../src/api/fiche';
import { cleApiDeTest } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';
import { NumeroDelieError, MESSAGE_NUMERO_DELIE } from '../src/meta/numero-delie';

/**
 * `POST /v1/messages/whatsapp` : UN SIMPLE TEXTE, À UNE FICHE, DANS LA FENÊTRE DE 24 H (spec 2026-09-24, § 4).
 *
 * 🔴 CE QUE CES CAS PROTÈGENT VRAIMENT, ET CE N'EST PAS LA ROUTE. La route ne décide de rien : elle résout
 * une fiche par la fonction partagée du lot 1, ouvre son fil, et appelle `repondreDansLaFenetre`, partagé
 * avec la console et le serveur MCP. Ce qui mérite un test, c'est que ce troisième appelant hérite bien des
 * mêmes garde-fous, et que les refus portent les codes unifiés.
 *
 * ⚠️ LES ASSERTIONS PORTENT SUR CE QUI PART ET SUR CE QUI EST ENREGISTRÉ, pas sur ce que la fonction rend.
 * ⚠️ Les cas de l'ancienne route sont conservés : `contact_inconnu` est devenu `unknown_contact`,
 * `contact_indisponible` `blocked_contact`, `contact_desabonne` `opted_out`, `aucun_numero`
 * `no_whatsapp_number` ; la normalisation du numéro vit désormais dans la résolution partagée.
 * ⚠️ Les fiches portent des identifiants au FORMAT d'un vrai (`C1`, `C2`) : le corps passe par
 * `schemaClesFiche` (lot 1), dont `contactId` est un GUID, et le schéma est STRICT ici. Un « c1 » rendrait
 * 400 `invalid_body` avant même la résolution.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed(): Promise<void> {}
}

const C1 = '11111111-1111-4111-8111-000000000001';
const C2 = '11111111-1111-4111-8111-000000000002';
const VALID = cleApiDeTest('valide');
const NOSCOPE = cleApiDeTest('sans_scope');
const NUMERO = '+33612345678';
const URL_WA = '/v1/messages/whatsapp';

interface Monde {
  /** La fiche que les clés désignent. `null` = inconnue. */
  fiche: { id: string } | null;
  /** `null` = fiche bloquée ou supprimée : `filDuContact` la dit injoignable. */
  conversation: string | null;
  /** La fiche est joignable mais n'a jamais écrit : aucun fil n'existe (`filDuContact` rend `sans_fil`). */
  sansFil: boolean;
  fenetreOuverte: boolean;
  desabonne: boolean;
  numeroDeLEspace: string | null;
  /** Le numéro a été DÉLIÉ depuis l'Accueil (migration 0180) : le point de passage des envois lève `NumeroDelieError`. */
  numeroDelie: boolean;
}

const MONDE: Monde = { fiche: { id: C1 }, conversation: 'conv-1', sansFil: false, fenetreOuverte: true, desabonne: false, numeroDeLEspace: 'pn1', numeroDelie: false };

function app(over: Partial<Monde> = {}) {
  const m: Monde = { ...MONDE, ...over };
  const envois: Array<{ to: string; text: string }> = [];
  const enregistres: Array<{ body: string; origine: OrigineMessage; auteur: string | null; type?: string }> = [];
  const desabonneLu: string[] = [];
  const prises: string[] = [];
  const resolutions: Array<{ tenant: string; cles: ClesFiche; creer: ModeCreation }> = [];
  const contextesLus: string[] = [];
  const filsCherches: string[] = [];
  const usage = new GardeUsageMemoire();

  const repondre: DepsRepondre = {
    getConversationContext: async (id, tenant) => {
      contextesLus.push(id);
      return tenant === 't1' && id === m.conversation ? { waId: '33612345678', lastInboundAt: null, windowOpen: m.fenetreOuverte } : null;
    },
    getTenantPhoneNumberId: async () => m.numeroDeLEspace,
    sendReply: async (_t, pn, to, text) => {
      if (m.numeroDelie) throw new NumeroDelieError(pn);
      envois.push({ to, text });
      return 'wamid.envoye';
    },
    estDesabonne: async (_t, waId) => { desabonneLu.push(waId); return m.desabonne; },
    recordOutbound: async (_id, body, _msgId, origine, type, _cat, _name, sender) => {
      enregistres.push({ body, origine, auteur: sender ?? null, type });
    },
    takeControl: async (_t, waId) => { prises.push(waId); },
  };

  const keys = new FakeApiKeys()
    .add(VALID, { id: 'k1', tenantId: 't1', scopes: ['sends:create'] })
    .add(NOSCOPE, { id: 'k2', tenantId: 't1', scopes: ['contacts:write'] });

  const server = buildServer({
    queue: new FakeQueue(),
    usage,
    v1: {
      apiKeys: keys,
      contacts: contactsV1Muets(),
      messages: {
        repondre,
        /** Double de la résolution du lot 1 : elle NORMALISE le numéro (format national compris). */
        resoudreFiche: async (tenant, cles, o) => {
          resolutions.push({ tenant, cles, creer: o.creer });
          if (!cles.contactId && !cles.externalId && !cles.phone && !cles.bsuid) return { ok: false, code: 'invalid_recipient' };
          const tel = cles.phone?.replace(/\s/g, '').replace(/^0/, '+33');
          if (tel !== undefined && !/^\+\d{8,15}$/.test(tel)) return { ok: false, code: 'invalid_phone' };
          if (cles.contactId === C2 && tel === NUMERO) return { ok: false, code: 'identity_conflict' };
          const designe = cles.contactId === C1 || tel === NUMERO || cles.externalId === 'crm-7781';
          return tenant === 't1' && designe && m.fiche ? { ok: true, contactId: m.fiche.id, cree: false } : { ok: false, code: 'unknown_contact' };
        },
        filDuContact: async (tenant, contactId) => {
          filsCherches.push(contactId);
          if (tenant !== 't1' || contactId !== C1 || m.conversation === null) return { etat: 'injoignable' };
          return m.sansFil ? { etat: 'sans_fil' } : { etat: 'fil', conversationId: m.conversation };
        },
      },
    },
  });
  return { server, envois, enregistres, desabonneLu, prises, resolutions, contextesLus, filsCherches, usage };
}

const auth = (key: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } });
const post = (server: ReturnType<typeof app>['server'], payload: unknown, key = VALID, url = URL_WA) =>
  server.inject({ method: 'POST', url, ...auth(key), payload: payload as object });

describe('POST /v1/messages/whatsapp', () => {
  it('par contactId -> 200, le texte PART, il est enregistré avec l’origine `api`, et le canal est dit', async () => {
    const { server, envois, enregistres, prises, resolutions } = app();
    const res = await post(server, { contactId: C1, text: 'bonjour' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messageId: 'wamid.envoye', conversationId: 'conv-1', channel: 'whatsapp' });
    expect(envois).toEqual([{ to: '33612345678', text: 'bonjour' }]);
    // 🔴 L'ORIGINE EST LE SUJET DE LA MIGRATION 0166 ; `auteur` à null : aucun opérateur ne signe.
    expect(enregistres).toEqual([{ body: 'bonjour', origine: 'api', auteur: null, type: 'text' }]);
    // Le fil est PRIS : le scénario cesse d'avancer seul, l'agent de Meta cesse de répondre.
    expect(prises).toEqual(['33612345678']);
    expect(resolutions[0]!.tenant).toBe('t1');
    await server.close();
  });

  it('🔴 un message simple ne CRÉE jamais de fiche : la route le demande à la résolution', async () => {
    const { server, resolutions } = app();
    await post(server, { phone: NUMERO, text: 'x' });
    expect(resolutions.map((r) => r.creer)).toEqual(['jamais']);
    await server.close();
  });

  it('par numéro ou par identifiant externe, relayés TELS QUELS à la résolution partagée', async () => {
    // La normalisation du numéro est tenue par les tests de `src/api/fiche.ts` : le double ne la prouve pas.
    const { server, envois, resolutions } = app();
    expect((await post(server, { phone: '06 12 34 56 78', text: 'salut' })).statusCode).toBe(200);
    expect((await post(server, { externalId: 'crm-7781', text: 'salut' })).statusCode).toBe(200);
    expect(resolutions.map((r) => r.cles)).toEqual([{ phone: '06 12 34 56 78' }, { externalId: 'crm-7781' }]);
    expect(envois).toHaveLength(2);
    await server.close();
  });

  it('⚠️ la clé neuve est RELAYÉE à la résolution (donc rattachée) même quand le message est refusé : comportement actuel, figé', async () => {
    const { server, envois, resolutions } = app({ fenetreOuverte: false });
    const res = await post(server, { contactId: C1, externalId: 'crm-7781', text: 'x' });
    expect(res.json()).toMatchObject({ code: 'window_closed' });
    expect(resolutions.map((r) => r.cles)).toEqual([{ contactId: C1, externalId: 'crm-7781' }]);
    expect(envois).toEqual([]);
    await server.close();
  });

  it('🔴 une fiche DÉSABONNÉE est refusée 409 opted_out, et RIEN ne part', async () => {
    const { server, envois, enregistres, desabonneLu } = app({ desabonne: true });
    const res = await post(server, { contactId: C1, text: 'bonjour' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'opted_out' });
    expect(desabonneLu, 'la garde doit avoir été INTERROGÉE').toEqual(['33612345678']);
    expect(envois).toEqual([]);
    expect(enregistres).toEqual([]);
    await server.close();
  });

  it('🔴 hors fenêtre de 24 h -> 422 window_closed, le message dit l’autre chemin, et rien ne part', async () => {
    const { server, envois } = app({ fenetreOuverte: false });
    const res = await post(server, { contactId: C1, text: 'bonjour' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'window_closed' });
    expect(res.json<{ error: string }>().error).toContain('/v1/sends');
    expect(envois).toEqual([]);
    await server.close();
  });

  /**
   * 🔴 LE DÉFAUT : la route OUVRAIT le fil (donc le créait) avant ses refus. Un appel vers une fiche qui n'avait
   * jamais écrit laissait un fil vide en tête de l'Inbox, puis rendait 422. Sans fil, aucun entrant : la
   * fenêtre est fermée par construction, et rien ne doit être écrit. Les dépendances de la route n'ont plus
   * AUCUNE fonction qui crée un fil (le câblage est gardé plus bas) : ce cas tient le refus lui-même.
   */
  it('🔴 une fiche SANS fil (elle n’a jamais écrit) -> 422 window_closed, rien n’est ouvert, envoyé ni inscrit', async () => {
    const { server, envois, enregistres, prises, contextesLus, desabonneLu, filsCherches } = app({ sansFil: true });
    const res = await post(server, { contactId: C1, text: 'bonjour' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'window_closed' });
    expect(res.json<{ error: string }>().error).toContain('/v1/sends');
    // Le fil a été CHERCHÉ, et c'est tout : aucune lecture de contexte, aucun envoi, aucune prise, aucune trace.
    expect(filsCherches).toEqual([C1]);
    expect(contextesLus).toEqual([]);
    expect(desabonneLu).toEqual([]);
    expect(envois).toEqual([]);
    expect(prises).toEqual([]);
    expect(enregistres).toEqual([]);
    await server.close();
  });

  it('🔴 une fiche BLOQUÉE ou SUPPRIMÉE -> 409 blocked_contact, et la fenêtre n’est même pas consultée', async () => {
    const { server, envois, desabonneLu, contextesLus } = app({ conversation: null });
    const res = await post(server, { contactId: C1, text: 'bonjour' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'blocked_contact' });
    expect(envois).toEqual([]);
    expect(desabonneLu).toEqual([]);
    expect(contextesLus).toEqual([]);
    await server.close();
  });

  it('une fiche inconnue -> 404 unknown_contact ; deux clés sur deux fiches -> 409 identity_conflict', async () => {
    const inconnue = app({ fiche: null });
    const r1 = await post(inconnue.server, { phone: NUMERO, text: 'x' });
    expect(r1.statusCode).toBe(404);
    expect(r1.json()).toMatchObject({ code: 'unknown_contact' });
    await inconnue.server.close();
    const { server } = app();
    const r2 = await post(server, { contactId: C2, phone: NUMERO, text: 'x' });
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toMatchObject({ code: 'identity_conflict' });
    await server.close();
  });

  /**
   * 🔴 LE NUMÉRO DÉLIÉ SORT DANS L'ENVELOPPE DE L'API, `{ error, code }`. Il remonte du point de passage des
   * envois en exception ; laissé au gestionnaire d'erreurs du serveur, il rendait un 409 `{ error }` SANS code,
   * qu'un programme ne peut traiter qu'en lisant la phrase.
   */
  it('🔴 numéro délié depuis l’Accueil -> 409 number_unlinked, la phrase dans `error`, et rien n’est enregistré', async () => {
    const { server, envois, enregistres } = app({ numeroDelie: true });
    const res = await post(server, { contactId: C1, text: 'x' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: MESSAGE_NUMERO_DELIE, code: 'number_unlinked' });
    expect(envois).toEqual([]);
    expect(enregistres).toEqual([]);
    await server.close();
  });

  it('aucun numéro WhatsApp sur l’espace -> 409 no_whatsapp_number, pas un 500', async () => {
    const { server, envois } = app({ numeroDeLEspace: null });
    const res = await post(server, { contactId: C1, text: 'x' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'no_whatsapp_number' });
    expect(envois).toEqual([]);
    await server.close();
  });

  it('corps invalide -> 400 invalid_body ; aucune clé -> 400 invalid_recipient ; numéro invalide -> 400 invalid_phone', async () => {
    const { server } = app();
    for (const corps of [{}, { contactId: C1 }, { contactId: C1, text: '' }, { contactId: C1, text: 'x'.repeat(4097) }, { contactId: C1, text: 123 }]) {
      const res = await post(server, corps);
      expect(res.statusCode, JSON.stringify(corps).slice(0, 60)).toBe(400);
      expect(res.json(), JSON.stringify(corps).slice(0, 60)).toMatchObject({ code: 'invalid_body' });
    }
    // L'ancienne forme `{ to, text }` est refusée en NOMMANT le champ : l'intégrateur sait quoi changer.
    const ancienne = await post(server, { to: NUMERO, text: 'x' });
    expect(ancienne.json()).toMatchObject({ code: 'invalid_body' });
    expect(ancienne.json<{ error: string }>().error).toContain('to');
    expect((await post(server, { text: 'x' })).json()).toMatchObject({ code: 'invalid_recipient' });
    expect((await post(server, { phone: '00', text: 'x' })).json()).toMatchObject({ code: 'invalid_phone' });
    await server.close();
  });

  it('un `contactId` qui n’est pas au format d’un identifiant -> 400 invalid_body qui le nomme, sans résolution ni envoi', async () => {
    const { server, envois, resolutions } = app();
    const res = await post(server, { contactId: 'pas-un-uuid', text: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(res.json<{ error: string }>().error).toContain('contactId');
    expect(resolutions).toEqual([]);
    expect(envois).toEqual([]);
    await server.close();
  });

  it('l’ancienne adresse `POST /v1/messages` n’existe plus', async () => {
    const { server } = app();
    expect((await post(server, { contactId: C1, text: 'x' }, VALID, '/v1/messages')).statusCode).toBe(404);
    await server.close();
  });

  it('sans Bearer -> 401 unauthorized ; clé sans le droit `sends:create` -> 403 missing_scope', async () => {
    const { server } = app();
    const sans = await server.inject({ method: 'POST', url: URL_WA, headers: { 'content-type': 'application/json' }, payload: { contactId: C1, text: 'x' } });
    expect(sans.statusCode).toBe(401);
    expect(sans.json()).toMatchObject({ code: 'unauthorized' });
    const scope = await post(server, { contactId: C1, text: 'x' }, NOSCOPE);
    expect(scope.statusCode).toBe(403);
    expect(scope.json()).toMatchObject({ code: 'missing_scope' });
    await server.close();
  });

  it('🔴 le tenant vient de la CLÉ, jamais du corps : un `tenantId` dans le corps est refusé, rien ne part', async () => {
    const { server, envois } = app();
    const res = await post(server, { contactId: C1, text: 'x', tenantId: 'autre-espace' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_body' });
    expect(envois).toEqual([]);
    await server.close();
  });

  it('un défaut de CLÉ (aucune clé, numéro illisible) est refusé AVANT le compteur, sans résolution', async () => {
    const { server, usage, resolutions } = app();
    expect((await post(server, { text: 'x' })).json()).toMatchObject({ code: 'invalid_recipient' });
    expect((await post(server, { phone: '00', text: 'x' })).json()).toMatchObject({ code: 'invalid_phone' });
    expect(usage.compteurs().find((c) => c.operation === 'messages.send')).toBeUndefined();
    expect(resolutions).toEqual([]);
    await post(server, { contactId: C1, text: 'x' });
    expect(usage.compteurs().find((c) => c.operation === 'messages.send')).toMatchObject({ appels: 1 });
    await server.close();
  });

  it('le garde d’usage compte UNE unité, et l’opération n’est pas « lourde »', () => {
    expect(unitesDe('messages.send', 999)).toBe(1);
    expect(estLourde('messages.send')).toBe(false);
  });
});

describe('câblage de /v1/messages/whatsapp, lu dans `src/index.ts`', () => {
  /**
   * 🔴 UN TEST DE SOURCE, POUR LA MÊME RAISON QUE `tests/v1-cablage.test.ts`. Une flèche à moins de paramètres
   * est assignable au contrat : `(tenant, cles) => resoudreFiche(contactStore, tenant, cles, { creer: 'phone' })`
   * compilerait, avalerait le `jamais` de la route, et un message simple CRÉERAIT des fiches. Le cas de route
   * ci-dessus ne le verrait pas (il monte un double), et celui de `/v1/sends` trouve déjà la même ligne dans
   * le bloc des envois : il faut donc la chercher DANS le bloc des messages.
   */
  it('🔴 la résolution de fiche lit le MÊME dépôt que `/v1/contacts`, et le mode de création de la route passe', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const debut = source.indexOf('      messages: {');
    const fin = source.indexOf('filDuContact: (tenant, contactId) => inboxStore.filDuContact(tenant, contactId)', debut);
    expect(debut, 'le bloc `messages:` du câblage').toBeGreaterThan(-1);
    expect(fin, 'la fin du bloc `messages:`').toBeGreaterThan(debut);
    expect(source.slice(debut, fin)).toMatch(/resoudreFiche: \(tenant, cles, o\) => resoudreFiche\(contactStore, tenant, cles, o\),/);
  });

  it('🔴 le fil est CHERCHÉ, jamais ouvert : le bloc `messages:` ne branche aucune fonction qui crée un fil', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const debut = source.indexOf('      messages: {');
    const fin = source.indexOf('      messagesRcs: {', debut);
    expect(fin, 'le bloc suivant, `messagesRcs:`').toBeGreaterThan(debut);
    const bloc = source.slice(debut, fin);
    expect(bloc).toContain('filDuContact: (tenant, contactId) => inboxStore.filDuContact(tenant, contactId)');
    expect(bloc).not.toMatch(/ouvrirConversation/);
  });
});
