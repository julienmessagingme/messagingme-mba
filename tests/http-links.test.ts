import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import type { LiensDep, LinksRouteDeps } from '../src/http/links';
import { capturerJournal } from './journal';
import type { DestinationLien } from '../src/links/tracked-links.pg';
import { liensInertes } from './routes-inertes';
import { creerTravauxEnVol } from '../src/lib/en-vol';

const CODE = 'ab12cd34ef56';

interface Capture {
  clics: Array<{ code: string; tenantId: string }>;
  lus: string[];
  signaux: Array<{ tenantId: string; contactId: string; code: string }>;
}

function app(over: Partial<LiensDep & Pick<LinksRouteDeps, 'signalerClic' | 'enVol'>> = {}): { server: ReturnType<typeof buildServer>; cap: Capture } {
  const cap: Capture = { clics: [], lus: [], signaux: [] };
  const { signalerClic, enVol, ...liens } = over;
  const links: LinksRouteDeps = {
    liens: {
      ...liensInertes,
      getByCode: async (code): Promise<DestinationLien | null> => {
        cap.lus.push(code);
        return code === CODE ? { tenantId: 't1', destination: 'https://client.fr/promo', modele: null, boutique: false } : null;
      },
      recordClick: async (code, tenantId) => { cap.clics.push({ code, tenantId }); },
      ...liens,
    },
    signalerClic: signalerClic ?? (async (tenantId, contactId, code) => { cap.signaux.push({ tenantId, contactId, code }); }),
    enVol: enVol ?? creerTravauxEnVol(),
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
    const { server, cap } = app({ getByCode: async () => ({ tenantId: 't1', destination: 'javascript:alert(1)', modele: null, boutique: false }) });
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
    const { server, cap } = app({ resoudreJeton: async (t, j) => (t === 't1' && j === jeton ? { contactId: 'contact-1', champs: null } : null) });
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
    let lectures = 0;
    const { server, cap } = app({ resoudreJeton: async () => { lectures++; return { contactId: 'contact-1', champs: null }; } });
    await server.inject({ method: 'GET', url: `/r/${CODE}/abcdefghjkmnpqrs`, headers: { 'user-agent': 'facebookexternalhit/1.1' } });
    expect(cap.signaux).toEqual([]);
    expect(lectures).toBe(0); // URL fixe : le robot n'a besoin ni d'auteur ni de champs.
    await server.close();
  });

  it('🔴 un signal en panne REDIRIGE quand même', async () => {
    const { server } = app({ resoudreJeton: async () => ({ contactId: 'contact-1', champs: null }), signalerClic: async () => { throw new Error('file pleine'); } });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}/abcdefghjkmnpqrs` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.fr/promo');
    await server.close();
  });

  it('🔴 la redirection n’ATTEND PAS le signal : une file lente ne retarde aucun clic', async () => {
    // Un signal qui ne se termine jamais : si la route l'attendait, `inject` ne rendrait jamais la main.
    const { server } = app({ resoudreJeton: async () => ({ contactId: 'contact-1', champs: null }), signalerClic: () => new Promise<void>(() => {}) });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}/abcdefghjkmnpqrs` });
    expect(res.statusCode).toBe(302);
    await server.close();
  });

  it('🔴 mais l’ARRÊT de la copie l’attend : le signal parti après le 302 est suivi (relecture du lot A)', async () => {
    // Le signal s'enfile APRÈS la réponse. Sans suivi, l'arrêt d'une copie (réduction de l'autoscaler) fermait la file
    // sous lui, et le clic attribué que l'outil du client attend disparaissait sans trace.
    let finir: () => void = () => {};
    const signal = new Promise<void>((r) => { finir = r; });
    const enVol = creerTravauxEnVol();
    const { server } = app({ resoudreJeton: async () => ({ contactId: 'contact-1', champs: null }), signalerClic: () => signal, enVol });
    expect((await server.inject({ method: 'GET', url: `/r/${CODE}/abcdefghjkmnpqrs` })).statusCode).toBe(302);
    expect(await enVol.attendre(0), 'le signal est encore en vol, et l’arrêt le sait').toBe(1);
    finir();
    expect(await enVol.attendre(1000)).toBe(0);
    await server.close();
  });
});

