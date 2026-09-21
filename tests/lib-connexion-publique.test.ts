import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { Agent } from 'undici';
import {
  lookupPublic, connecteurPublic, fetchPublicAvec, estRefusAdresseInterne, estRedirectionRefusee, ouvrirSocketPublique, AdresseInterdite, type ResoudreTout,
} from '../src/lib/connexion-publique';

/**
 * LA CONNEXION VÉRIFIÉE, ÉPROUVÉE SANS DNS ET SANS RÉSEAU EXTÉRIEUR.
 *
 * 🔴 CE QUI SE TESTE ICI EST LE DNS REBINDING : la vérification préalable (`resolutionPublique`) et la
 * connexion faisaient DEUX résolutions distinctes, et un DNS hostile pouvait répondre public à la première,
 * interne à la seconde. On simule ici la seconde : un nom qui, AU MOMENT DE LA CONNEXION, résout vers la
 * boucle locale, où écoute un vrai petit serveur. La connexion doit être refusée.
 *
 * ⚠️ LA CONTRE-ÉPREUVE N'EST PAS UNE POLITESSE. Un test qui attend un rejet passe aussi quand le serveur est
 * injoignable pour une autre raison. Le même appel, garde levée, doit donc ATTEINDRE le serveur : c'est ce qui
 * prouve que le rejet vient de la garde et de rien d'autre.
 */

/** Un résolveur qui rend ce qu'on lui dit, sans jamais toucher au DNS. */
const resolveur = (table: Record<string, string[]>): ResoudreTout => (hote, rappel) => {
  const ips = table[hote];
  if (!ips) return rappel(Object.assign(new Error('introuvable'), { code: 'ENOTFOUND' }), []);
  rappel(null, ips.map((address): LookupAddress => ({ address, family: address.includes(':') ? 6 : 4 })));
};

function appelerLookup(lk: ReturnType<typeof lookupPublic>, hote: string, options: { all?: boolean }) {
  return new Promise<{ err: Error | null; adresse?: unknown; famille?: number }>((ok) => {
    lk(hote, options, (err, adresse, famille) => ok({ err, adresse, famille }));
  });
}

describe('le lookup de la socket', () => {
  it('🔴 un nom qui résout vers l’intérieur est refusé', async () => {
    const lk = lookupPublic(resolveur({ 'rebind.test': ['172.18.0.1'] }));
    const r = await appelerLookup(lk, 'rebind.test', { all: true });
    expect(r.err).toBeInstanceOf(AdresseInterdite);
  });

  it('🔴 UNE SEULE adresse interne condamne le nom, même parmi des publiques', async () => {
    const lk = lookupPublic(resolveur({ 'mixte.test': ['93.184.216.34', '169.254.169.254'] }));
    expect((await appelerLookup(lk, 'mixte.test', { all: true })).err).toBeInstanceOf(AdresseInterdite);
  });

  it('un nom public passe, et rend exactement ce qu’il a vérifié, sous les deux formes de rappel', async () => {
    const lk = lookupPublic(resolveur({ 'public.test': ['93.184.216.34'] }));
    const toutes = await appelerLookup(lk, 'public.test', { all: true });
    expect(toutes.err).toBeNull();
    expect(toutes.adresse).toEqual([{ address: '93.184.216.34', family: 4 }]);
    const une = await appelerLookup(lk, 'public.test', {});
    expect(une.err).toBeNull();
    expect(une.adresse).toBe('93.184.216.34');
    expect(une.famille).toBe(4);
  });

  it('une résolution en échec est un refus, pas un laissez-passer', async () => {
    const lk = lookupPublic(resolveur({}));
    expect((await appelerLookup(lk, 'inconnu.test', { all: true })).err).not.toBeNull();
  });
});

