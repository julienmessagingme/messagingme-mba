import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { RateLimiter } from '../src/auth/rate-limit';
import { sha256Hex } from '../src/lib/signature';
import type { WebhookEntrantRouteDeps } from '../src/http/webhook-entrant';
import type { WebhookPublic } from '../src/webhook-entrant/store.pg';

const CODE = 'ab12cd34ef56gh78jk90mn12pq';
const SECRET = 'whk_secret_du_client';

const HOOK: WebhookPublic = {
  id: 'wh1',
  tenantId: 't1',
  name: 'Formulaire du site',
  enabled: true,
  optIn: false,
  secretHash: null,
  mapping: [
    { chemin: 'client.tel', cible: 'sys:phone' },
    { chemin: 'client.nom', cible: 'sys:name' },
    { chemin: 'lignes[0].ref', cible: 'field:reference' },
  ],
  createContact: true,
  automationId: null,
};

const CORPS = {
  client: { tel: '06 12 34 56 78', nom: 'Marie Durand' },
  lignes: [{ ref: 'A-1' }],
};

interface Capture {
  lus: string[];
  appels: Array<{ tenantId: string; id: string; payload: unknown; cree: boolean }>;
  ecrits: Array<{ tenantId: string; phone: string; name: string | null; fields: Record<string, string>; optIn: boolean; optInSource: string }>;
  publies: Array<{ tenantId: string; ev: { kind: 'webhook'; waId: string; webhookId: string } }>;
}

function app(hook: WebhookPublic | null = HOOK, over: Partial<WebhookEntrantRouteDeps> = {}): {
  server: ReturnType<typeof buildServer>; cap: Capture;
} {
  const cap: Capture = { lus: [], appels: [], ecrits: [], publies: [] };
  const webhookEntrant: WebhookEntrantRouteDeps = {
    getByCode: async (code) => { cap.lus.push(code); return code === CODE ? hook : null; },
    recordCall: async (tenantId, id, payload, cree) => { cap.appels.push({ tenantId, id, payload, cree }); },
    trouverWaId: async () => null,
    ecrireContact: async (tenantId, e) => { cap.ecrits.push({ tenantId, ...e }); return { statut: 'created' }; },
    publish: async (tenantId, ev) => { cap.publies.push({ tenantId, ev }); },
    // Large par défaut : ces tests éprouvent autre chose que le frein des codes jamais vus (décrit plus bas).
    budgetInconnus: new RateLimiter(1000, 60_000),
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), webhookEntrant }), cap };
}