describe('RC7 : une destination à champs se remplit AU CLIC avec la fiche de celui qui clique', () => {
  const JETON = 'abcdefghjkmnpqrs';
  const JETON_AUTRE = 'zyxwvtsrqpnmkjhg';
  const COMMANDE = 'https://client.fr/commande/{numero_commande}';

  /**
   * Deux espaces : le lien est dans `t1`. La fausse lecture de fiche ne répond que pour le BON couple (espace, jeton) :
   * c'est ce qui rend visible une lecture faite dans le mauvais espace. Chaque lecture est notée.
   */
  function appChamps(destination: string, fiches: Record<string, Record<string, string | null>> = {}, over: Partial<LiensDep> = {}) {
    const lectures: Array<{ tenantId: string; jeton: string; avecChamps: boolean }> = [];
    const { server, cap } = app({
      getByCode: async (code) => (code === CODE ? { tenantId: 't1', destination, modele: null, boutique: false } : null),
      resoudreJeton: async (tenantId, jeton, avecChamps) => {
        lectures.push({ tenantId, jeton, avecChamps });
        const champs = fiches[`${tenantId}:${jeton}`];
        return champs ? { contactId: 'contact-1', champs } : null;
      },
      ...over,
    });
    return { server, cap, lectures };
  }
  const humain = { 'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36' };

  it('🔴 un champ présent est remplacé par la valeur de la fiche, lue dans l’espace du LIEN', async () => {
    const { server, cap, lectures } = appChamps(COMMANDE, { [`t1:${JETON}`]: { numero_commande: 'A1234' } });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}/${JETON}`, headers: humain });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.fr/commande/A1234');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(lectures).toEqual([{ tenantId: 't1', jeton: JETON, avecChamps: true }]);
    expect(cap.clics).toHaveLength(1);
    expect(cap.signaux).toEqual([{ tenantId: 't1', contactId: 'contact-1', code: CODE }]);
    await server.close();
  });

  it('un champ vide ou absent de la fiche est RETIRÉ, et la redirection a lieu', async () => {
    const fiches: Array<Record<string, string | null>> = [{ numero_commande: '' }, { numero_commande: '   ' }, { numero_commande: null }, {}];
    for (const fiche of fiches) {
      const { server } = appChamps(COMMANDE, { [`t1:${JETON}`]: fiche });
      const res = await server.inject({ method: 'GET', url: `/r/${CODE}/${JETON}` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://client.fr/commande/');
      await server.close();
    }
  });

  it('🔴 jeton `anon`, mal formé ou absent (forme `/r/:code`) : champ retiré, AUCUNE lecture de fiche', async () => {
    for (const url of [`/r/${CODE}/anon`, `/r/${CODE}/pas-un-jeton`, `/r/${CODE}`]) {
      const { server, lectures } = appChamps(COMMANDE, { [`t1:${JETON}`]: { numero_commande: 'A1234' } });
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe('https://client.fr/commande/');
      expect(lectures, url).toEqual([]);
      await server.close();
    }
  });

  it('🔴 le jeton d’un contact d’un AUTRE espace : champ retiré, et la fiche n’est lue que dans l’espace du lien', async () => {
    // La fiche existe, mais dans `t2`. L'URL ne porte aucun espace : le seul espace que la route peut passer est
    // celui du lien retrouvé par son code.
    const { server, lectures } = appChamps(COMMANDE, { [`t2:${JETON_AUTRE}`]: { numero_commande: 'SECRET-T2' } });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}/${JETON_AUTRE}`, headers: humain });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.fr/commande/');
    expect(lectures).toEqual([{ tenantId: 't1', jeton: JETON_AUTRE, avecChamps: true }]);
    await server.close();
  });

  it('🔴 une valeur écrite par le contact reste à SA place, encodée, et ne change jamais l’hôte', async () => {
    const pieges = ['a/b', 'a?x=1', 'a#frag', 'evil.com@x', '..', '.', '../../admin', '%2F', '//evil.com', '\\\\evil.com', 'https://evil.com', 'A&utm=x', 'é ç'];
    for (const valeur of pieges) {
      for (const destination of [COMMANDE, 'https://client.fr/suivi?ref={numero_commande}&src=wa', 'https://client.fr/#{numero_commande}']) {
        const { server } = appChamps(destination, { [`t1:${JETON}`]: { numero_commande: valeur } });
        const res = await server.inject({ method: 'GET', url: `/r/${CODE}/${JETON}` });
        const location = String(res.headers.location);
        const quoi = `${destination} <- ${valeur}`;
        expect(res.statusCode, quoi).toBe(302);
        const lue = new URL(location);
        expect(lue.host, quoi).toBe('client.fr');
        expect(lue.protocol, quoi).toBe('https:');
        expect(lue.username, quoi).toBe('');
        if (destination === COMMANDE) expect(lue.pathname.startsWith('/commande/'), quoi).toBe(true);
        if (valeur !== '.' && valeur !== '..') expect(location, quoi).toContain(encodeURIComponent(valeur));
        if (destination.includes('?ref=')) expect(lue.searchParams.get('src'), quoi).toBe('wa');
        await server.close();
      }
    }
  });

  it('🔴 le robot de Meta est redirigé vers l’adresse REMPLIE : le remplacement ne dépend pas du comptage', async () => {
    const { server, cap } = appChamps(COMMANDE, { [`t1:${JETON}`]: { numero_commande: 'A1234' } });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}/${JETON}`, headers: { 'user-agent': 'facebookexternalhit/1.1' } });
    expect(res.headers.location).toBe('https://client.fr/commande/A1234');
    expect(cap.clics).toEqual([]);
    await server.close();
  });

  it('🔴 une lecture de fiche en échec : champ retiré, 302 quand même (jamais de 5xx), et une trace', async () => {
    const { server } = appChamps(COMMANDE, {}, { resoudreJeton: async () => { throw new Error('base indisponible'); } });
    const { resultat: res, lignes } = await capturerJournal(() => server.inject({ method: 'GET', url: `/r/${CODE}/${JETON}` }));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.fr/commande/');
    expect(lignes.find((l) => l.msg === 'champs_lien_non_lus')).toMatchObject({ lvl: 'error', code: CODE, tenantId: 't1' });
    await server.close();
  });

  it('un échec de lecture des champs garde le clic attribué si la lecture légère réussit', async () => {
    const lectures: boolean[] = [];
    const { server, cap } = appChamps(COMMANDE, {}, {
      resoudreJeton: async (_tenantId, _jeton, avecChamps) => {
        lectures.push(avecChamps);
        if (avecChamps) throw new Error('champs indisponibles');
        return { contactId: 'contact-1', champs: null };
      },
    });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}/${JETON}`, headers: humain });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.fr/commande/');
    expect(lectures).toEqual([true, false]);
    expect(cap.clics).toHaveLength(1);
    expect(cap.signaux).toEqual([{ tenantId: 't1', contactId: 'contact-1', code: CODE }]);
    await server.close();
  });

  it('🔴 une valeur que `encodeURIComponent` refuse (demi-substitut isolé) : champ retiré, 302 quand même, et une trace', async () => {
    const { server } = appChamps(COMMANDE, { [`t1:${JETON}`]: { numero_commande: 'A\uD800' } });
    const { resultat: res, lignes } = await capturerJournal(() => server.inject({ method: 'GET', url: `/r/${CODE}/${JETON}` }));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.fr/commande/');
    expect(lignes.find((l) => l.msg === 'champs_lien_non_remplis')).toMatchObject({ lvl: 'error', code: CODE, tenantId: 't1' });
    await server.close();
  });

  it('🔴 une destination FIXE redirige exactement comme avant, sans lire les champs', async () => {
    for (const url of [`/r/${CODE}`, `/r/${CODE}/${JETON}`, `/r/${CODE}/anon`]) {
      const { server, lectures } = appChamps('https://client.fr/promo', { [`t1:${JETON}`]: { numero_commande: 'A1234' } });
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe('https://client.fr/promo');
      expect(lectures, url).toEqual(url.endsWith(`/${JETON}`) ? [{ tenantId: 't1', jeton: JETON, avecChamps: false }] : []);
      await server.close();
    }
  });

  it('🔴 une destination écrite avant ce lot qui ne se laisse pas analyser repart TELLE QUELLE, sans lire les champs', async () => {
    // Porte à sens unique : une accolade dans l'hôte, orpheline ou mêlée à `{{1}}` n'a jamais été un champ.
    for (const destination of ['https://{x}.client.fr/a', 'https://client.fr/a}b', 'https://client.fr/{{1}}/b', 'https://client.fr/{}']) {
      const { server, lectures } = appChamps(destination, { [`t1:${JETON}`]: { x: 'evil.com' } });
      const res = await server.inject({ method: 'GET', url: `/r/${CODE}/${JETON}` });
      expect(res.statusCode, destination).toBe(302);
      expect(res.headers.location, destination).toBe(destination);
      expect(lectures, destination).toEqual([{ tenantId: 't1', jeton: JETON, avecChamps: false }]);
      await server.close();
    }
  });
});

