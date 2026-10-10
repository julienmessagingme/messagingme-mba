import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { SignJWT } from 'jose';
import { signSession, verifySession } from '../src/auth/token';
import { inboxDepInerte, inboxInerte, opsInerte } from './routes-inertes';
import { accesOps, ADRESSE_OPS } from './acces-ops';
import { capturerJournal } from './journal';
import type { AuditSink } from '../src/audit/journal';

/**
 * Session d'OBSERVATION : entrer dans l'espace d'un client depuis la surface d'exploitation, pour voir ce
 * qu'il voit, sans rien pouvoir modifier.
 *
 * Ces tests portent sur la SÉCURITÉ, et c'est tout leur objet :
 *   - la porte ne s'ouvre qu'avec la session d'exploitation, jamais depuis un compte de la console ;
 *   - le jeton émis ne peut RIEN écrire, y compris sur une route ajoutée demain ;
 *   - il n'est pas révoqué par l'absence de compte dans l'espace visité ;
 *   - il porte l'adresse de l'exploitant qui observe, et la trace aussi.
 */
const SECRET = 'test-secret';
const acces = accesOps({ auth: { secret: SECRET } });
let OPS = '';
beforeAll(async () => {
  const s = buildServer({ queue: new FakeQueue(), auth: acces.auth });
  OPS = await acces.jeton(s);
  await s.close();
});
/** Un identifiant qui a la FORME d un uuid : il part tel quel dans un `where id = $1` sur une colonne
 *  `uuid`, et une valeur mal formee y fait LEVER Postgres au lieu de rendre zero ligne. */
const CONNU = '11111111-1111-4111-8111-111111111111';
const INCONNU = '22222222-2222-4222-8222-222222222222';

function app(over: Record<string, unknown> = {}) {
  return buildServer({
    queue: new FakeQueue(),
    auth: acces.auth,
    ops: {
      ...opsInerte,
      getTenantOverview: async () => [],
      getGlobalDaily: async () => [],
      getQueueLoad: async () => [],
      observerTenant: async (tenantId: string, observateur: string) =>
        tenantId === CONNU
          ? { token: await signSession({ userId: 'ops-observation', tenantId, role: 'admin', impersonated: true, observateur }, SECRET, '1h'), tenantName: 'Client Démo' }
          : null,
      ...over,
    },
    // Une route de LECTURE et une route d'ÉCRITURE, pour éprouver les deux côtés de la garde.
    inbox: {
      ...inboxInerte,
      inbox: {
        ...inboxDepInerte,
        listConversations: async () => [],
        getConversationContext: async () => ({ waId: '33611', windowOpen: true, lastInboundAt: null }),
        getMessages: async () => [],
        recordOutbound: async () => {},
      },
      repo: {
        getTenantPhoneNumberId: async () => 'pn1',
      },
      sendReply: async () => 'wamid.1',
      sendTemplateMessage: async () => 'wamid.2',
    },
  } as never);
}

