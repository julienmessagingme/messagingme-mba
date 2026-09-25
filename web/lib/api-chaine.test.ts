import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Le module d'appel de la section Chaîne.
 *
 * Ce que ces tests protègent, et qui ne se voit pas à la lecture :
 *
 *  1. 🔴 UN CHEMIN EST UNE CHAÎNE DE CARACTÈRES, donc le compilateur ne voit rien. Au lot précédent, un
 *     écran tapait `/connexion` quand le serveur montait `/connection` : aucun test de composant ne pouvait
 *     l'attraper, seulement un 404 découvert à l'écran. Les dix chemins sont donc comparés un par un aux
 *     routes réellement montées par `src/http/channels-me.ts`, méthode comprise.
 *  2. Il y a DIX routes. Le plan en annonçait huit et oubliait `POST /links/:id/enable`, qui est le seul
 *     chemin de réparation d'un lien dont l'allumage automatique a échoué. Un front qui ne le câble pas
 *     laisse un bouton mort sans recours visible, alors que le serveur sait le rallumer.
 *  3. Les bornes de saisie sont recopiées à la main depuis les schémas Zod du serveur (`web/` n'importe
 *     jamais `src/`). Une recopie non testée dérive : le plan portait 60 pour une phrase que le serveur
 *     accepte à 300.
 *  4. Aucune fonction ne rattrape d'erreur : un 422 sur le test de connexion doit REMONTER. Une version qui
 *     le mangerait rendrait l'échec invisible.
 */

// Le socle HTTP est remplacé : ce test ne touche AUCUN réseau. On observe ce que `request` reçoit.
const appels: Array<{ path: string; init?: RequestInit }> = [];
let reponse: unknown = {};
let jet: unknown = null;

vi.mock('./http', () => ({
  request: (path: string, init?: RequestInit) => {
    appels.push({ path, init });
    if (jet !== null) return Promise.reject(jet);
    return Promise.resolve(reponse);
  },
}));

import {
  MAX_MEDIA_URL, MAX_PHRASE, MAX_TEXTE_POST,
  allumerLienChaine, creerLienChaine, debrancherChaine, demanderActivationChaine, enregistrerConnexionChaine,
  eteindreLienChaine, getConnexionChaine, listerConversationsChaine, listerLiensChaine, listerPostsChaine,
  nomDeLaChaine, publierPostChaine,
  testerConnexionChaine,
  type ReponseConnexionChaine,
} from './api-chaine';

const T = 'tenant-1';
const ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  appels.length = 0;
  reponse = {};
  jet = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** La méthode telle que `request` la verra : absente veut dire GET, comme dans `web/lib/http.ts`. */
const methode = (init?: RequestInit): string => (init?.method ?? 'GET').toUpperCase();