/** Les UTM de nos liens (plan 2026-10-28, tâche 6a) : seulement pour un espace qui a une boutique Shopify branchée. */
describe('les UTM de la redirection', () => {
  const lien = (boutique: boolean, destination = 'https://boutique.fr/commande/{numero_commande}', modele: string | null = 'soldes_hiver') =>
    async (code: string): Promise<DestinationLien | null> => (code === CODE ? { tenantId: 't1', destination, modele, boutique } : null);
  const JETON = 'abcdefghjkmnpqrs';

  it('sans boutique branchée, la destination ne change pas', async () => {
    const { server } = app({ getByCode: lien(false, 'https://client.fr/promo') });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}` });
    expect(res.headers.location).toBe('https://client.fr/promo');
    await server.close();
  });

  it('avec boutique, la redirection porte les UTM, APRÈS le remplissage des champs', async () => {
    const { server } = app({
      getByCode: lien(true),
      resoudreJeton: async () => ({ contactId: 'contact-1', champs: { numero_commande: 'A1234' } }),
    });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}/${JETON}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://boutique.fr/commande/A1234?utm_source=whatsapp&utm_medium=messagingme&utm_campaign=soldes_hiver');
    await server.close();
  });

  it('un lien sans modèle (message RCS) ne porte pas d’UTM WhatsApp', async () => {
    const { server } = app({ getByCode: lien(true, 'https://boutique.fr/', null) });
    const res = await server.inject({ method: 'GET', url: `/r/${CODE}` });
    expect(res.headers.location).toBe('https://boutique.fr/');
    await server.close();
  });
});
