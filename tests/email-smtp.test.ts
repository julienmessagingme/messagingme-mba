import { describe, it, expect, vi } from 'vitest';
import { sendSmtpEmail, buildTransport } from '../src/email/smtp';
import { EmailAccountResolver } from '../src/email/resolver';
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
