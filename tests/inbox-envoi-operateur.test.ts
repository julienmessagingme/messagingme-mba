import { describe, it, expect, afterEach, vi } from 'vitest';
import { envoyerModeleDansLeFil, envoyerRcsDansLeFil, type DepsEnvoiModeleDansLeFil, type DepsEnvoiRcsDansLeFil } from '../src/inbox/envoi-operateur';
import { RetraitDeLaListeRefuse } from '../src/mba/liste';

/**
 * Ce qu'un opérateur envoie dans un fil hors de la réponse texte (`src/inbox/envoi-operateur.ts`), testé sans Fastify
 * (lot C de l'audit de structure, 2026-10-26). Les routes, elles, sont tenues par `tests/http-inbox.test.ts` et
 * `tests/http-inbox-rcs.test.ts`. Chaque cas lit ce qui PART (envoi, prise du fil, inscription), pas seulement l'issue.
 */
afterEach(() => vi.restoreAllMocks());

const FIL = { conversationId: 'c1', waId: '33611' };

function modele(o: { numero?: string | null; desabonne?: boolean; categorie?: 'marketing' | 'utility' | null | 'leve'; carousel?: 'refus' | 'cartes'; envoiLeve?: unknown } = {}) {
  const gestes: string[] = [];
  const deps: DepsEnvoiModeleDansLeFil = {
    repo: { getTenantPhoneNumberId: async () => (o.numero === undefined ? 'pn1' : o.numero) },
    estDesabonne: async () => { gestes.push('desabonne?'); return o.desabonne ?? false; },
    categorieDuModele: async () => {
      gestes.push('categorie?');
      if (o.categorie === 'leve') throw new Error('Meta injoignable');
      return o.categorie ?? 'marketing';
    },
    prepareCarousel: async () => (o.carousel === 'refus' ? { refus: 'carte sans visuel' } : o.carousel === 'cartes' ? { cards: [] } : null),
    sendTemplateMessage: async (_t, _pn, to, tpl) => {
      gestes.push(`envoi:${to}:${tpl.name}${tpl.carousel ? ':carousel' : ''}`);
      if (o.envoiLeve) throw o.envoiLeve;
      return 'wamid.TPL';
    },
    takeControl: async (_t, waId, par) => { gestes.push(`prise:${waId}:${JSON.stringify(par)}`); },
    inbox: { recordOutbound: async (conv, corps, id, origine, type, cat, nom, auteur) => { gestes.push(`inscrit:${conv}:${corps}:${id}:${origine}:${type}:${cat}:${nom}:${auteur}`); } },
  };
  return { deps, gestes };
}

const promo = { name: 'promo', language: 'fr', bodyParams: [] };

