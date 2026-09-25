import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import type { LinksRouteDeps } from '../src/http/links';
import { capturerJournal } from './journal';
import type { DestinationLien } from '../src/links/tracked-links.pg';

const CODE = 'ab12cd34ef56';

interface Capture {
  clics: Array<{ code: string; tenantId: string }>;
  lus: string[];
  signaux: Array<{ tenantId: string; contactId: string; code: string }>;
}

function app(over: Partial<LinksRouteDeps> = {}): { server: ReturnType<typeof buildServer>; cap: Capture } {
  const cap: Capture = { clics: [], lus: [], signaux: [] };
  const links: LinksRouteDeps = {
    getByCode: async (code): Promise<DestinationLien | null> => {
      cap.lus.push(code);
      return code === CODE ? { tenantId: 't1', destination: 'https://client.fr/promo' } : null;
    },
    recordClick: async (code, tenantId) => { cap.clics.push({ code, tenantId }); },
    signalerClic: async (tenantId, contactId, code) => { cap.signaux.push({ tenantId, contactId, code }); },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), links }), cap };
}

describe('redirection publique /r/:code', () => {
  it('🔴 code connu -> 302 vers la destination, et UN clic compté', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.fr/promo');
    expect(cap.clics).toEqual([{ code: CODE, tenantId: 't1' }]);
    await server.close();
  });

  it('🔴 aucune authentification requise : le destinataire clique depuis WhatsApp', async () => {
    // Si un jour une garde d'auth passait devant cette route, tous les liens déjà livrés cesseraient de
    // fonctionner d'un coup, sans que rien d'autre ne casse.
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}` }); // aucun header Authorization
    expect(res.statusCode).toBe(302);
    await server.close();
  });

  it('302 et non 301 : un 301 serait mis en cache et on ne verrait plus jamais les clics suivants', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers['cache-control']).toBe('no-store');
    await server.close();
  });

  it('code inconnu -> 404 LISIBLE (jamais 5xx : Cloudflare remplacerait le corps)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/r/zzzzzzzzzzzz' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Lien introuvable');
    await server.close();
  });

  it('🔴 code MAL FORMÉ -> 404 sans toucher la base', async () => {
    // Un lien public reçoit des robots et des scans : aucune raison de leur offrir une requête SQL par essai.
    const { server, cap } = app();
    for (const mauvais of ['court', 'ab12cd34ef56789', "../../etc/passwd", 'ab12cd34ef5!']) {
      const res = await server.inject({ method: 'GET', url: `/r/${encodeURIComponent(mauvais)}` });
      expect(res.statusCode).toBe(404);
    }
    expect(cap.lus).toEqual([]);
    await server.close();
  });

  it('la casse du code est normalisée (un code recopié en majuscules marche)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'GET', url: `/r/${CODE.toUpperCase()}` });
    expect(res.statusCode).toBe(302);
    expect(cap.lus).toEqual([CODE]); // normalisé avant la base
    await server.close();
  });

  it('🔴 destination devenue INVALIDE -> refus, PAS de redirection (garde open redirect à la lecture)', async () => {
    // Notre domaine ne doit jamais servir de tremplin. La destination a été validée à l'écriture, mais une
    // ligne modifiée hors console, ou une règle durcie depuis, ne doit pas passer.
    const { server, cap } = app({ getByCode: async () => ({ tenantId: 't1', destination: 'javascript:alert(1)' }) });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}` });
    expect(res.statusCode).toBe(422);
    expect(res.headers.location).toBeUndefined();
    expect(cap.clics).toEqual([]); // et rien n'est compté sur un lien qu'on refuse de suivre
    await server.close();
  });

  it('🔴 un échec d’enregistrement du clic REDIRIGE quand même', async () => {
    // Mieux vaut un clic non compté qu'un destinataire bloqué sur une erreur.
    const { server } = app({ recordClick: async () => { throw new Error('base indisponible'); } });
    const { resultat: res, lignes } = await capturerJournal(() => server.inject({ method: 'GET', url: `/r/${CODE}` }));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.fr/promo');
    // Le clic perdu se voit au journal, avec l'ESPACE du lien : sans lui, la ligne ne dit pas chez qui chercher.
    expect(lignes.find((l) => l.msg === 'clic_non_enregistre')).toMatchObject({ lvl: 'error', err: 'base indisponible', code: CODE, tenantId: 't1' });
    await server.close();
  });

  it('🔴 le robot de Meta est REDIRIGÉ mais son clic n’est PAS compté', async () => {
    // Meta explore chaque bouton URL à la revue du template, donc AVANT le premier envoi : 70 faux clics
    // mesurés en production le 2026-08-21 sur un template jamais envoyé. Le rediriger reste indispensable,
    // le compter est un mensonge.
    const { server, cap } = app();
    const res = await server.inject({
      method: 'GET',
      url: `/r/${CODE}`,
      headers: { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.fr/promo');
    expect(cap.clics).toEqual([]);
    await server.close();
  });

  it('🔴 un relecteur de Meta est écarté par le RÉFÉRENT seul', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'GET',
      url: `/r/${CODE}`,
      headers: {
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Mobile/15E148 Safari/604.1',
        referer: 'https://lm.facebook.com/',
      },
    });
    expect(res.statusCode).toBe(302);
    expect(cap.clics).toEqual([]);
    await server.close();
  });

  it('🔴 ... et par le `fbclid` SEUL, sans référent', async () => {
    // Les deux signaux testés séparément : réunis dans un seul cas, le premier suffisait à faire passer le
    // test, et rien ne prouvait que le second était branché à travers la route (le paramètre d'URL doit
    // arriver jusqu'au filtre via `req.query`).
    const { server, cap } = app();
    const res = await server.inject({
      method: 'GET',
      url: `/r/${CODE}?fbclid=IwcGRvZgRleHRuA2FlbQIxMQ`,
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Mobile/15E148 Safari/604.1' },
    });
    expect(res.statusCode).toBe(302);
    expect(cap.clics).toEqual([]);
    await server.close();
  });

  it('🔴 un destinataire qui clique depuis WhatsApp est bien compté', async () => {
    // Le garde-fou ne vaut que s'il laisse passer le seul clic qui nous intéresse.
    const { server, cap } = app();
    const res = await server.inject({
      method: 'GET',
      url: `/r/${CODE}`,
      headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36' },
    });
    expect(res.statusCode).toBe(302);
    expect(cap.clics).toEqual([{ code: CODE, tenantId: 't1' }]);
    await server.close();
  });

  it('la route n’existe pas si la dépendance n’est pas fournie', async () => {
    const server = buildServer({ queue: new FakeQueue() });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}` });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('🔴 un clic ATTRIBUÉ remonte comme signal, dans l’espace du LIEN', async () => {
    const jeton = 'abcdefghjkmnpqrs';
    const { server, cap } = app({ contactParJeton: async (t, j) => (t === 't1' && j === jeton ? 'contact-1' : null) });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}/${jeton}` });
    expect(res.statusCode).toBe(302);
    expect(cap.signaux).toEqual([{ tenantId: 't1', contactId: 'contact-1', code: CODE }]);
    await server.close();
  });

  it('un clic ANONYME ne remonte pas : sans fiche, il n’y a pas de profil à mettre à jour', async () => {
    const { server, cap } = app();
    await server.inject({ method: 'GET', url: `/r/${CODE}` });
    expect(cap.clics).toHaveLength(1);
    expect(cap.signaux).toEqual([]);
    await server.close();
  });

  it('🔴 un clic de robot ne remonte pas non plus', async () => {
    const { server, cap } = app({ contactParJeton: async () => 'contact-1' });
    await server.inject({ method: 'GET', url: `/r/${CODE}/abcdefghjkmnpqrs`, headers: { 'user-agent': 'facebookexternalhit/1.1' } });
    expect(cap.signaux).toEqual([]);
    await server.close();
  });

  it('🔴 un signal en panne REDIRIGE quand même', async () => {
    const { server } = app({ contactParJeton: async () => 'contact-1', signalerClic: async () => { throw new Error('file pleine'); } });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}/abcdefghjkmnpqrs` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.fr/promo');
    await server.close();
  });

  it('🔴 la redirection n’ATTEND PAS le signal : une file lente ne retarde aucun clic', async () => {
    // Un signal qui ne se termine jamais : si la route l'attendait, `inject` ne rendrait jamais la main.
    const { server } = app({ contactParJeton: async () => 'contact-1', signalerClic: () => new Promise<void>(() => {}) });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}/abcdefghjkmnpqrs` });
    expect(res.statusCode).toBe(302);
    await server.close();
  });
});