describe('api-chaine : les douze chemins gelés', () => {
  /**
   * 🔴 LE TEST CENTRAL. Chaque ligne est recopiée de `src/http/channels-me.ts` : la base y vaut
   * `/tenants/:tenantId/channels-me`, et les douze `app.<verbe>` suivent. Si une route bouge côté serveur,
   * c'est ici que ça casse, pas devant un client.
   */
  const CONTRAT: Array<{ nom: string; appel: () => Promise<unknown>; verbe: string; chemin: string }> = [
    { nom: 'GET /connection', verbe: 'GET', chemin: `/tenants/${T}/channels-me/connection`,
      appel: () => getConnexionChaine(T) },
    { nom: 'PUT /connection', verbe: 'PUT', chemin: `/tenants/${T}/channels-me/connection`,
      appel: () => enregistrerConnexionChaine(T, { orgId: 'o', channelId: 'c', apiKey: 'k', secret: 's' }) },
    // La douzième (2026-09-25) : débrancher la chaîne depuis l'Accueil, « Canaux et services ».
    { nom: 'DELETE /connection', verbe: 'DELETE', chemin: `/tenants/${T}/channels-me/connection`,
      appel: () => debrancherChaine(T) },
    { nom: 'POST /connection/test', verbe: 'POST', chemin: `/tenants/${T}/channels-me/connection/test`,
      appel: () => testerConnexionChaine(T) },
    { nom: 'GET /links', verbe: 'GET', chemin: `/tenants/${T}/channels-me/links`,
      appel: () => listerLiensChaine(T) },
    { nom: 'POST /links', verbe: 'POST', chemin: `/tenants/${T}/channels-me/links`,
      appel: () => creerLienChaine(T, { workflowId: 'w', phrase: 'p' }) },
    { nom: 'POST /links/:id/disable', verbe: 'POST', chemin: `/tenants/${T}/channels-me/links/${ID}/disable`,
      appel: () => eteindreLienChaine(T, ID) },
    { nom: 'POST /links/:id/enable', verbe: 'POST', chemin: `/tenants/${T}/channels-me/links/${ID}/enable`,
      appel: () => allumerLienChaine(T, ID) },
    { nom: 'GET /posts', verbe: 'GET', chemin: `/tenants/${T}/channels-me/posts`,
      appel: () => listerPostsChaine(T) },
    { nom: 'POST /posts', verbe: 'POST', chemin: `/tenants/${T}/channels-me/posts`,
      appel: () => publierPostChaine(T, { text: 'coucou' }) },
    { nom: 'POST /activation-request', verbe: 'POST', chemin: `/tenants/${T}/channels-me/activation-request`,
      appel: () => demanderActivationChaine(T) },
    { nom: 'GET /links/conversations', verbe: 'GET', chemin: `/tenants/${T}/channels-me/links/conversations`,
      appel: () => listerConversationsChaine(T) },
  ];

  it.each(CONTRAT)('$nom tape le chemin exact, avec le bon verbe', async ({ appel, verbe, chemin }) => {
    await appel();
    expect(appels).toHaveLength(1);
    expect(appels[0]!.path).toBe(chemin);
    expect(methode(appels[0]!.init)).toBe(verbe);
  });

  it('🔴 il y a DOUZE routes : `enable` repare un bouton mort, `conversations` mesure, DELETE debranche', () => {
    // ⚠️ CE COMPTE EST LE MECANISME, pas une decoration : une route ajoutee cote serveur sans sa ligne ici
    // sort du gel. Le lot du 2026-09-07 a justement ajoute `GET /links/conversations` sans l y inscrire, et
    // rien n a cassé : le contrat gelait alors dix routes sur onze.
    expect(CONTRAT).toHaveLength(12);
    expect(CONTRAT.map((c) => c.nom)).toContain('POST /links/:id/enable');
    expect(CONTRAT.map((c) => c.nom)).toContain('GET /links/conversations');
    expect(CONTRAT.map((c) => c.nom)).toContain('DELETE /connection');
  });

  it('le nom de la chaîne : celle des identifiants, sinon la première listée, sinon rien', () => {
    const base = { organisation: null, distant: 'ok' as const };
    const cx = { orgId: 'o', channelId: 'c2', hasApiKey: true, hasSecret: true, verifiedAt: null };
    const r = (connection: ReponseConnexionChaine['connection'], channels: ReponseConnexionChaine['channels']): ReponseConnexionChaine =>
      ({ ...base, connection, channels });
    expect(nomDeLaChaine(r(cx, [{ id: 'c1', name: 'Première' }, { id: 'c2', name: 'La bonne' }]))).toBe('La bonne');
    expect(nomDeLaChaine(r(cx, [{ id: 'c9', name: 'Seule' }]))).toBe('Seule');
    expect(nomDeLaChaine(r(cx, []))).toBeNull();
    expect(nomDeLaChaine(null)).toBeNull();
  });

  it('tout part sous /tenants/<tenantId>/channels-me : l isolation tenant est dans CHAQUE chemin', () => {
    for (const c of CONTRAT) expect(c.chemin.startsWith(`/tenants/${T}/channels-me`)).toBe(true);
  });

  it('aucun chemin ne dit « channels » ni « channel » tout seul, ni « connexion » en francais', () => {
    for (const c of CONTRAT) {
      // `channel` seul designe deja le tuyau (whatsapp ou rcs) dans ce depot, d ou le prefixe `channels-me`.
      expect(c.chemin.replace('/channels-me', '')).not.toMatch(/channels?/);
      // La faute exacte du lot precedent : le francais d un cote, l anglais de l autre.
      expect(c.chemin).not.toContain('connexion');
    }
  });
});