describe('envoyerModeleDansLeFil', () => {
  it('un contact abonné : la catégorie n’est PAS lue, le modèle part, le fil est pris, puis le message inscrit', async () => {
    const { deps, gestes } = modele();
    expect(await envoyerModeleDansLeFil(deps, 't1', FIL, { ...promo, templateCategory: 'marketing' }, 'u1'))
      .toEqual({ ok: true, messageId: 'wamid.TPL', journal: 'recorded' });
    expect(gestes).toEqual([
      'desabonne?', 'envoi:33611:promo', 'prise:33611:{"collaborateur":"u1"}', 'inscrit:c1:[template] promo:wamid.TPL:humain:template:marketing:promo:u1',
    ]);
  });

  it('🔴 un désabonné et un modèle marketing : 409 `contact_desabonne`, RIEN ne part ni ne s’inscrit', async () => {
    const { deps, gestes } = modele({ desabonne: true, categorie: 'marketing' });
    expect(await envoyerModeleDansLeFil(deps, 't1', FIL, promo, 'u1')).toEqual({
      ok: false, statut: 409, code: 'contact_desabonne',
      error: 'ce contact s’est désabonné : seuls les modèles de catégorie « Service » peuvent encore lui être envoyés. Vous pouvez lui répondre à la main si la conversation est ouverte.',
    });
    expect(gestes).toEqual(['desabonne?', 'categorie?']);
  });

  it('🔴 un désabonné et un modèle « Service » : il part (un opérateur peut encore servir)', async () => {
    const { deps, gestes } = modele({ desabonne: true, categorie: 'utility' });
    expect((await envoyerModeleDansLeFil(deps, 't1', FIL, promo, 'u1')).ok).toBe(true);
    expect(gestes).toContain('envoi:33611:promo');
  });

  it('🔴 une catégorie illisible chez Meta : 409 « n’a pas pu être vérifiée » (échouer fermé), jamais un 500', async () => {
    const { deps, gestes } = modele({ desabonne: true, categorie: 'leve' });
    const r = await envoyerModeleDansLeFil(deps, 't1', FIL, promo, 'u1');
    expect(r).toMatchObject({ ok: false, statut: 409, code: 'contact_desabonne' });
    expect(!r.ok && r.error).toMatch(/n’a pas pu être vérifiée/);
    expect(gestes.some((g) => g.startsWith('envoi'))).toBe(false);
  });

  it('sans numéro : 400, avant même de lire le désabonnement', async () => {
    const { deps, gestes } = modele({ numero: null, desabonne: true });
    expect(await envoyerModeleDansLeFil(deps, 't1', FIL, promo, 'u1')).toEqual({ ok: false, statut: 400, error: 'aucun numéro pour ce tenant' });
    expect(gestes).toEqual([]);
  });

  it('un carousel refusé : 422 avant l’envoi ; préparé, ses cartes partent avec le modèle', async () => {
    const refuse = modele({ carousel: 'refus' });
    expect(await envoyerModeleDansLeFil(refuse.deps, 't1', FIL, promo, 'u1')).toEqual({ ok: false, statut: 422, error: 'carte sans visuel' });
    expect(refuse.gestes.some((g) => g.startsWith('envoi'))).toBe(false);
    const cartes = modele({ carousel: 'cartes' });
    await envoyerModeleDansLeFil(cartes.deps, 't1', FIL, promo, 'u1');
    expect(cartes.gestes).toContain('envoi:33611:promo:carousel');
  });

  it('🔴 un envoi refusé (retrait de la liste de l’agent de Meta) remonte tel quel : ni prise du fil, ni inscription', async () => {
    const { deps, gestes } = modele({ envoiLeve: new RetraitDeLaListeRefuse() });
    await expect(envoyerModeleDansLeFil(deps, 't1', FIL, promo, 'u1')).rejects.toBeInstanceOf(RetraitDeLaListeRefuse);
    expect(gestes.some((g) => g.startsWith('prise') || g.startsWith('inscrit'))).toBe(false);
  });

  it('🔴 envoi accepté, prise du fil en panne et inscription en panne deux fois : succès `unrecorded`, un SEUL envoi', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, gestes } = modele();
    deps.takeControl = async () => { throw new Error('base'); };
    let essais = 0;
    deps.inbox.recordOutbound = async () => { essais += 1; throw new Error('base'); };
    expect(await envoyerModeleDansLeFil(deps, 't1', FIL, promo, 'u1')).toEqual({ ok: true, messageId: 'wamid.TPL', journal: 'unrecorded' });
    expect(gestes.filter((g) => g.startsWith('envoi'))).toHaveLength(1);
    expect(essais).toBe(2);
  });
});

describe('envoyerRcsDansLeFil', () => {
  function rcs(refus?: string) {
    const gestes: string[] = [];
    const deps: DepsEnvoiRcsDansLeFil = {
      sendRcsFromInbox: async (_t, waId) => { gestes.push(`envoi:${waId}`); return refus ? { refus } : { messageId: 'rcs.1', apercu: 'Bonjour' }; },
      takeControl: async (_t, waId) => { gestes.push(`prise:${waId}`); },
      inbox: { recordOutbound: async (conv, corps, id, origine, type, _cat, _nom, auteur, canal) => { gestes.push(`inscrit:${conv}:${corps}:${id}:${origine}:${type}:${auteur}:${canal}`); } },
    };
    return { deps, gestes };
  }

  it('parti : le fil est pris, puis le RCS inscrit sur son canal', async () => {
    const { deps, gestes } = rcs();
    expect(await envoyerRcsDansLeFil(deps, 't1', FIL, { text: 'Bonjour' }, 'u1')).toEqual({ ok: true, messageId: 'rcs.1', journal: 'recorded' });
    expect(gestes).toEqual(['envoi:33611', 'prise:33611', 'inscrit:c1:Bonjour:rcs.1:humain:rcs:u1:rcs']);
  });

  it('un refus (canal éteint, contact désabonné du RCS) : 422 avec sa raison, rien de pris ni d’inscrit', async () => {
    const { deps, gestes } = rcs('canal RCS éteint');
    expect(await envoyerRcsDansLeFil(deps, 't1', FIL, { text: 'Bonjour' }, 'u1')).toEqual({ ok: false, statut: 422, error: 'canal RCS éteint' });
    expect(gestes).toEqual(['envoi:33611']);
  });
});
