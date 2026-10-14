import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { accesOps, ADRESSE_OPS } from './acces-ops';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { OpsEmailsDeps } from '../src/http/ops-emails';
import { verifierSignatureResend } from '../src/http/webhook-resend';
import { jetonDesinscription, lireJetonDesinscription } from '../src/emails-produit/desinscription';
import type { CategorieCoupable, TexteEmail } from '../src/emails-produit/catalogue';
import { ResendError } from '../src/support/resend';

/**
 * LES ROUTES DES E-MAILS DU PRODUIT (lot 7), montées sur le vrai serveur : la section « E-mails » de `/ops`, le webhook
 * signé de Resend, le lien de désinscription et les préférences de « Mon compte ».
 */

afterEach(() => { vi.restoreAllMocks(); });

const IDENTITE = '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b';
const SECRET_SESSIONS = 'secret-des-sessions-de-test';

// ---------------------------------------------------------------------------------------------------------------
// /ops/emails
// ---------------------------------------------------------------------------------------------------------------

const acces = accesOps();
const ops: Record<string, string> = {};
beforeAll(async () => {
  const s = buildServer({ queue: new FakeQueue(), auth: acces.auth });
  ops.authorization = `Bearer ${await acces.jeton(s)}`;
  await s.close();
});

function monterOps(o: { envoyer?: OpsEmailsDeps['envoyer'] } = {}) {
  const ecrits: Array<{ cle: string; langue: string; texte: TexteEmail; par: string }> = [];
  const interrupteurs: Array<{ cle: string; actif: boolean; par: string }> = [];
  const envois: Array<{ to: string; subject: string }> = [];
  const textes = new Map<string, TexteEmail>();
  const deps: OpsEmailsDeps = {
    store: {
      textesModifies: async () => [...textes.entries()].map(([k, t]) => {
        const [cle, langue] = k.split('|') as [string, 'fr' | 'en'];
        return { ...t, cle, langue, modifiePar: ADRESSE_OPS, modifieLe: new Date('2026-10-14T09:00:00Z') };
      }),
      texteModifie: async (cle, langue) => textes.get(`${cle}|${langue}`) ?? null,
      ecrireTexte: async (cle, langue, texte, par) => { ecrits.push({ cle, langue, texte, par }); textes.set(`${cle}|${langue}`, texte); },
      retablir: async (cle, langue) => textes.delete(`${cle}|${langue}`),
      interrupteurs: async () => new Map(interrupteurs.map((i) => [i.cle, { actif: i.actif, modifiePar: i.par, modifieLe: new Date() }])),
      poserInterrupteur: async (cle, actif, par) => { interrupteurs.push({ cle, actif, par }); },
      chiffresDuMois: async () => [{ cle: 'credit_epuise', emis: 3, envoyes: 3, echecs: 0, ignores: 0, livres: 3, ouverts: 2, cliques: 1, rebonds: 0, plaintes: 0 }],
    },
    envoyer: o.envoyer === undefined ? async (m) => { envois.push({ to: m.to, subject: m.subject }); return { id: 're_essai' }; } : o.envoyer,
  };
  const server = buildServer({ queue: new FakeQueue(), auth: acces.auth, opsEmails: deps });
  return { server, ecrits, interrupteurs, envois };
}

const TEXTE = { sujet: 'Crédit de {{espace}} épuisé', corps: 'Bonjour,\n\nRechargez.', bouton: { libelle: 'Recharger', lien: '{{lien_credit}}' } };