describe('api-chaine : ce qui part dans le corps', () => {
  it('PUT /connection envoie les QUATRE identifiants : un remplacement complet, pas un patch', async () => {
    await enregistrerConnexionChaine(T, { orgId: 'o1', channelId: 'c1', apiKey: 'k1', secret: 's1' });
    expect(JSON.parse(String(appels[0]!.init!.body))).toEqual({
      orgId: 'o1', channelId: 'c1', apiKey: 'k1', secret: 's1',
    });
  });

  it('POST /links n envoie que ce que le schema du serveur accepte', async () => {
    await creerLienChaine(T, { workflowId: 'w1', startNodeId: 'n1', phrase: 'Je veux la newsletter', maxParHeure: 50 });
    expect(JSON.parse(String(appels[0]!.init!.body))).toEqual({
      workflowId: 'w1', startNodeId: 'n1', phrase: 'Je veux la newsletter', maxParHeure: 50,
    });
  });

  it('POST /posts sans image n envoie PAS de mediaUrl vide : le serveur refuserait la chaine vide en 400', async () => {
    await publierPostChaine(T, { text: 'coucou' });
    expect(JSON.parse(String(appels[0]!.init!.body))).toEqual({ text: 'coucou' });
  });

  it('POST /posts avec image et lien envoie les trois champs', async () => {
    await publierPostChaine(T, { text: 'coucou', mediaUrl: 'https://ex.test/i.jpg', linkId: ID });
    expect(JSON.parse(String(appels[0]!.init!.body))).toEqual({
      text: 'coucou', mediaUrl: 'https://ex.test/i.jpg', linkId: ID,
    });
  });

  it('la demande d activation sans message envoie une chaine vide, jamais undefined', async () => {
    await demanderActivationChaine(T);
    // `JSON.stringify({message: undefined})` rend `{}`, que le serveur accepte, mais le corps devient alors
    // dependant d un detail de serialisation. On envoie la chaine vide, qui est ce que la route attend.
    expect(JSON.parse(String(appels[0]!.init!.body))).toEqual({ message: '' });
  });

  it('les deux lectures et les deux interrupteurs n envoient AUCUN corps', async () => {
    await getConnexionChaine(T);
    await listerLiensChaine(T);
    await eteindreLienChaine(T, ID);
    await allumerLienChaine(T, ID);
    for (const a of appels) expect(a.init?.body).toBeUndefined();
  });
});

describe('api-chaine : ce qui remonte', () => {
  it('🔴 un refus d identifiants (422) REMONTE : il n arrive jamais par un { ok: false }', async () => {
    // Le serveur repond 422 quand Channels Me refuse les identifiants, donc `request` leve. Un appelant qui
    // testerait `if (!res.ok)` ne verrait jamais l echec : il n y a pas de branche `ok: false` a lire.
    jet = new Error('Channels Me a refuse ces identifiants');
    await expect(testerConnexionChaine(T)).rejects.toThrow('Channels Me a refuse ces identifiants');
  });

  it('la reponse traverse telle quelle : ce module ne normalise rien, l ecran lit de facon defensive', async () => {
    reponse = { links: [{ id: ID, enabled: null, waMeUrl: null }], phone: null };
    await expect(listerLiensChaine(T)).resolves.toEqual({
      links: [{ id: ID, enabled: null, waMeUrl: null }], phone: null,
    });
  });

  it('les avertissements d une publication arrivent AVEC un succes, pas avec une erreur', async () => {
    // Un post parti dont l allumage a rate reste un 201 : faire croire a un echec pousserait a republier,
    // c est-a-dire a renvoyer le meme message a toute l audience.
    reponse = { post: { cmMessageId: 'cm-1', linkId: ID }, avertissements: ['automation_non_allumee'] };
    const r = await publierPostChaine(T, { text: 'coucou', linkId: ID });
    expect(r.avertissements).toEqual(['automation_non_allumee']);
    expect(r.post.cmMessageId).toBe('cm-1');
  });
});

describe('api-chaine : les bornes recopiees du serveur', () => {
  /**
   * 🔴 Ces trois valeurs sont recopiees A LA MAIN de `src/http/channels-me.ts` (`web/` a son propre tsconfig
   * et n importe jamais `src/`). Une recopie non testee derive en silence : le plan portait 60 pour la
   * phrase, en affirmant que c etait « la meme valeur que le serveur », alors que `lienSchema.phrase` vaut
   * `.max(300)`. Un front qui refuse a 61 ce que le serveur accepte a 300 refuse en son nom propre tout en
   * pretendant citer le serveur.
   */
  it('MAX_PHRASE vaut 300, la valeur de lienSchema.phrase, et surtout pas 60', () => {
    expect(MAX_PHRASE).toBe(300);
  });

  it('MAX_TEXTE_POST vaut 4096, la valeur de postSchema.text', () => {
    expect(MAX_TEXTE_POST).toBe(4096);
  });

  it('MAX_MEDIA_URL vaut 2000, la valeur de postSchema.mediaUrl', () => {
    expect(MAX_MEDIA_URL).toBe(2000);
  });
});