const avecOps = (token: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

describe('POST /ops/observe : ouvrir la porte', () => {
  it('rend un jeton pour un espace connu, qui porte l’adresse de l’observateur, et la trace aussi', async () => {
    const a = app();
    const { resultat: res, lignes } = await capturerJournal(() =>
      a.inject({ method: 'POST', url: '/ops/observe', ...avecOps(OPS), payload: { tenantId: CONNU } }));
    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string; tenantName: string }>();
    expect(body.tenantName).toBe('Client Démo');
    // Le jeton porte bien la marque d'emprunt : c'est elle qui déclenche la lecture seule. Et l'adresse de
    // l'exploitant, lue dans SA session, jamais dans le corps de la requête.
    const session = await verifySession(body.token, SECRET);
    expect(session).toMatchObject({ tenantId: CONNU, impersonated: true, observateur: ADRESSE_OPS });
    expect(lignes.find((l) => l.msg === 'ops_observation')).toMatchObject({ tenantId: CONNU, par: ADRESSE_OPS });
    await a.close();
  });

  it('🔴 SANS la session d’exploitation, la porte reste fermée', async () => {
    // La seule autorité qui ouvre cette porte est celle de l'exploitation, distincte du JWT client. Un admin
    // de la console, si complet soit-il, ne doit pas pouvoir entrer chez un autre client.
    const a = app();
    const jwtClient = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
    for (const headers of [
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json', 'x-ops-token': 'mauvais' },
      { 'content-type': 'application/json', authorization: `Bearer ${jwtClient}` },
    ]) {
      const res = await a.inject({ method: 'POST', url: '/ops/observe', headers, payload: { tenantId: CONNU } });
      expect(res.statusCode).toBe(401);
    }
    await a.close();
  });

  it('espace inconnu -> 404, et tenantId manquant -> 400', async () => {
    const a = app();
    expect((await a.inject({ method: 'POST', url: '/ops/observe', ...avecOps(OPS), payload: { tenantId: INCONNU } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: '/ops/observe', ...avecOps(OPS), payload: {} })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/ops/observe', ...avecOps(OPS), payload: { tenantId: '  ' } })).statusCode).toBe(400);
    await a.close();
  });

  it('🔴 un identifiant qui n’est pas un uuid rend 404, sans toucher la base', async () => {
    // Il partirait tel quel dans un `where id = $1` sur une colonne `uuid` : Postgres LÈVE (`22P02`), donc
    // 500, dont Cloudflare remplace le corps par sa page d'erreur. Une adresse tapée de travers rend 404.
    const vus: string[] = [];
    const a = app({ observerTenant: async (t: string) => { vus.push(t); return null; } });
    expect((await a.inject({ method: 'POST', url: '/ops/observe', ...avecOps(OPS), payload: { tenantId: 'nope' } })).statusCode).toBe(404);
    expect(vus).toEqual([]);
    await a.close();
  });
});

describe('ce que peut faire une session d’observation', () => {
  async function jeton(): Promise<string> {
    return signSession({ userId: 'ops-observation', tenantId: CONNU, role: 'admin', impersonated: true }, SECRET, '1h');
  }
  const comme = (tok: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` } });

  it('elle LIT normalement', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: `/tenants/${CONNU}/conversations`, ...comme(await jeton()) });
    expect(res.statusCode).toBe(200);
    await a.close();
  });

  it('🔴 elle n’écrit RIEN, et le refus vient de la garde globale', async () => {
    // Une garde par route aurait laissé passer la route qu'on oublie. Ici c'est la MÉTHODE qui décide, donc
    // une route d'écriture ajoutée demain est couverte sans que personne y pense.
    const a = app();
    const tok = await jeton();
    const res = await a.inject({
      method: 'POST', url: `/tenants/${CONNU}/conversations/c1/reply`, ...comme(tok), payload: { text: 'coucou' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('impersonation_read_only');

    // Et le marquage « lu » est refusé par la même garde : sans ça, regarder une conversation ferait
    // disparaître les non-lus du client, qui est l'effet de bord le plus visible.
    const lu = await a.inject({ method: 'POST', url: `/tenants/${CONNU}/conversations/c1/read`, ...comme(tok) });
    expect(lu.statusCode).toBe(403);
    await a.close();
  });

  it('🔴 elle n’est pas révoquée par l’absence de compte dans l’espace visité', async () => {
    // Le porteur n'a PAS de compte chez ce client : une relecture d'état en base ne trouverait rien et
    // couperait la session. Sa légitimité vient de sa signature, émise par la surface d'exploitation.
    const a = app();
    const res = await a.inject({ method: 'GET', url: `/tenants/${CONNU}/conversations`, ...comme(await jeton()) });
    expect(res.statusCode).toBe(200);
    await a.close();
  });

  it('🔴 une session NORMALE n’est pas affectée : elle écrit toujours', async () => {
    const a = app();
    const normale = await signSession({ userId: 'u1', tenantId: CONNU, role: 'admin' }, SECRET);
    const res = await a.inject({
      method: 'POST', url: `/tenants/${CONNU}/conversations/c1/reply`, ...comme(normale), payload: { text: 'coucou' },
    });
    expect(res.statusCode).toBe(200);
    await a.close();
  });

  it('🔴 la marque d’emprunt ne se déduit pas d’une valeur approximative', async () => {
    // La garde lit `impersonated === true`, strictement. On fabrique donc le jeton À LA MAIN pour éprouver la
    // VÉRIFICATION (et non `signSession`, qui normalise déjà) : un payload où le champ vaut autre chose que
    // le booléen `true` doit être lu comme une session NORMALE, jamais comme un emprunt à demi reconnu.
    const cle = new TextEncoder().encode(SECRET);
    for (const valeur of ['true', 1, {}, 'oui', null]) {
      const token = await new SignJWT({ tenantId: 't1', role: 'admin', impersonated: valeur })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('u1')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(cle);
      const session = await verifySession(token, SECRET);
      expect(session?.impersonated).toBeUndefined();
    }
    // Et le booléen `true`, lui, EST reconnu : sans ce contrôle, le test passerait aussi si la garde ne
    // reconnaissait plus rien du tout.
    const vrai = await new SignJWT({ tenantId: 't1', role: 'admin', impersonated: true })
      .setProtectedHeader({ alg: 'HS256' }).setSubject('u1').setIssuedAt().setExpirationTime('1h').sign(cle);
    expect((await verifySession(vrai, SECRET))?.impersonated).toBe(true);
  });
});

describe('les gestes d’exploitation laissent leur ligne dans l’espace qu’ils touchent (lot 5)', () => {
  function avecJournal(over: Record<string, unknown> = {}) {
    const audits: Array<{ tenant: string; acteur: { userId: string | null; email: string | null }; action: string; cible: { kind: string; id: string }; detail: Record<string, unknown> | undefined }> = [];
    const audit: AuditSink = async (tenant, acteur, action, cible, detail) => { audits.push({ tenant, acteur, action, cible, detail }); };
    return { audits, a: app({ audit, verrouillerEspace: async () => true, rechargerAgent: async () => 9_000_000, ...over }) };
  }

  it('🔴 observer, verrouiller, recharger : l’exploitant pour acteur, l’espace pour cible, jamais la note', async () => {
    const { a, audits } = avecJournal();
    await a.inject({ method: 'POST', url: '/ops/observe', ...avecOps(OPS), payload: { tenantId: CONNU } });
    await a.inject({ method: 'POST', url: `/ops/verrou/${CONNU}`, ...avecOps(OPS), payload: { verrouille: true, note: 'note interne du verrou' } });
    await a.inject({ method: 'POST', url: `/ops/credits/${CONNU}`, ...avecOps(OPS), payload: { montantMicroEur: 5_000_000, note: 'note interne de recharge' } });
    expect(audits.map((l) => [l.action, l.detail])).toEqual([
      ['ops.espace_observe', {}], ['ops.verrou', { verrouille: true }], ['ops.credit_ajoute', { montantMicroEur: 5_000_000 }],
    ]);
    expect(audits.every((l) => l.tenant === CONNU && l.acteur.userId === null && l.acteur.email === ADRESSE_OPS
      && l.cible.kind === 'tenant' && l.cible.id === CONNU)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain('note interne');
    await a.close();
  });

  it('un journal en panne ne fait pas échouer le geste : l’observation s’ouvre quand même', async () => {
    const { a } = avecJournal({ audit: async () => { throw new Error('audit_log indisponible'); } });
    const res = await a.inject({ method: 'POST', url: '/ops/observe', ...avecOps(OPS), payload: { tenantId: CONNU } });
    expect(res.statusCode).toBe(200);
    await a.close();
  });

  it('un espace inconnu n’écrit rien', async () => {
    const { a, audits } = avecJournal();
    await a.inject({ method: 'POST', url: '/ops/observe', ...avecOps(OPS), payload: { tenantId: INCONNU } });
    expect(audits).toEqual([]);
    await a.close();
  });
});