describe('/ops/emails', () => {
  it('🔴 sans session d’exploitation : 401, rien n’est lu', async () => {
    const { server } = monterOps();
    expect((await server.inject({ method: 'GET', url: '/ops/emails' })).statusCode).toBe(401);
    await server.close();
  });

  it('la liste : chaque modèle du catalogue, ses textes d’origine, son interrupteur et ses chiffres du mois', async () => {
    const { server } = monterOps();
    const res = await server.inject({ method: 'GET', url: '/ops/emails', headers: ops });
    expect(res.statusCode).toBe(200);
    const corps = res.json<{ modeles: Array<{ cle: string; actif: boolean; chiffres: { ouverts: number }; textes: { fr: { origine: TexteEmail; modifie: unknown } } }>; essaiPossible: boolean }>();
    const credit = corps.modeles.find((m) => m.cle === 'credit_epuise')!;
    expect(credit.actif).toBe(true);
    expect(credit.chiffres.ouverts).toBe(2);
    expect(credit.textes.fr.modifie).toBeNull();
    expect(credit.textes.fr.origine.sujet).toMatch(/Crédit IA épuisé/);
    expect(corps.modeles.find((m) => m.cle === 'numero_libere')!.chiffres.ouverts).toBe(0);
    expect(corps.essaiPossible).toBe(true);
    await server.close();
  });

  it('🔴 un texte : note obligatoire, variable inconnue refusée en 422 et la liste dite, sinon écrit et signé', async () => {
    const { server, ecrits } = monterOps();
    const sansNote = await server.inject({ method: 'PUT', url: '/ops/emails/credit_epuise/fr', headers: ops, payload: TEXTE });
    expect(sansNote.statusCode).toBe(400);
    const inconnue = await server.inject({ method: 'PUT', url: '/ops/emails/credit_epuise/fr', headers: ops, payload: { ...TEXTE, corps: 'Solde : {{solde}}', note: 'essai' } });
    expect(inconnue.statusCode).toBe(422);
    expect(inconnue.json()).toMatchObject({ inconnues: ['solde'] });
    const lienPirate = await server.inject({ method: 'PUT', url: '/ops/emails/credit_epuise/fr', headers: ops, payload: { ...TEXTE, bouton: { libelle: 'x', lien: 'javascript:alert(1)' }, note: 'essai' } });
    expect(lienPirate.statusCode).toBe(400);
    expect(ecrits).toEqual([]);
    const ok = await server.inject({ method: 'PUT', url: '/ops/emails/credit_epuise/en', headers: ops, payload: { ...TEXTE, note: 'ton plus direct' } });
    expect(ok.statusCode).toBe(200);
    expect(ecrits).toEqual([{ cle: 'credit_epuise', langue: 'en', texte: { sujet: TEXTE.sujet, corps: TEXTE.corps, bouton: TEXTE.bouton }, par: ADRESSE_OPS }]);
    expect((await server.inject({ method: 'PUT', url: '/ops/emails/inconnu/fr', headers: ops, payload: { ...TEXTE, note: 'x x' } })).statusCode).toBe(404);
    expect((await server.inject({ method: 'PUT', url: '/ops/emails/credit_epuise/de', headers: ops, payload: { ...TEXTE, note: 'x x' } })).statusCode).toBe(404);
    await server.close();
  });

  it('rétablir et l’interrupteur : note obligatoire, signés de leur auteur', async () => {
    const { server, interrupteurs } = monterOps();
    expect((await server.inject({ method: 'PUT', url: '/ops/emails/credit_epuise/actif', headers: ops, payload: { actif: false } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'PUT', url: '/ops/emails/credit_epuise/actif', headers: ops, payload: { actif: false, note: 'trop bavard' } })).statusCode).toBe(200);
    expect(interrupteurs).toEqual([{ cle: 'credit_epuise', actif: false, par: ADRESSE_OPS }]);
    const retabli = await server.inject({ method: 'POST', url: '/ops/emails/credit_epuise/fr/retablir', headers: ops, payload: { note: 'retour au texte d’origine' } });
    expect(retabli.json()).toEqual({ ok: true, etait: false });
    await server.close();
  });

  it('🔴 l’aperçu rend le brouillon avec les valeurs d’exemple, échappé, sans rien écrire', async () => {
    const { server, ecrits } = monterOps();
    const res = await server.inject({ method: 'POST', url: '/ops/emails/credit_epuise/apercu', headers: ops, payload: { langue: 'fr', texte: { ...TEXTE, corps: '<b>gras</b> {{espace}}' } } });
    expect(res.statusCode).toBe(200);
    const r = res.json<{ sujet: string; html: string }>();
    expect(r.sujet).toBe('Crédit de Boulangerie Martin épuisé');
    expect(r.html).toContain('&lt;b&gt;gras&lt;/b&gt;');
    expect(r.html).toContain('href="https://console.messagingme.app/parametres/credit"');
    expect(ecrits).toEqual([]);
    await server.close();
  });

  it('🔴 l’essai part à l’adresse de l’exploitant et à elle seule ; un refus de Resend rend 422, sans Resend 503', async () => {
    const { server, envois } = monterOps();
    const res = await server.inject({ method: 'POST', url: '/ops/emails/numero_libere/essai', headers: ops, payload: { langue: 'en' } });
    expect(res.statusCode).toBe(200);
    expect(envois).toEqual([{ to: ADRESSE_OPS, subject: '[Essai] Your WhatsApp number has been released' }]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const refuse = monterOps({ envoyer: async () => { throw new ResendError(403, 'domaine non vérifié'); } });
    const r2 = await refuse.server.inject({ method: 'POST', url: '/ops/emails/numero_libere/essai', headers: ops, payload: { langue: 'fr' } });
    expect(r2.statusCode).toBe(422);
    expect(r2.json<{ error: string }>().error).toContain('domaine non vérifié');
    const sans = monterOps({ envoyer: null });
    expect((await sans.server.inject({ method: 'POST', url: '/ops/emails/numero_libere/essai', headers: ops, payload: { langue: 'fr' } })).statusCode).toBe(503);
    await Promise.all([server.close(), refuse.server.close(), sans.server.close()]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Le webhook de Resend
// ---------------------------------------------------------------------------------------------------------------

const SECRET_RESEND = `whsec_${Buffer.from('cle-de-signature-de-resend-test').toString('base64')}`;

function signer(corps: string, o: { id?: string; t?: number; secret?: string } = {}) {
  const id = o.id ?? 'msg_1';
  const t = String(o.t ?? Math.floor(Date.now() / 1000));
  const cle = Buffer.from((o.secret ?? SECRET_RESEND).slice('whsec_'.length), 'base64');
  const sig = createHmac('sha256', cle).update(`${id}.${t}.${corps}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': t, 'svix-signature': `v1,${sig}`, 'content-type': 'application/json' };
}

function monterWebhook() {
  const notes: string[] = [];
  const desinscrits: string[] = [];
  const server = buildServer({
    queue: new FakeQueue(),
    resendWebhook: {
      secret: SECRET_RESEND,
      noterEvenement: async (resendId, ev) => { notes.push(`${resendId}:${ev}`); return resendId === 're_connu' ? { identityId: IDENTITE } : null; },
      desinscrireDesCommerciaux: async (id) => { desinscrits.push(id); },
    },
  });
  return { server, notes, desinscrits };
}

describe('le webhook de Resend', () => {
  it('🔴 la signature Svix : juste, fausse, d’un autre secret, périmée, ou une rotation à deux signatures', () => {
    const corps = Buffer.from('{"type":"email.opened"}');
    const maintenant = Date.parse('2026-10-14T10:00:00Z');
    const t = String(maintenant / 1000);
    const e = signer(corps.toString(), { t: maintenant / 1000 });
    expect(verifierSignatureResend(corps, { id: e['svix-id'], timestamp: t, signature: e['svix-signature'] }, SECRET_RESEND, maintenant)).toBe(true);
    expect(verifierSignatureResend(corps, { id: 'autre', timestamp: t, signature: e['svix-signature'] }, SECRET_RESEND, maintenant)).toBe(false);
    expect(verifierSignatureResend(Buffer.from('{}'), { id: e['svix-id'], timestamp: t, signature: e['svix-signature'] }, SECRET_RESEND, maintenant)).toBe(false);
    const autre = `whsec_${Buffer.from('un-autre-secret').toString('base64')}`;
    expect(verifierSignatureResend(corps, { id: e['svix-id'], timestamp: t, signature: e['svix-signature'] }, autre, maintenant)).toBe(false);
    expect(verifierSignatureResend(corps, { id: e['svix-id'], timestamp: t, signature: e['svix-signature'] }, SECRET_RESEND, maintenant + 10 * 60_000)).toBe(false);
    expect(verifierSignatureResend(corps, { id: e['svix-id'], timestamp: t, signature: `v1,AAAA ${e['svix-signature']}` }, SECRET_RESEND, maintenant)).toBe(true);
    expect(verifierSignatureResend(corps, { id: e['svix-id'], timestamp: t, signature: e['svix-signature'] }, '', maintenant)).toBe(false);
  });

  it('🔴 signature absente ou fausse : 401, le journal n’est pas touché', async () => {
    const { server, notes } = monterWebhook();
    const corps = JSON.stringify({ type: 'email.opened', created_at: '2026-10-14T10:00:00Z', data: { email_id: 're_connu' } });
    expect((await server.inject({ method: 'POST', url: '/webhooks/resend', headers: { 'content-type': 'application/json' }, payload: corps })).statusCode).toBe(401);
    const fausse = signer(corps, { secret: `whsec_${Buffer.from('pas-le-bon').toString('base64')}` });
    expect((await server.inject({ method: 'POST', url: '/webhooks/resend', headers: fausse, payload: corps })).statusCode).toBe(401);
    expect(notes).toEqual([]);
    await server.close();
  });

  it('un événement noté ; un type qu’on ne note pas, ignoré ; une plainte désinscrit des commerciaux', async () => {
    const { server, notes, desinscrits } = monterWebhook();
    const envoyer = (ev: object) => {
      const corps = JSON.stringify(ev);
      return server.inject({ method: 'POST', url: '/webhooks/resend', headers: signer(corps), payload: corps });
    };
    expect((await envoyer({ type: 'email.opened', created_at: '2026-10-14T10:00:00Z', data: { email_id: 're_connu' } })).statusCode).toBe(200);
    expect((await envoyer({ type: 'email.sent', created_at: '2026-10-14T10:00:00Z', data: { email_id: 're_connu' } })).statusCode).toBe(200);
    expect((await envoyer({ type: 'email.complained', created_at: '2026-10-14T10:00:00Z', data: { email_id: 're_connu' } })).statusCode).toBe(200);
    expect((await envoyer({ type: 'email.complained', created_at: '2026-10-14T10:00:00Z', data: { email_id: 're_inconnu' } })).statusCode).toBe(200);
    expect(notes).toEqual(['re_connu:email.opened', 're_connu:email.complained', 're_inconnu:email.complained']);
    expect(desinscrits).toEqual([IDENTITE]);
    await server.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Le lien de désinscription
// ---------------------------------------------------------------------------------------------------------------

function monterDesinscription() {
  const desinscrits: Array<{ identityId: string; categorie: CategorieCoupable }> = [];
  const server = buildServer({
    queue: new FakeQueue(),
    desinscriptionEmails: {
      lire: (jeton) => lireJetonDesinscription(jeton, SECRET_SESSIONS),
      desinscrire: async (identityId, categorie) => { desinscrits.push({ identityId, categorie }); },
    },
  });
  return { server, desinscrits };
}

describe('le lien de désinscription', () => {
  it('🔴 le GET n’écrit rien (les messageries ouvrent les liens) ; le POST désinscrit, une catégorie, une personne', async () => {
    const { server, desinscrits } = monterDesinscription();
    const url = `/e/desinscription/${encodeURIComponent(jetonDesinscription(IDENTITE, 'transfert', SECRET_SESSIONS))}`;
    const page = await server.inject({ method: 'GET', url });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('<form method="post"');
    expect(desinscrits).toEqual([]);
    const post = await server.inject({ method: 'POST', url });
    expect(post.statusCode).toBe(200);
    expect(desinscrits).toEqual([{ identityId: IDENTITE, categorie: 'transfert' }]);
    await server.close();
  });

  it('🔴 l’envoi en un clic des messageries (formulaire `List-Unsubscribe=One-Click`) est accepté', async () => {
    const { server, desinscrits } = monterDesinscription();
    const url = `/e/desinscription/${encodeURIComponent(jetonDesinscription(IDENTITE, 'commercial', SECRET_SESSIONS))}`;
    const res = await server.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(res.statusCode).toBe(200);
    expect(desinscrits).toEqual([{ identityId: IDENTITE, categorie: 'commercial' }]);
    await server.close();
  });

  it('🔴 un jeton forgé ou d’un autre secret : 404, rien n’est désinscrit', async () => {
    const { server, desinscrits } = monterDesinscription();
    const forge = jetonDesinscription(IDENTITE, 'commercial', 'pas-le-secret');
    for (const code of [forge, 'n.importe.quoi', `${IDENTITE}.commercial.AAAA`]) {
      for (const method of ['GET', 'POST'] as const) {
        expect((await server.inject({ method, url: `/e/desinscription/${encodeURIComponent(code)}` })).statusCode).toBe(404);
      }
    }
    expect(desinscrits).toEqual([]);
    await server.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Les préférences de « Mon compte »
// ---------------------------------------------------------------------------------------------------------------

describe('les préférences d’e-mails de la personne connectée', () => {
  const personne: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };

  it('🔴 la personne de la session dans l’espace de l’adresse : lire, changer la langue, couper puis rétablir', async () => {
    const etat = { langue: 'fr' as 'fr' | 'en', desinscriptions: new Set<CategorieCoupable>() };
    const demandes: string[] = [];
    const server = buildServer({
      queue: new FakeQueue(), auth: { users: personne, secret: SECRET_SESSIONS },
      emailsMoi: {
        store: {
          identiteDuCompte: async (t, u) => { demandes.push(`${t}/${u}`); return u === 'u1' ? IDENTITE : null; },
          preferences: async () => ({ langue: etat.langue, desinscriptions: [...etat.desinscriptions] }),
          poserLangue: async (_i, l) => { etat.langue = l; },
          desinscrire: async (_i, c) => { etat.desinscriptions.add(c); },
          reabonner: async (_i, c) => { etat.desinscriptions.delete(c); },
        },
      },
    });
    const jeton = await signSession({ userId: 'u1', tenantId: 't1', role: 'agent' }, SECRET_SESSIONS);
    const h = { authorization: `Bearer ${jeton}` };
    expect((await server.inject({ method: 'GET', url: '/tenants/t1/moi/emails', headers: h })).json()).toEqual({ langue: 'fr', commerciaux: true, transferts: true });
    const maj = await server.inject({ method: 'PUT', url: '/tenants/t1/moi/emails', headers: h, payload: { langue: 'en', transferts: false } });
    expect(maj.json()).toEqual({ langue: 'en', commerciaux: true, transferts: false });
    expect((await server.inject({ method: 'PUT', url: '/tenants/t1/moi/emails', headers: h, payload: { transferts: true } })).json()).toMatchObject({ transferts: true });
    expect((await server.inject({ method: 'PUT', url: '/tenants/t1/moi/emails', headers: h, payload: { langue: 'de' } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'PUT', url: '/tenants/t1/moi/emails', headers: h, payload: { identityId: 'autre' } })).statusCode).toBe(400);
    // L'espace de l'adresse doit être celui de la session : un autre espace est refusé avant toute lecture.
    expect((await server.inject({ method: 'GET', url: '/tenants/t2/moi/emails', headers: h })).statusCode).toBe(403);
    expect(demandes.every((d) => d === 't1/u1')).toBe(true);
    await server.close();
  });
});
