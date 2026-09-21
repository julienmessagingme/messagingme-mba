import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { sendSmtpEmail, buildTransport } from '../src/email/smtp';
import { EmailAccountResolver } from '../src/email/resolver';
import { estRefusAdresseInterne, ouvrirSocketPublique } from '../src/lib/connexion-publique';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { DecryptedEmailAccount } from '../src/email/types';

/** Boîte de référence, toujours avec nom d'expéditeur et reply-to (les variantes sans les deux sont
 *  construites par override ponctuel dans les tests qui en ont besoin). */
const account: DecryptedEmailAccount = {
  id: 'a1', tenantId: 't1', label: 'support', host: 'h', port: 465, secure: true,
  username: 'u', password: 'p', fromAddress: 'support@ex.fr', fromName: 'Support',
  replyTo: 'rep@ex.fr', verifiedAt: null, createdAt: 'now',
};

describe('sendSmtpEmail', () => {
  it('compose le from avec nom, le replyTo, et transmet le corps html', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    await sendSmtpEmail({ sendMail } as never, account, { to: 'x@ex.fr', subject: 'S', html: '<b>h</b>' });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: { name: 'Support', address: 'support@ex.fr' },
      to: 'x@ex.fr',
      replyTo: 'rep@ex.fr',
      subject: 'S',
      text: undefined,
      html: '<b>h</b>',
    });
  });

  it('transmet le corps texte quand html est absent', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    await sendSmtpEmail({ sendMail } as never, account, { to: 'x@ex.fr', subject: 'S', text: 'Bonjour' });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: 'Bonjour', html: undefined }));
  });

  it("from = adresse seule (pas d'objet) quand la boîte n'a pas de fromName", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const sansNom: DecryptedEmailAccount = { ...account, fromName: null };
    await sendSmtpEmail({ sendMail } as never, sansNom, { to: 'x@ex.fr', subject: 'S', text: 't' });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'support@ex.fr' }));
  });

  it('les destinataires supplémentaires partent en COPIE CACHÉE, jamais dans le « À »', async () => {
    // Décision produit du 2026-08-25 : les destinataires d'un bloc email peuvent être des CLIENTS. Les mettre
    // tous dans le « À » les exposerait les uns aux autres, ce qui est une fuite de données personnelles.
    const sendMail = vi.fn().mockResolvedValue({});
    await sendSmtpEmail({ sendMail } as never, account, {
      to: 'premier@ex.fr',
      bcc: ['deux@ex.fr', 'trois@ex.fr'],
      subject: 'S',
      text: 't',
    });

    const envoye = sendMail.mock.calls[0]![0] as { to: string; bcc?: string[] };
    expect(envoye.to).toBe('premier@ex.fr');
    expect(envoye.bcc).toEqual(['deux@ex.fr', 'trois@ex.fr']);
    // Le « À » ne porte QUE le premier : aucune des adresses cachées ne doit s'y retrouver.
    expect(envoye.to).not.toContain('deux@ex.fr');
    expect(envoye.to).not.toContain('trois@ex.fr');
  });

  it("aucun en-tête bcc quand il n'y a qu'un destinataire (l'objet remis reste celui d'avant)", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    await sendSmtpEmail({ sendMail } as never, account, { to: 'seul@ex.fr', subject: 'S', text: 't' });

    expect(sendMail.mock.calls[0]![0]).not.toHaveProperty('bcc');
  });

  it('bcc vide traité comme absent : pas d’en-tête bcc posé pour rien', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    await sendSmtpEmail({ sendMail } as never, account, { to: 'seul@ex.fr', bcc: [], subject: 'S', text: 't' });

    expect(sendMail.mock.calls[0]![0]).not.toHaveProperty('bcc');
  });

  it("replyTo omis (undefined, pas null) quand la boîte n'en a pas", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const sansReplyTo: DecryptedEmailAccount = { ...account, replyTo: null };
    await sendSmtpEmail({ sendMail } as never, sansReplyTo, { to: 'x@ex.fr', subject: 'S', text: 't' });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ replyTo: undefined }));
  });
});