describe('la connexion vérifiée, contre un vrai serveur local', () => {
  let serveur: Server;
  let port = 0;
  beforeAll(async () => {
    serveur = createServer((req, res) => {
      if (req.url === '/lent') { setTimeout(() => res.end('trop tard'), 2_000).unref(); return; }
      if (req.url === '/redirige') { res.writeHead(302, { location: '/ailleurs' }); res.end(); return; }
      if (req.url === '/echo') {
        let corps = '';
        req.on('data', (c: Buffer) => { corps += c.toString('utf8'); });
        req.on('end', () => res.end(JSON.stringify({ methode: req.method, auth: req.headers.authorization ?? null, corps })));
        return;
      }
      res.end('secret interne');
    });
    await new Promise<void>((ok) => serveur.listen(0, '127.0.0.1', () => ok()));
    port = (serveur.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>((ok) => serveur.close(() => ok())); });

  const table = { 'rebind.test': ['127.0.0.1'] };

  it('🔴 LE CAS DU LOT : un nom qui résout vers la boucle locale AU MOMENT DE LA CONNEXION est refusé', async () => {
    const agent = new Agent({ connect: connecteurPublic(resolveur(table)) });
    try {
      const erreur = await fetchPublicAvec(agent)(`http://rebind.test:${port}/`).then(() => null, (e: unknown) => e);
      expect(erreur, 'le serveur interne a été atteint').not.toBeNull();
      expect(estRefusAdresseInterne(erreur), 'le refus doit venir de la garde, pas d’une autre panne').toBe(true);
    } finally {
      await agent.close();
    }
  });

  it('⚠️ CONTRE-ÉPREUVE : garde levée, le même appel atteint bien le serveur', async () => {
    const agent = new Agent({ connect: connecteurPublic(resolveur(table), () => false) });
    try {
      const res = await fetchPublicAvec(agent)(`http://rebind.test:${port}/`);
      expect(await res.text()).toBe('secret interne');
    } finally {
      await agent.close();
    }
  });

  /**
   * 🔴 CE QUE LES APPELANTS PASSENT À CE `fetch`, ÉPROUVÉ POUR DE VRAI. Leurs propres tests injectent un faux
   * `fetch` : aucun ne fait transiter un délai d'abandon, un corps ou des en-têtes par le `fetch` d'undici. Si
   * l'un d'eux était refusé (un `AbortSignal` du `globalThis` rejeté par une autre version, par exemple), chaque
   * appel de connecteur échouerait en production, sans qu'un seul test ne le voie. D'où ces trois cas.
   */
  it('🔴 le délai d’abandon de l’appelant (AbortSignal.timeout) est respecté', async () => {
    const agent = new Agent({ connect: connecteurPublic(resolveur(table), () => false) });
    try {
      const debut = Date.now();
      const erreur = await fetchPublicAvec(agent)(`http://rebind.test:${port}/lent`, { signal: AbortSignal.timeout(100) })
        .then(() => null, (e: unknown) => e);
      expect(erreur, 'l’appel aurait dû être abandonné').not.toBeNull();
      expect((erreur as Error).name).toMatch(/Abort|Timeout/);
      expect(Date.now() - debut).toBeLessThan(1_500);
    } finally {
      await agent.close();
    }
  });

  it('🔴 méthode, en-têtes et corps arrivent intacts, comme pour un vrai appel de connecteur', async () => {
    const agent = new Agent({ connect: connecteurPublic(resolveur(table), () => false) });
    try {
      const res = await fetchPublicAvec(agent)(`http://rebind.test:${port}/echo`, {
        method: 'POST',
        headers: { authorization: 'Bearer JETON', 'content-type': 'application/json' },
        body: JSON.stringify({ ref: 'CMD-1' }),
        redirect: 'error',
      });
      expect(await res.json()).toEqual({ methode: 'POST', auth: 'Bearer JETON', corps: '{"ref":"CMD-1"}' });
    } finally {
      await agent.close();
    }
  });

  it('🔴 en HTTPS aussi, le nom est jugé à la connexion (avant toute poignée de main TLS)', async () => {
    // Le serveur local parle HTTP : garde levée, l'échec est une erreur TLS (la connexion a bien été ouverte) ;
    // garde posée, c'est le refus d'adresse interne, AVANT la poignée de main. C'est ce qui prouve que la
    // résolution vérifiée sert aussi le chemin TLS, celui de presque tous les vrais connecteurs.
    const garde = new Agent({ connect: connecteurPublic(resolveur(table)) });
    const levee = new Agent({ connect: connecteurPublic(resolveur(table), () => false) });
    try {
      const refus = await fetchPublicAvec(garde)(`https://rebind.test:${port}/`).then(() => null, (e: unknown) => e);
      expect(estRefusAdresseInterne(refus)).toBe(true);
      const autre = await fetchPublicAvec(levee)(`https://rebind.test:${port}/`).then(() => null, (e: unknown) => e);
      expect(autre, 'garde levée, la connexion doit s’ouvrir puis échouer en TLS').not.toBeNull();
      expect(estRefusAdresseInterne(autre)).toBe(false);
    } finally {
      await garde.close();
      await levee.close();
    }
  });

  /**
   * 🔴 LA FORME RÉELLE D'UNE REDIRECTION REFUSÉE, mesurée ici plutôt que supposée : « fetch failed », la raison
   * dans la cause. Le résolveur de connecteur lisait le seul message et ne la reconnaissait jamais.
   */
  it('🔴 une redirection refusée (redirect: error) se reconnaît dans la CAUSE, et n’est pas un refus d’adresse', async () => {
    const agent = new Agent({ connect: connecteurPublic(resolveur(table), () => false) });
    try {
      const erreur = await fetchPublicAvec(agent)(`http://rebind.test:${port}/redirige`, { redirect: 'error' }).then(() => null, (e: unknown) => e);
      expect(erreur, 'la redirection aurait dû être refusée').not.toBeNull();
      expect(estRedirectionRefusee(erreur)).toBe(true);
      expect(estRefusAdresseInterne(erreur)).toBe(false);
      // Et un refus d'adresse n'est pas une redirection, ni une panne DNS sur un hôte dont le nom contient le mot.
      expect(estRedirectionRefusee(new TypeError('fetch failed', { cause: new AdresseInterdite() }))).toBe(false);
      expect(estRedirectionRefusee(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND redirect.client.fr') }))).toBe(false);
    } finally {
      await agent.close();
    }
  });

  it('🔴 une adresse écrite EN CHIFFRES est refusée aussi : elle ne passe jamais par la résolution', async () => {
    const agent = new Agent({ connect: connecteurPublic(resolveur({})) });
    try {
      const erreur = await fetchPublicAvec(agent)(`http://127.0.0.1:${port}/`).then(() => null, (e: unknown) => e);
      expect(estRefusAdresseInterne(erreur)).toBe(true);
    } finally {
      await agent.close();
    }
  });
});

describe('la socket vérifiée d’un protocole non HTTP (le SMTP d’une boîte d’envoi)', () => {
  let tcp: ReturnType<typeof createTcpServer>;
  let portTcp = 0;
  let connexions = 0;
  beforeAll(async () => {
    tcp = createTcpServer((s) => { connexions += 1; s.on('error', () => {}); s.end('220 pret\r\n'); });
    await new Promise<void>((ok) => tcp.listen(0, '127.0.0.1', () => ok()));
    portTcp = (tcp.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>((ok) => tcp.close(() => ok())); });

  const refuser = async (promesse: Promise<unknown>): Promise<unknown> => promesse.then(() => null, (e: unknown) => e);

  it('🔴 un nom qui résout vers l’intérieur est refusé, et le serveur n’est jamais atteint', async () => {
    const avant = connexions;
    const erreur = await refuser(ouvrirSocketPublique('smtp.piege.test', portTcp, { resoudre: resolveur({ 'smtp.piege.test': ['127.0.0.1'] }) }));
    expect(estRefusAdresseInterne(erreur)).toBe(true);
    expect(connexions).toBe(avant);
  });

  it('⚠️ CONTRE-ÉPREUVE : garde levée, la même socket atteint le serveur', async () => {
    const avant = connexions;
    const socket = await ouvrirSocketPublique('smtp.piege.test', portTcp, {
      resoudre: resolveur({ 'smtp.piege.test': ['127.0.0.1'] }), estInterdite: () => false,
    });
    socket.destroy();
    await new Promise((ok) => setTimeout(ok, 50));
    expect(connexions).toBe(avant + 1);
  });

  it('🔴 un hôte écrit EN CHIFFRES vers l’intérieur est refusé sans résolution', async () => {
    const jamais: ResoudreTout = () => { throw new Error('la résolution ne devait pas être appelée'); };
    for (const hote of ['127.0.0.1', '[::1]', '172.18.0.1']) {
      expect(estRefusAdresseInterne(await refuser(ouvrirSocketPublique(hote, portTcp, { resoudre: jamais }))), hote).toBe(true);
    }
  });

  /**
   * 🔴 LA BASCULE QUE NODEMAILER FAISAIT, GARDÉE (relecture du 2026-09-21). Quand la première adresse vérifiée
   * ne répond pas, la socket part sur la suivante. Donner à nodemailer une seule adresse vérifiée la supprimait.
   */
  it('🔴 si la première adresse vérifiée ne répond pas, la suivante est essayée', async () => {
    const socket = await ouvrirSocketPublique('double.test', portTcp, {
      resoudre: resolveur({ 'double.test': ['127.0.0.9', '127.0.0.1'] }), estInterdite: () => false,
    });
    expect(socket.remoteAddress).toBe('127.0.0.1');
    socket.destroy();
  });

  it('🔴 une résolution qui échoue ou qui TRAÎNE est un refus', async () => {
    expect(await refuser(ouvrirSocketPublique('inconnu.test', portTcp, { resoudre: resolveur({}) }))).not.toBeNull();
    const muette: ResoudreTout = () => { /* ne rappelle jamais */ };
    const erreur = await refuser(ouvrirSocketPublique('lent.test', portTcp, { resoudre: muette, delaiMs: 50 }));
    expect((erreur as Error).message).toBe('connexion trop lente');
  });
});
