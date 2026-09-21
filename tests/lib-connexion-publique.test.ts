import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { Agent } from 'undici';
import {
  lookupPublic, connecteurPublic, fetchPublicAvec, estRefusAdresseInterne, AdresseInterdite, type ResoudreTout,
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
    serveur = createServer((_req, res) => { res.end('secret interne'); });
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