const post = (server: ReturnType<typeof buildServer>, body: unknown, headers: Record<string, string> = {}, code = CODE) =>
  server.inject({
    method: 'POST',
    url: `/w/${code}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('webhook entrant : la porte', () => {
  it('🔴 code MAL FORMÉ -> 404 sans toucher la base', async () => {
    // Cette URL reçoit des robots et des scans : aucune raison de leur offrir une requête SQL par essai.
    const { server, cap } = app();
    for (const mauvais of ['court', `${CODE}xx`, '../../etc/passwd', 'AB12CD34EF56GH78JK90MN12P!']) {
      const res = await post(server, CORPS, {}, encodeURIComponent(mauvais));
      expect(res.statusCode, mauvais).toBe(404);
    }
    expect(cap.lus).toEqual([]);
    await server.close();
  });

  it('code INCONNU -> 404', async () => {
    const { server } = app();
    const res = await post(server, CORPS, {}, 'zz12cd34ef56gh78jk90mn12pq');
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('🔴 webhook DÉSACTIVÉ -> 404, exactement comme un code inconnu', async () => {
    // Un tiers n'a pas à distinguer « ce webhook n'existe pas » de « il existe mais il est éteint ».
    const { server, cap } = app({ ...HOOK, enabled: false });
    const res = await post(server, CORPS);
    expect(res.statusCode).toBe(404);
    expect(cap.ecrits).toEqual([]);
    expect(cap.appels).toEqual([]);
    await server.close();
  });

  it('la casse du code est normalisée', async () => {
    const { server, cap } = app();
    const res = await post(server, CORPS, {}, CODE.toUpperCase());
    expect(res.statusCode).toBe(200);
    expect(cap.lus).toEqual([CODE]);
    await server.close();
  });

  it('la route n’existe pas si la dépendance n’est pas fournie', async () => {
    const server = buildServer({ queue: new FakeQueue() });
    const res = await post(server, CORPS);
    expect(res.statusCode).toBe(404);
    await server.close();
  });
});

describe('webhook entrant : le secret', () => {
  const avecSecret = { ...HOOK, secretHash: sha256Hex(SECRET) };

  it('🔴 secret exigé et ABSENT -> 401', async () => {
    const { server, cap } = app(avecSecret);
    const res = await post(server, CORPS);
    expect(res.statusCode).toBe(401);
    expect(cap.ecrits).toEqual([]);
    await server.close();
  });

  it('🔴 secret FAUX, ou celui d’un AUTRE webhook -> 401, même réponse', async () => {
    const { server } = app(avecSecret);
    const attendu = { statut: 401, corps: JSON.parse((await post(server, CORPS)).body) };
    for (const faux of ['whk_autre_client', '', ' whk_secret_du_client']) {
      const res = await post(server, CORPS, { 'x-webhook-secret': faux });
      expect(res.statusCode, faux).toBe(attendu.statut);
      expect(JSON.parse(res.body), faux).toEqual(attendu.corps);
    }
    await server.close();
  });

  it('secret JUSTE -> l’appel passe', async () => {
    const { server, cap } = app(avecSecret);
    const res = await post(server, CORPS, { 'x-webhook-secret': SECRET });
    expect(res.statusCode).toBe(200);
    expect(cap.ecrits).toHaveLength(1);
    await server.close();
  });

  it('sans secret configuré, aucun en-tête n’est exigé (un formulaire de site ne sait pas en poser)', async () => {
    const { server } = app();
    expect((await post(server, CORPS)).statusCode).toBe(200);
    await server.close();
  });
});

describe('webhook entrant : le corps', () => {
  it('🔴 un corps NON-JSON n’est pas pris pour un objet vide', async () => {
    // Le parser global transforme un corps invalide en `{}` sans lever (il est écrit pour le webhook Meta,
    // où la signature tranche ensuite). Sans la relecture du brut, cet appel passerait pour un objet vide et
    // rendrait 200 « rien à faire », en laissant l'intégrateur chercher un bug ailleurs.
    const { server, cap } = app();
    const res = await post(server, '{pas du json');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/JSON invalide/);
    expect(cap.appels).toEqual([]);
    await server.close();
  });

  it('un corps VIDE -> 400 explicite', async () => {
    const { server } = app();
    const res = await post(server, '');
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('un objet JSON vide est un appel VALIDE (200), il ne fait simplement rien', async () => {
    const { server, cap } = app();
    const res = await post(server, {});
    expect(res.statusCode).toBe(200);
    const corps = JSON.parse(res.body);
    expect(corps.contact).toBe('absent');
    expect(corps.raison).toMatch(/téléphone/);
    // Le payload est enregistré QUAND MÊME : c'est ce qui permet de construire le mapping dans l'écran.
    expect(cap.appels).toEqual([{ tenantId: 't1', id: 'wh1', payload: {}, cree: false }]);
    await server.close();
  });
});

describe('webhook entrant : ce qu’il écrit', () => {
  it('🔴 lit les chemins du mapping, y compris dans un tableau', async () => {
    const { server, cap } = app();
    const res = await post(server, CORPS);
    expect(res.statusCode).toBe(200);
    expect(cap.ecrits).toEqual([{
      tenantId: 't1',
      phone: '+33612345678', // normalisé par le MÊME chemin que l'import CSV
      name: 'Marie Durand',
      fields: { reference: 'A-1' },
      optIn: false,
      optInSource: 'webhook:Formulaire du site',
    }]);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, contact: 'cree', champs: 1, scenario: 'aucun' });
    await server.close();
  });

  it('🔴 le tenant vient du CODE, jamais du corps', async () => {
    // Une URL remise à Zapier n'est pas un connecteur maison : accepter un `tenantId` du corps laisserait
    // n'importe quel appelant écrire dans l'espace de son choix.
    const { server, cap } = app({ ...HOOK, automationId: 'auto1' });
    await post(server, { ...CORPS, tenantId: 'autre-espace', tenant_id: 'autre-espace' });
    expect(cap.ecrits[0]?.tenantId).toBe('t1');
    expect(cap.publies[0]?.tenantId).toBe('t1');
    await server.close();
  });

  it('🔴 un téléphone inexploitable -> 200 qui le DIT, et rien d’écrit', async () => {
    const { server, cap } = app();
    const res = await post(server, { client: { tel: 'appelez-moi' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).raison).toMatch(/inexploitable/);
    expect(cap.ecrits).toEqual([]);
    expect(cap.appels).toHaveLength(1); // le payload reste enregistré
    await server.close();
  });

  it('🔴 contact inconnu + création DÉSACTIVÉE -> rien, et la réponse dit pourquoi', async () => {
    const { server, cap } = app({ ...HOOK, createContact: false });
    const res = await post(server, CORPS);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).contact).toBe('absent');
    expect(JSON.parse(res.body).raison).toMatch(/création est désactivée/);
    expect(cap.ecrits).toEqual([]);
    await server.close();
  });

  it('contact DÉJÀ connu -> mis à jour, jamais dupliqué', async () => {
    const { server, cap } = app(HOOK, {
      trouverWaId: async () => '33612345678',
      ecrireContact: async (tenantId, e) => { cap.ecrits.push({ tenantId, ...e }); return { statut: 'updated' }; },
    });
    const res = await post(server, CORPS);
    expect(JSON.parse(res.body).contact).toBe('trouve');
    await server.close();
  });

  it('🔴 une valeur refusée par la validation de champ -> 200 avec la raison, PAS une erreur', async () => {
    // Le tiers ne doit pas réessayer en boucle pour une valeur qui sera toujours refusée.
    const { server, cap } = app(HOOK, {
      ecrireContact: async () => ({ statut: 'error', raison: 'valeur invalide pour « reference » (number)' }),
    });
    const res = await post(server, CORPS);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).raison).toMatch(/valeur invalide/);
    expect(cap.appels[0]?.cree).toBe(false);
    await server.close();
  });

  it('les chemins du mapping qui n’ont rien rendu sont RAPPORTÉS', async () => {
    const { server } = app();
    const res = await post(server, { client: { tel: '0612345678' } });
    expect(JSON.parse(res.body).ignores).toEqual(['client.nom', 'lignes[0].ref']);
    await server.close();
  });

  it('l’échec d’enregistrement du payload ne transforme pas un appel réussi en erreur', async () => {
    const { server } = app(HOOK, { recordCall: async () => { throw new Error('base indisponible'); } });
    const res = await post(server, CORPS);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).contact).toBe('cree');
    await server.close();
  });
});

describe('webhook entrant : le consentement', () => {
  it('🔴 case DÉCOCHÉE -> le contact naît en consentement « inconnu »', async () => {
    // C'est le défaut sûr : on ne peut pas déduire un consentement du contenu reçu.
    const { server, cap } = app();
    await post(server, CORPS);
    expect(cap.ecrits[0]?.optIn).toBe(false);
    await server.close();
  });

  it('🔴 case COCHÉE -> le contact est opt-in, et la trace dit PAR OÙ', async () => {
    // `opt_in_source` est ce qui permet de justifier un consentement ensuite : « webhook » seul ne dirait
    // pas LEQUEL, et un espace peut en avoir plusieurs, alimentés par des formulaires différents.
    const { server, cap } = app({ ...HOOK, optIn: true });
    await post(server, CORPS);
    expect(cap.ecrits[0]?.optIn).toBe(true);
    expect(cap.ecrits[0]?.optInSource).toBe('webhook:Formulaire du site');
    await server.close();
  });

  it('la trace est bornée : un nom à rallonge ne déborde pas', async () => {
    const { server, cap } = app({ ...HOOK, optIn: true, name: 'x'.repeat(300) });
    await post(server, CORPS);
    expect(cap.ecrits[0]?.optInSource.length).toBeLessThanOrEqual(100);
    await server.close();
  });
});

describe('webhook entrant : le scénario', () => {
  it('🔴 aucun scénario configuré -> aucun événement publié', async () => {
    const { server, cap } = app();
    const res = await post(server, CORPS);
    expect(JSON.parse(res.body).scenario).toBe('aucun');
    expect(cap.publies).toEqual([]);
    await server.close();
  });

  it('🔴 scénario configuré -> UN événement, portant l’identifiant du webhook', async () => {
    // C'est cet identifiant qui empêche l'appel d'un webhook de déclencher les automations d'un AUTRE.
    const { server, cap } = app({ ...HOOK, automationId: 'auto1' });
    const res = await post(server, CORPS);
    expect(JSON.parse(res.body).scenario).toBe('publie');
    expect(cap.publies).toEqual([{ tenantId: 't1', ev: { kind: 'webhook', waId: '33612345678', webhookId: 'wh1' } }]);
    await server.close();
  });

  it('🔴 pas de téléphone -> aucun événement, même avec un scénario configuré', async () => {
    // Sans contact à joindre, publier reviendrait à faire tourner le moteur d'automation à vide.
    const { server, cap } = app({ ...HOOK, automationId: 'auto1' });
    await post(server, { lignes: [{ ref: 'A-1' }] });
    expect(cap.publies).toEqual([]);
    await server.close();
  });
});

describe('webhook entrant : les pannes', () => {
  it('🔴 une file indisponible rend une ERREUR au tiers, pour qu’il réessaie', async () => {
    // Seule exception au « toujours 200 » : ce n'est pas un refus métier, c'est une panne. Répondre 200 en
    // annonçant « scénario publié » perdrait l'événement en silence, et personne ne le saurait.
    const { server } = app({ ...HOOK, automationId: 'auto1' }, {
      publish: async () => { throw new Error('pg-boss indisponible'); },
    });
    const res = await post(server, CORPS);
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    await server.close();
  });

  it('🔴 ... et le payload est tout de même enregistré', async () => {
    // C'est le seul moyen de regarder ensuite ce que le tiers avait envoyé.
    const { server, cap } = app({ ...HOOK, automationId: 'auto1' }, {
      publish: async () => { throw new Error('pg-boss indisponible'); },
    });
    await post(server, CORPS);
    expect(cap.appels).toHaveLength(1);
    await server.close();
  });

  it('🔴 avec la création activée, on n’interroge PAS la base pour savoir si le contact existe', async () => {
    // `ecrireContact` rend déjà created/updated : la question coûterait une requête de plus par appel, sur
    // le chemin chaud, pour une réponse qu'on obtient de toute façon.
    let interroge = 0;
    const { server } = app(HOOK, { trouverWaId: async () => { interroge += 1; return null; } });
    await post(server, CORPS);
    expect(interroge).toBe(0);
    await server.close();
  });

  it('avec la création désactivée, on l’interroge (c’est la seule façon de savoir)', async () => {
    let interroge = 0;
    const { server } = app({ ...HOOK, createContact: false }, { trouverWaId: async () => { interroge += 1; return null; } });
    await post(server, CORPS);
    expect(interroge).toBe(1);
    await server.close();
  });
});

describe('webhook entrant : le plafond de débit', () => {
  it('🔴 au-delà du plafond -> 429, et plus rien n’est écrit', async () => {
    const { server, cap } = app(HOOK, { limiter: new RateLimiter(2, 60_000) });
    expect((await post(server, CORPS)).statusCode).toBe(200);
    expect((await post(server, CORPS)).statusCode).toBe(200);
    const trop = await post(server, CORPS);
    expect(trop.statusCode).toBe(429);
    expect(cap.ecrits).toHaveLength(2);
    // La réponse ne révèle ni le plafond, ni l'espace, ni le nom du webhook.
    expect(trop.body).not.toMatch(/t1|wh1|120/);
    await server.close();
  });

  it('le plafond est compté PAR WEBHOOK, pas globalement', async () => {
    const AUTRE = 'zz12cd34ef56gh78jk90mn12pq';
    const { server } = app(HOOK, {
      limiter: new RateLimiter(1, 60_000),
      getByCode: async (code) => (code === CODE ? HOOK : { ...HOOK, id: 'wh2', code }) as WebhookPublic,
    });
    expect((await post(server, CORPS)).statusCode).toBe(200);
    expect((await post(server, CORPS)).statusCode).toBe(429);
    expect((await post(server, CORPS, {}, AUTRE)).statusCode).toBe(200);
    await server.close();
  });
});


/**
 * Campagne AU FIL DE L'EAU : le webhook n'a pas forcément de scénario attaché, et publiait donc RIEN dans ce
 * cas. Le jour où une campagne se nourrit de l'adresse, ce silence devient une panne muette : la campagne
 * reste « en cours » et ne reçoit jamais un seul lead.
 */
describe('webhook entrant : alimente une campagne au fil de l eau', () => {
  it("🔴 publie l'événement MÊME sans scénario, quand une campagne attend les arrivants", async () => {
    const { server, cap } = app({ ...HOOK, automationId: null, alimenteCampagne: true });
    const res = await post(server, CORPS);
    expect(res.statusCode).toBe(200);
    expect(cap.publies).toHaveLength(1);
    expect(cap.publies[0]!.ev).toEqual({ kind: 'webhook', waId: '33612345678', webhookId: 'wh1' });
    // La réponse le DIT au tiers : son appel nourrit un envoi, même sans scénario.
    expect(res.json()).toMatchObject({ scenario: 'aucun', campagne: 'alimentee' });
    await server.close();
  });

  it("aucune campagne, aucun scénario -> toujours RIEN de publié (comportement d'avant intact)", async () => {
    const { server, cap } = app({ ...HOOK, automationId: null });
    const res = await post(server, CORPS);
    expect(res.statusCode).toBe(200);
    expect(cap.publies).toEqual([]);
    expect(res.json()).toMatchObject({ campagne: 'aucune' });
    await server.close();
  });

  it('scénario ET campagne : UN SEUL événement, le worker sert les deux', async () => {
    const { server, cap } = app({ ...HOOK, automationId: 'a1', alimenteCampagne: true });
    await post(server, CORPS);
    expect(cap.publies).toHaveLength(1);
    await server.close();
  });

  it("un contact non écrit (téléphone inexploitable) ne publie rien : il n'y a personne à inscrire", async () => {
    const { server, cap } = app({ ...HOOK, automationId: null, alimenteCampagne: true });
    await post(server, { client: { tel: 'pas un numéro', nom: 'X' } });
    expect(cap.publies).toEqual([]);
    await server.close();
  });
});

/**
 * LE PLAFOND NE COMPTE QUE DES WEBHOOKS QUI EXISTENT (2026-09-21).
 *
 * 🔴 Le programme II l'avait remonté AVANT `getByCode` pour TOUS les codes, pour qu'un appel refusé ne coûte
 * plus de requête. La clé devenait alors choisie par l'appelant : des codes inventés en masse remplissaient la
 * table, et le VRAI code d'un client, dont l'entrée expire à chaque fenêtre, était refusé à la suivante. Il se
 * prend désormais AVANT la base pour un code déjà RÉSOLU (aucun code inventé ne l'est), APRÈS pour les autres.
 */
describe('webhook entrant : le plafond par code, sur des codes qui existent', () => {
  it('🔴 au-delà du plafond, plus RIEN n’est écrit, et un refus ne coûte plus de lecture', async () => {
    const { server, cap } = app(HOOK, { limiter: new RateLimiter(3, 60_000) });
    for (let i = 0; i < 3; i += 1) {
      const r = await post(server, CORPS);
      expect(r.statusCode).not.toBe(429);
    }
    for (let i = 0; i < 20; i += 1) {
      const r = await post(server, CORPS);
      expect(r.statusCode).toBe(429);
    }
    // Ce qu'on protège d'un code qui a fuité : les écritures. Aucun contact, aucun payload enregistré au-delà.
    expect(cap.ecrits).toHaveLength(3);
    expect(cap.appels).toHaveLength(3);
    // 🔴 Le code est RÉSOLU dès le premier appel : ses refus se prennent avant la base, donc les vingt 429 ne
    // coûtent aucune lecture (ils en coûtaient une chacun quand le plafond se prenait toujours après).
    expect(cap.lus).toHaveLength(3);
    await server.close();
  });

  it('🔴 des codes inventés en masse n’évincent pas le vrai code', async () => {
    // Une table de DEUX places et cinquante codes bien formés inventés : le vrai doit toujours passer. Avec le
    // plafond pris avant la base, les deux premiers codes inventés remplissaient la table et le vrai, clé
    // neuve, recevait 429.
    const { server, cap } = app(HOOK, { limiter: new RateLimiter(100, 60_000, undefined, 2) });
    const statuts = new Set<number>();
    for (let i = 0; i < 50; i += 1) statuts.add((await post(server, CORPS, {}, String(i).padStart(26, 'z'))).statusCode);
    // Le vrai code d'abord : c'est LUI dont le refus est le symptôme du défaut.
    expect((await post(server, CORPS)).statusCode, 'le vrai code du client').toBe(200);
    expect([...statuts], 'un code inventé est inconnu, rien de plus').toEqual([404]);
    expect(cap.ecrits).toHaveLength(1);
    await server.close();
  });

  it('un webhook ÉTEINT n’entre pas dans la table non plus', async () => {
    // La table est bornée par le nombre de webhooks ACTIFS : un code éteint rend 404 avant le plafond.
    const { server } = app({ ...HOOK, enabled: false }, { limiter: new RateLimiter(1, 60_000) });
    for (let i = 0; i < 5; i += 1) expect((await post(server, CORPS)).statusCode).toBe(404);
    await server.close();
  });
});

/**
 * 🔴 LE FREIN DES CODES JAMAIS VUS, AVANT LA BASE (décision de Julien du 2026-09-21). Même mécanique que les
 * rappels RCS : un budget COMMUN borne les lectures que coûtent des codes inventés, sans rien retirer à un code
 * déjà résolu.
 */
describe('webhook entrant : le frein des codes jamais vus', () => {
  const invente = (i: number): string => String(i).padStart(26, 'y');

  it('🔴 des codes inventés en masse ne coûtent que le budget en lectures, et le refus ne dit rien du budget', async () => {
    const { server, cap } = app(HOOK, { budgetInconnus: new RateLimiter(5, 60_000) });
    const refus: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 30; i += 1) {
      const r = await post(server, CORPS, {}, invente(i));
      if (r.statusCode === 429) refus.push(r.headers);
    }
    expect(cap.lus, 'la base ne voit que le budget').toHaveLength(5);
    expect(refus).toHaveLength(25);
    expect(Number(refus[0]!['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Object.keys(refus[0]!).filter((k) => k.startsWith('x-ratelimit'))).toEqual([]);
    await server.close();
  });

  it('🔴 un webhook déjà résolu traverse une attaque qui a épuisé le budget', async () => {
    const { server, cap } = app(HOOK, { budgetInconnus: new RateLimiter(3, 60_000) });
    expect((await post(server, CORPS)).statusCode).toBe(200);
    for (let i = 0; i < 20; i += 1) await post(server, CORPS, {}, invente(i));
    expect((await post(server, CORPS)).statusCode, 'l’intégration du client').toBe(200);
    expect(cap.ecrits).toHaveLength(2);
    await server.close();
  });

  it('🔴 un webhook éteint perd son laissez-passer', async () => {
    let actif = true;
    const { server, cap } = app(HOOK, {
      budgetInconnus: new RateLimiter(2, 60_000),
      getByCode: async (code) => { cap.lus.push(code); return code === CODE ? { ...HOOK, enabled: actif } : null; },
    });
    expect((await post(server, CORPS)).statusCode).toBe(200);
    actif = false;
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) codes.push((await post(server, CORPS)).statusCode);
    expect(codes).toContain(429);
    expect(cap.lus.length).toBeLessThanOrEqual(4);
    await server.close();
  });

  it('à 0, le frein est désactivé : chaque code inventé va en base, comme avant', async () => {
    const { server, cap } = app(HOOK, { budgetInconnus: new RateLimiter(0, 60_000) });
    for (let i = 0; i < 10; i += 1) expect((await post(server, CORPS, {}, invente(i))).statusCode).toBe(404);
    expect(cap.lus).toHaveLength(10);
    await server.close();
  });
});