describe('buildTransport', () => {
  it('construit un transport nodemailer sans effectuer de connexion réseau (paresseux : connexion seulement au sendMail)', () => {
    const transport = buildTransport(account);
    expect(typeof transport.sendMail).toBe('function');
    expect(typeof transport.close).toBe('function');
  });
});

/**
 * 🔴 UN VRAI ENVOI NODEMAILER, CONTRE UN FAUX SERVEUR SMTP LOCAL (2026-09-21). La socket est désormais ouverte par
 * nous (`getSocket`) : ce qui compte est que nodemailer s'en serve pour tout le dialogue, et qu'un hôte interne
 * soit refusé AVANT qu'une connexion n'arrive au serveur.
 */
describe('buildTransport : la connexion passe par la socket vérifiée', () => {
  let serveur: ReturnType<typeof createServer>;
  let port = 0;
  let connexions = 0;
  const recus: string[] = [];
  beforeAll(async () => {
    serveur = createServer((s) => {
      connexions += 1;
      s.on('error', () => {});
      const dire = (l: string): void => { s.write(l + '\r\n'); };
      let enDonnees = false;
      dire('220 faux.smtp pret');
      let tampon = '';
      s.on('data', (c: Buffer) => {
        tampon += c.toString('utf8');
        let fin = tampon.indexOf('\r\n');
        while (fin >= 0) {
          const ligne = tampon.slice(0, fin);
          tampon = tampon.slice(fin + 2);
          fin = tampon.indexOf('\r\n');
          if (enDonnees) { if (ligne === '.') { enDonnees = false; dire('250 accepte'); } continue; }
          recus.push(ligne.split(' ')[0]!.toUpperCase());
          if (/^EHLO/i.test(ligne)) s.write('250-faux.smtp\r\n250 AUTH PLAIN\r\n');
          else if (/^AUTH/i.test(ligne)) dire('235 ok');
          else if (/^DATA/i.test(ligne)) { enDonnees = true; dire('354 envoyez'); }
          else if (/^QUIT/i.test(ligne)) { dire('221 bye'); s.end(); }
          else dire('250 ok');
        }
      });
    });
    await new Promise<void>((ok) => serveur.listen(0, '127.0.0.1', () => ok()));
    port = (serveur.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>((ok) => serveur.close(() => ok())); });

  const boite = (): DecryptedEmailAccount => ({ ...account, host: 'smtp.client.test', port, secure: false });

  it('⚠️ garde levée : l’envoi passe par la socket ouverte, et le dialogue SMTP va à son terme', async () => {
    const avant = connexions;
    const ouvrir = (hote: string, p: number) => ouvrirSocketPublique(hote, p, {
      resoudre: (h, rappel) => rappel(null, h === 'smtp.client.test' ? [{ address: '127.0.0.1', family: 4 }] : []),
      estInterdite: () => false,
    });
    const transport = buildTransport(boite(), ouvrir);
    await sendSmtpEmail(transport, boite(), { to: 'x@ex.fr', subject: 'S', text: 'corps' });
    expect(connexions).toBe(avant + 1);
    expect(recus).toEqual(expect.arrayContaining(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA']));
  });

  it('🔴 par défaut, un hôte interne est refusé AVANT toute connexion, et le refus se reconnaît', async () => {
    const avant = connexions;
    const transport = buildTransport({ ...boite(), host: '127.0.0.1' });
    const erreur = await sendSmtpEmail(transport, boite(), { to: 'x@ex.fr', subject: 'S', text: 'corps' }).then(() => null, (e: unknown) => e);
    expect(estRefusAdresseInterne(erreur), 'le bouton « Tester » le traduit en message lisible').toBe(true);
    expect(connexions, 'le serveur interne ne doit jamais être atteint').toBe(avant);
  });
});

describe('EmailAccountResolver', () => {
  it('met en cache le transport par boîte : le 2e appel ne reconstruit pas et renvoie la même instance', async () => {
    const build = vi.fn(() => ({ sendMail: vi.fn() }) as never);
    const getDecrypted = vi.fn().mockResolvedValue(account);
    const r = new EmailAccountResolver({ getDecrypted, buildTransport: build });

    const first = await r.getTransport('t1', 'a1');
    const second = await r.getTransport('t1', 'a1');

    expect(build).toHaveBeenCalledTimes(1);
    expect(getDecrypted).toHaveBeenCalledTimes(1);
    expect(getDecrypted).toHaveBeenCalledWith('t1', 'a1');
    expect(first?.transport).toBe(second?.transport); // même instance, pas juste égales
  });

  it('invalidate() force une reconstruction (nouvel appel à buildTransport et getDecrypted)', async () => {
    const build = vi.fn(() => ({ sendMail: vi.fn() }) as never);
    const getDecrypted = vi.fn().mockResolvedValue(account);
    const r = new EmailAccountResolver({ getDecrypted, buildTransport: build });

    await r.getTransport('t1', 'a1');
    r.invalidate('a1');
    await r.getTransport('t1', 'a1');

    expect(build).toHaveBeenCalledTimes(2);
    expect(getDecrypted).toHaveBeenCalledTimes(2);
  });

  it('invalidate() ferme le transport en cache quand il expose close()', async () => {
    const close = vi.fn();
    const build = vi.fn(() => ({ sendMail: vi.fn(), close }) as never);
    const getDecrypted = vi.fn().mockResolvedValue(account);
    const r = new EmailAccountResolver({ getDecrypted, buildTransport: build });

    await r.getTransport('t1', 'a1');
    r.invalidate('a1');

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('invalidate() tolère un close() qui lève (best-effort, ne remonte jamais)', async () => {
    const close = vi.fn(() => {
      throw new Error('boom');
    });
    const build = vi.fn(() => ({ sendMail: vi.fn(), close }) as never);
    const getDecrypted = vi.fn().mockResolvedValue(account);
    const r = new EmailAccountResolver({ getDecrypted, buildTransport: build });

    await r.getTransport('t1', 'a1');
    expect(() => r.invalidate('a1')).not.toThrow();
  });

  it("invalidate() sur une boîte jamais mise en cache ne lève pas", () => {
    const r = new EmailAccountResolver({ getDecrypted: vi.fn(), buildTransport: vi.fn() });
    expect(() => r.invalidate('inconnu')).not.toThrow();
  });

  it('boîte introuvable (getDecrypted -> null) : renvoie null et ne met rien en cache', async () => {
    const build = vi.fn(() => ({ sendMail: vi.fn() }) as never);
    const getDecrypted = vi.fn().mockResolvedValue(null);
    const r = new EmailAccountResolver({ getDecrypted, buildTransport: build });

    const result = await r.getTransport('t1', 'inconnu');

    expect(result).toBeNull();
    expect(build).not.toHaveBeenCalled();
  });
});

/** Le WORKER construit sa PROPRE instance d'EmailAccountResolver (voir worker.ts) et ne reçoit jamais
 *  l'invalidation posée par les routes email du process API. Sans TTL, un mot de passe SMTP changé ou un
 *  compte supprimé restait servi par le worker jusqu'au prochain redéploiement. Le TTL (calqué sur
 *  MetaCredentialsResolver, src/meta/credentials.ts) borne cette staleness. Horloge injectée (`now`) pour
 *  contrôler le temps sans vrai délai dans le test. */
describe('EmailAccountResolver : TTL du cache (borne la staleness inter-process)', () => {
  it('un hit AVANT expiration du TTL réutilise le transport en cache (buildTransport appelé une seule fois)', async () => {
    let now = 0;
    const build = vi.fn(() => ({ sendMail: vi.fn() }) as never);
    const getDecrypted = vi.fn().mockResolvedValue(account);
    const r = new EmailAccountResolver({ getDecrypted, buildTransport: build, cacheTtlMs: 1000, now: () => now });

    const first = await r.getTransport('t1', 'a1');
    now += 999; // juste avant expiration (now - at = 999 < ttl 1000)
    const second = await r.getTransport('t1', 'a1');

    expect(build).toHaveBeenCalledTimes(1);
    expect(getDecrypted).toHaveBeenCalledTimes(1);
    expect(first?.transport).toBe(second?.transport); // même instance, pas juste égales
  });

  it("après expiration du TTL, l'appel suivant reconstruit : buildTransport et getDecrypted rappelés, ancien transport fermé", async () => {
    let now = 0;
    const close = vi.fn();
    const build = vi.fn(() => ({ sendMail: vi.fn(), close }) as never);
    const getDecrypted = vi.fn().mockResolvedValue(account);
    const r = new EmailAccountResolver({ getDecrypted, buildTransport: build, cacheTtlMs: 1000, now: () => now });

    const first = await r.getTransport('t1', 'a1');
    now += 1000; // TTL écoulé (now - at = 1000 >= ttl 1000 -> traité comme un miss)
    const second = await r.getTransport('t1', 'a1');

    expect(build).toHaveBeenCalledTimes(2);
    expect(getDecrypted).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1); // l'ancien transport a été fermé avant la reconstruction
    expect(first?.transport).not.toBe(second?.transport);
  });
});

/** Critical 2 : le cache était indexé par accountId SEUL. Sur un hit, tenantId n'était jamais revérifié : une
 *  fois (t1, a1) mis en cache, `getTransport('t2', 'a1')` renvoyait directement l'entrée de t1 (mot de passe en
 *  clair inclus) sans jamais rappeler getDecrypted, qui est le seul point qui applique le scoping tenant réel.
 *  Le correctif indexe le cache par clé composite `${tenantId}:${accountId}` : un mauvais couple est toujours
 *  un miss. */
describe('EmailAccountResolver — isolation multi-tenant (clé de cache composite, Critical 2)', () => {
  it("un hit de cache pour (tenant A, accountId) ne fuite jamais vers tenant B : getDecrypted est revérifié, jamais le compte de A", async () => {
    const build = vi.fn(() => ({ sendMail: vi.fn() }) as never);
    // getDecrypted simule le scoping réel : seul le tenant propriétaire (t1) obtient un compte.
    const getDecrypted = vi.fn(async (tenantId: string) => (tenantId === 't1' ? account : null));
    const r = new EmailAccountResolver({ getDecrypted, buildTransport: build });

    const forTenantA = await r.getTransport('t1', 'a1'); // remplit le cache pour (t1, a1)
    expect(forTenantA?.account.tenantId).toBe('t1');

    const forTenantB = await r.getTransport('t2', 'a1'); // même accountId, tenant DIFFÉRENT

    expect(getDecrypted).toHaveBeenCalledWith('t2', 'a1'); // pas de court-circuit sur le hit de A
    expect(forTenantB).toBeNull(); // jamais le compte (mot de passe en clair) de A rendu à B
  });

  it('même couple (tenant, accountId) demandé deux fois : le hit légitime sert bien du cache (buildTransport une seule fois)', async () => {
    const build = vi.fn(() => ({ sendMail: vi.fn() }) as never);
    const getDecrypted = vi.fn().mockResolvedValue(account);
    const r = new EmailAccountResolver({ getDecrypted, buildTransport: build });

    const first = await r.getTransport('t1', 'a1');
    const second = await r.getTransport('t1', 'a1');

    expect(build).toHaveBeenCalledTimes(1);
    expect(first?.transport).toBe(second?.transport);
  });

  it("invalidate(accountId) supprime l'entrée composite : l'appel suivant reconstruit (buildTransport et getDecrypted rappelés)", async () => {
    const build = vi.fn(() => ({ sendMail: vi.fn() }) as never);
    const getDecrypted = vi.fn().mockResolvedValue(account);
    const r = new EmailAccountResolver({ getDecrypted, buildTransport: build });

    await r.getTransport('t1', 'a1');
    r.invalidate('a1');
    await r.getTransport('t1', 'a1');

    expect(build).toHaveBeenCalledTimes(2);
    expect(getDecrypted).toHaveBeenCalledTimes(2);
  });
});
