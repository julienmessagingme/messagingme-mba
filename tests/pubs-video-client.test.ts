import { describe, it, expect, afterEach } from 'vitest';
import { MetaPubsCreationClient } from '../src/meta/pubs-creation';
import { ErreurGraph } from '../src/meta/graph';

/**
 * LE CLIENT META DE LA VIDÉO ET DES AUDIENCES (`src/meta/pubs-creation.ts`), contre un faux `fetch`.
 *
 * `fetch` est remplacé ici, jamais appelé pour de vrai : un test qui touche le réseau n'est pas un test unitaire.
 * Ce qui est asserté est CE QUI PART chez Meta (adresse, en-têtes, corps) et ce qu'on tire de sa réponse, parce que
 * c'est là que se trompent les appels qu'aucun compilateur ne voit : un décalage mal lu envoie le mauvais morceau du
 * fichier, un jeton posé sur le mauvais hôte fuit.
 */

const vrai = globalThis.fetch;
afterEach(() => { globalThis.fetch = vrai; });

interface Appel { url: string; init?: RequestInit }

/** Remplace `fetch` par une table de réponses, et retient ce qui a été demandé. */
function graph(reponses: Array<{ ok?: boolean; status?: number; body: unknown }>): { appels: Appel[] } {
  const appels: Appel[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    appels.push({ url: String(url), init });
    const r = reponses[Math.min(i++, reponses.length - 1)] ?? { body: {} };
    return { ok: r.ok !== false, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { appels };
}

const client = (telecharger?: typeof fetch) =>
  new MetaPubsCreationClient('app-1', 'secret-1', 'v25.0', undefined, telecharger);

const entete = (a: Appel | undefined, nom: string): string | undefined =>
  (a?.init?.headers as Record<string, string> | undefined)?.[nom];

describe('le dépôt d’une vidéo : ouvrir', () => {
  it('🔴 `upload_phase=start` avec la taille, sur le compte (préfixe act_ remis), jeton en en-tête', async () => {
    const { appels } = graph([{ body: { upload_session_id: '777', video_id: '888', start_offset: '0', end_offset: '1048576' } }]);
    const depot = await client().demarrerDepotVideo('111', 'JETON', 5_000_000);
    expect(appels[0]?.url).toBe('https://graph.facebook.com/v25.0/act_111/advideos');
    expect(appels[0]?.init?.method).toBe('POST');
    expect(String(appels[0]?.init?.body)).toBe('upload_phase=start&file_size=5000000');
    expect(entete(appels[0], 'Authorization')).toBe('Bearer JETON');
    // Le jeton ne voyage JAMAIS dans l'adresse, qui est journalisée.
    expect(appels[0]?.url).not.toContain('JETON');
    // 🔴 Les décalages arrivent en CHAÎNE et sortent en NOMBRE : « 0 » + 1 donnerait « 01 ».
    expect(depot).toEqual({ videoId: '888', sessionId: '777', debut: 0, fin: 1_048_576 });
  });

  it('⚠️ une réponse sans session ne devient pas un dépôt : on ne devine pas un identifiant', async () => {
    graph([{ body: { video_id: '888', start_offset: '0', end_offset: '10' } }]);
    await expect(client().demarrerDepotVideo('111', 'J', 10)).rejects.toThrow(/session de dépôt/);
  });

  it('⚠️ un décalage qui n’est pas un entier positif est refusé', async () => {
    graph([{ body: { upload_session_id: '7', video_id: '8', start_offset: '-1', end_offset: 'dix' } }]);
    await expect(client().demarrerDepotVideo('111', 'J', 10)).rejects.toThrow();
  });
});

/** Lit un corps de requête en flux, pièce par pièce, en notant ce que la source avait produit à chaque lecture. */
async function lireCorps(corps: unknown, produits: () => number): Promise<{ octets: Uint8Array; avances: number[] }> {
  const lecteur = (corps as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  const avances: number[] = [];
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    parts.push(value);
    avances.push(produits());
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const octets = new Uint8Array(total);
  let i = 0;
  for (const p of parts) { octets.set(p, i); i += p.byteLength; }
  return { octets, avances };
}

describe('le dépôt d’une vidéo : relayer un morceau EN FLUX', () => {
  it('🔴 le corps est un flux multipart, lu AU FIL de la source : jamais le morceau entier en mémoire', async () => {
    // La source produit 50 pièces de 1 Ko, paresseusement. Si le client tamponnait le morceau avant d'appeler
    // Meta, la source aurait tout produit (50) avant la première lecture du corps ; en flux, chaque lecture du
    // corps n'a fait avancer la source que d'une pièce de plus.
    let produits = 0;
    const source = (async function* () {
      for (let k = 0; k < 50; k += 1) { produits += 1; yield new Uint8Array(1024).fill(k); }
    })();
    let recu: { octets: Uint8Array; avances: number[] } | null = null;
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, i?: RequestInit) => {
      init = i;
      recu = await lireCorps(i?.body, () => produits);
      return { ok: true, status: 200, json: async () => ({ start_offset: '51200', end_offset: '102400' }) };
    }) as unknown as typeof fetch;

    const suivant = await client().transfererMorceauVideo('111', 'JETON', {
      sessionId: '777', debut: 0, taille: 50 * 1024, octets: source,
    });
    expect(suivant).toEqual({ debut: 51_200, fin: 102_400 });
    const r = recu as unknown as { octets: Uint8Array; avances: number[] };
    // Première lecture : l'en-tête multipart, quand la source n'a presque rien produit. Un client qui tamponnerait
    // le morceau aurait tout lu (50) avant d'appeler Meta.
    expect(r.avances[0]).toBeLessThanOrEqual(2);
    // Et à chaque lecture, la source n'a jamais plus de deux pièces d'avance sur ce que Meta a reçu (la file
    // interne du flux en garde une, l'appel en cours une autre).
    r.avances.forEach((a, k) => expect(a, `lecture ${k}`).toBeLessThanOrEqual(k + 2));
    expect(r.avances.length).toBeGreaterThanOrEqual(52);
    // 🔴 La longueur annoncée est EXACTE : c'est elle qui fait refuser par `fetch` un corps qui n'y correspond pas.
    expect(Number(entete({ url: '', init }, 'Content-Length'))).toBe(r.octets.byteLength);
    expect((init as RequestInit & { duplex?: string }).duplex).toBe('half');
  });

  it('les trois champs de la phase et les octets du morceau, intacts', async () => {
    let texte = '';
    let brut: Uint8Array = new Uint8Array(0);
    let type = '';
    globalThis.fetch = (async (_url: string, i?: RequestInit) => {
      brut = (await lireCorps(i?.body, () => 0)).octets;
      texte = new TextDecoder('latin1').decode(brut);
      type = entete({ url: '', init: i }, 'Content-Type') ?? '';
      return { ok: true, status: 200, json: async () => ({ start_offset: 8, end_offset: 8 }) };
    }) as unknown as typeof fetch;
    const morceau = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const suivant = await client().transfererMorceauVideo('111', 'J', {
      sessionId: '777', debut: 0, taille: 8, octets: (async function* () { yield morceau; })(),
    });
    // Des décalages égaux veulent dire « tout est reçu » : c'est ce que l'écran lit pour clore.
    expect(suivant).toEqual({ debut: 8, fin: 8 });
    const frontiere = /boundary=(.+)$/.exec(type)?.[1] ?? '';
    expect(frontiere).not.toBe('');
    expect(texte).toContain('name="upload_phase"\r\n\r\ntransfer\r\n');
    expect(texte).toContain('name="upload_session_id"\r\n\r\n777\r\n');
    expect(texte).toContain('name="start_offset"\r\n\r\n0\r\n');
    expect(texte).toContain('name="video_file_chunk"; filename="morceau"');
    expect(texte.endsWith(`\r\n--${frontiere}--\r\n`)).toBe(true);
    // Les octets du morceau, à leur place, sans réencodage.
    const debutOctets = texte.indexOf('application/octet-stream\r\n\r\n') + 'application/octet-stream\r\n\r\n'.length;
    expect([...brut.slice(debutOctets, debutOctets + 8)]).toEqual([...morceau]);
  });

  it('⚠️ un refus de Meta remonte avec son code (352 : format)', async () => {
    globalThis.fetch = (async (_u: string, i?: RequestInit) => {
      await lireCorps(i?.body, () => 0);
      return { ok: false, status: 400, json: async () => ({ error: { message: 'format non pris en charge', code: 352 } }) };
    }) as unknown as typeof fetch;
    const err = await client().transfererMorceauVideo('111', 'J', {
      sessionId: '7', debut: 0, taille: 1, octets: (async function* () { yield new Uint8Array(1); })(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErreurGraph);
    expect((err as ErreurGraph).code).toBe(352);
  });
});

describe('le dépôt d’une vidéo : clore', () => {
  it('`upload_phase=finish` avec la session', async () => {
    const { appels } = graph([{ body: { success: true } }]);
    await client().terminerDepotVideo('111', 'J', '777');
    expect(appels[0]?.url).toBe('https://graph.facebook.com/v25.0/act_111/advideos');
    expect(String(appels[0]?.init?.body)).toBe('upload_phase=finish&upload_session_id=777');
  });

  it('🔴 un `success` absent ou faux n’est PAS une fin de dépôt', async () => {
    graph([{ body: { success: false } }]);
    await expect(client().terminerDepotVideo('111', 'J', '777')).rejects.toThrow(/fin du dépôt/);
    graph([{ body: {} }]);
    await expect(client().terminerDepotVideo('111', 'J', '777')).rejects.toThrow(/fin du dépôt/);
  });
});

describe('l’état d’une vidéo', () => {
  it('`ready` seul vaut « prête »', async () => {
    const { appels } = graph([{ body: { status: { video_status: 'ready', processing_progress: 100 } } }]);
    await expect(client().etatVideo('888', 'J')).resolves.toEqual({ etat: 'prete', progression: 100 });
    expect(appels[0]?.url).toBe('https://graph.facebook.com/v25.0/888?fields=status');
  });

  it('en traitement, avec sa progression', async () => {
    graph([{ body: { status: { video_status: 'processing', processing_progress: 42 } } }]);
    await expect(client().etatVideo('888', 'J')).resolves.toEqual({ etat: 'traitement', progression: 42 });
  });

  it('en erreur, ou expirée', async () => {
    for (const s of ['error', 'expired']) {
      graph([{ body: { status: { video_status: s } } }]);
      expect((await client().etatVideo('888', 'J')).etat).toBe('erreur');
    }
  });

  it('🔴 un état ABSENT ou inconnu ne vaut jamais « prête » : la créa ne partira pas sur une vidéo incertaine', async () => {
    for (const body of [{}, { status: {} }, { status: { video_status: 'upload_complete' } }, { status: 'ready' }]) {
      graph([{ body }]);
      expect((await client().etatVideo('888', 'J')).etat, JSON.stringify(body)).toBe('traitement');
    }
  });
});

/** Un PNG minuscule, vrai : la vignette est vérifiée sur sa signature. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Un faux téléchargeur de CDN, qui retient ce qu'on lui a demandé. */
function cdn(corps: Buffer, status = 200): { telecharger: typeof fetch; demandes: Appel[] } {
  const demandes: Appel[] = [];
  const telecharger = (async (url: string, init?: RequestInit) => {
    demandes.push({ url: String(url), init });
    return new Response(new Uint8Array(corps), { status });
  }) as unknown as typeof fetch;
  return { telecharger, demandes };
}

describe('la vignette d’une vidéo : rapatriée, puis REDÉPOSÉE', () => {
  const VIGNETTES = {
    data: [
      { uri: 'https://scontent.xx.fbcdn.net/v/autre.jpg', is_preferred: false },
      { uri: 'https://scontent.xx.fbcdn.net/v/preferee.png', is_preferred: true },
    ],
  };

  it('🔴 la vignette PRÉFÉRÉE, téléchargée SANS le jeton, redéposée par adimages : on rend son empreinte', async () => {
    const { appels } = graph([{ body: VIGNETTES }, { body: { images: { fichier: { hash: 'h-vignette' } } } }]);
    const { telecharger, demandes } = cdn(PNG);
    const hash = await client(telecharger).vignetteVideo('111', 'JETON', '888');
    expect(hash).toBe('h-vignette');
    expect(appels[0]?.url).toBe('https://graph.facebook.com/v25.0/888/thumbnails?fields=uri,is_preferred');
    expect(demandes.map((d) => d.url)).toEqual(['https://scontent.xx.fbcdn.net/v/preferee.png']);
    // Le jeton du client n'a rien à faire chez un CDN.
    expect(JSON.stringify(demandes[0]?.init?.headers ?? {})).not.toContain('JETON');
    // Et ce qui part à adimages, ce sont les OCTETS, jamais l'adresse du CDN.
    expect(appels[1]?.url).toBe('https://graph.facebook.com/v25.0/act_111/adimages');
    const corps = String(appels[1]?.init?.body);
    expect(corps).toBe(new URLSearchParams({ bytes: PNG.toString('base64') }).toString());
    expect(corps).not.toContain('fbcdn');
  });

  it('sans vignette préférée, la première', async () => {
    graph([{ body: { data: [{ uri: 'https://cdn.exemple/a.png' }] } }, { body: { images: { f: { hash: 'h' } } } }]);
    const { telecharger, demandes } = cdn(PNG);
    await client(telecharger).vignetteVideo('111', 'J', '888');
    expect(demandes[0]?.url).toBe('https://cdn.exemple/a.png');
  });

  it('aucune vignette : levée, lisible', async () => {
    graph([{ body: { data: [] } }]);
    await expect(client(cdn(PNG).telecharger).vignetteVideo('111', 'J', '888')).rejects.toThrow(/aucune vignette/);
  });

  it('🔴 une adresse qui n’est pas en HTTPS n’est pas suivie', async () => {
    graph([{ body: { data: [{ uri: 'http://cdn.exemple/a.png', is_preferred: true }] } }]);
    const { telecharger, demandes } = cdn(PNG);
    await expect(client(telecharger).vignetteVideo('111', 'J', '888')).rejects.toThrow(/HTTPS/);
    expect(demandes).toEqual([]);
  });

  it('🔴 des octets qui ne sont pas une image JPEG ou PNG ne sont pas redéposés', async () => {
    const { appels } = graph([{ body: VIGNETTES }, { body: { images: { f: { hash: 'h' } } } }]);
    await expect(client(cdn(Buffer.from('<svg></svg>')).telecharger).vignetteVideo('111', 'J', '888'))
      .rejects.toThrow(/JPEG ou PNG/);
    expect(appels.some((a) => a.url.includes('adimages'))).toBe(false);
  });

  it('⚠️ une vignette trop lourde est refusée, pas tronquée', async () => {
    graph([{ body: VIGNETTES }]);
    const lourd = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
    await expect(client(cdn(lourd).telecharger).vignetteVideo('111', 'J', '888')).rejects.toThrow(/trop lourde/);
  });
});

describe('les audiences du compte publicitaire', () => {
  const LISTE = {
    data: [
      { id: '1', name: 'Clients 2025', subtype: 'CUSTOM', approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1200,
        delivery_status: { code: 200, description: 'This audience is ready for use.' }, operation_status: { code: 200 } },
      { id: '2', name: 'Trop petite', subtype: 'CUSTOM', approximate_count_lower_bound: -1, approximate_count_upper_bound: -1,
        delivery_status: { code: 300, description: 'Audience is too small' } },
      { id: '3', name: 'En calcul', subtype: 'LOOKALIKE', operation_status: { code: 400, description: 'Populating' } },
      { id: 42, name: 'mal formée' },
    ],
    paging: { next: 'https://graph.facebook.com/…&after=x' },
  };

  it('🔴 lit le compte, avec la taille et l’état, et ne dit « utilisable » que sur `delivery_status` 200', async () => {
    const { appels } = graph([{ body: LISTE }]);
    const r = await client().audiences('act_111', 'J');
    expect(appels[0]?.url).toContain('https://graph.facebook.com/v25.0/act_111/customaudiences?');
    expect(appels[0]?.url).toContain('delivery_status');
    expect(r.audiences.map((a) => [a.id, a.utilisable])).toEqual([['1', true], ['2', false], ['3', false]]);
    expect(r.audiences.filter((a) => a.utilisable).map((a) => a.id)).toEqual(['1']);
  });

  it('dit POURQUOI une audience ne l’est pas, dans les mots de Meta', async () => {
    graph([{ body: LISTE }]);
    const r = await client().audiences('111', 'J');
    expect(r.audiences.find((a) => a.id === '2')?.raison).toBe('Audience is too small');
    expect(r.audiences.find((a) => a.id === '3')?.raison).toBe('Populating');
    expect(r.audiences.find((a) => a.id === '1')?.raison).toBeNull();
  });

  it('⚠️ une taille de -1 n’est pas une taille : `null`', async () => {
    graph([{ body: LISTE }]);
    const r = await client().audiences('111', 'J');
    expect(r.audiences.find((a) => a.id === '1')).toMatchObject({ tailleMin: 1000, tailleMax: 1200 });
    expect(r.audiences.find((a) => a.id === '2')).toMatchObject({ tailleMin: null, tailleMax: null });
  });

  it('⚠️ une ligne mal formée est écartée SEULE, et une page de plus se dit', async () => {
    graph([{ body: LISTE }]);
    const r = await client().audiences('111', 'J');
    expect(r.audiences).toHaveLength(3);
    expect(r.tronquee).toBe(true);
  });

  it('l’état des SEULES audiences demandées, en un appel groupé', async () => {
    const { appels } = graph([{ body: { 1: LISTE.data[0], 2: LISTE.data[1] } }]);
    const etats = await client().etatAudiences(['1', '2'], 'J');
    expect(decodeURIComponent(appels[0]?.url ?? '')).toContain('/v25.0/?ids=1,2&fields=');
    expect(etats.get('1')?.utilisable).toBe(true);
    expect(etats.get('2')?.utilisable).toBe(false);
    expect(etats.has('9')).toBe(false);
  });

  it('aucune audience demandée : aucun appel', async () => {
    const { appels } = graph([{ body: {} }]);
    expect((await client().etatAudiences([], 'J')).size).toBe(0);
    expect(appels).toEqual([]);
  });
});
