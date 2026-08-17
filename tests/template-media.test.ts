import { describe, it, expect } from 'vitest';
import { TemplateMediaPreparer } from '../src/meta/template-media';
import type { TemplateMediaDeps } from '../src/meta/template-media';

/**
 * Ce module est le point d'entrée PARTAGÉ des visuels d'un template (cartes de carousel et en-tête média), et
 * il n'avait aucun test direct. Or c'est précisément une duplication de cette logique qui a laissé le carousel
 * non branché côté campagne (2026-08-15), puis l'en-tête média non branché côté campagne scénario (2026-08-17).
 */

interface Journal {
  numeros: number;
  telecharges: string[];
  televerses: Array<{ pn: string; mime: string }>;
}

function preparer(over: Partial<TemplateMediaDeps> & { pn?: string | null } = {}) {
  const j: Journal = { numeros: 0, telecharges: [], televerses: [] };
  let horloge = 1_000_000;
  const deps: TemplateMediaDeps = {
    getPhoneNumberId: async () => { j.numeros += 1; return over.pn === undefined ? 'PN-1' : over.pn; },
    mediaClientFor: async () => ({
      uploadForSend: async (pn: string, _bytes: Buffer, mime: string) => {
        j.televerses.push({ pn, mime });
        return `MID-${j.televerses.length}`;
      },
    }),
    fetchImpl: async (url: string) => {
      j.telecharges.push(url);
      return { ok: true, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    },
    now: () => horloge,
    ...over,
  };
  return { p: new TemplateMediaPreparer(deps), j, avance: (ms: number) => { horloge += ms; } };
}

describe('TemplateMediaPreparer.prepareOne', () => {
  it('télécharge le visuel et rend le media id du téléversement, avec le bon type MIME', async () => {
    const { p, j } = preparer();
    expect(await p.prepareOne('t1', 'https://cdn.meta/a.jpg?sig=1')).toBe('MID-1');
    expect(j.telecharges).toEqual(['https://cdn.meta/a.jpg?sig=1']);
    expect(j.televerses).toEqual([{ pn: 'PN-1', mime: 'image/png' }]);
  });

  it('cache par CHEMIN : la signature de l’URL change à chaque lecture du template, pas le visuel', async () => {
    const { p, j } = preparer();
    await p.prepareOne('t1', 'https://cdn.meta/a.jpg?sig=1');
    expect(await p.prepareOne('t1', 'https://cdn.meta/a.jpg?sig=CHANGEE')).toBe('MID-1');
    expect(j.televerses).toHaveLength(1); // une campagne de 5 000 destinataires ne téléverse pas 5 000 fois
  });

  it('🔴 cache scopé au NUMÉRO : un media id est inutilisable sur un autre numéro d’envoi', async () => {
    // Sans le numéro dans la clé, un numéro reconnecté dans les 7 jours réutiliserait l'identifiant de
    // l'ancien, et l'envoi échouerait sans que rien n'explique pourquoi.
    let pn = 'PN-1';
    const { p, j } = preparer({ getPhoneNumberId: async () => pn });
    expect(await p.prepareOne('t1', 'https://cdn.meta/a.jpg')).toBe('MID-1');
    pn = 'PN-2';
    expect(await p.prepareOne('t1', 'https://cdn.meta/a.jpg')).toBe('MID-2');
    expect(j.televerses).toEqual([{ pn: 'PN-1', mime: 'image/png' }, { pn: 'PN-2', mime: 'image/png' }]);
  });

  it('cache expiré (au-delà de 7 jours) -> re-téléversement', async () => {
    const { p, j, avance } = preparer();
    await p.prepareOne('t1', 'https://cdn.meta/a.jpg');
    avance(7 * 86_400_000 + 1);
    await p.prepareOne('t1', 'https://cdn.meta/a.jpg');
    expect(j.televerses).toHaveLength(2);
  });

  it('aucun numéro d’envoi -> null, sans rien télécharger', async () => {
    const { p, j } = preparer({ pn: null });
    expect(await p.prepareOne('t1', 'https://cdn.meta/a.jpg')).toBeNull();
    expect(j.telecharges).toHaveLength(0);
  });

  it('téléchargement refusé, ou téléversement en erreur -> null, JAMAIS d’exception', async () => {
    // L'appelant refuse l'envoi en nommant ce qui manque ; une exception ici ferait tomber tout le run.
    const refuse = preparer({ fetchImpl: async () => ({ ok: false, status: 403 } as Response) });
    expect(await refuse.p.prepareOne('t1', 'https://cdn.meta/a.jpg')).toBeNull();

    const casse = preparer({ mediaClientFor: async () => ({ uploadForSend: async () => { throw new Error('boom'); } }) });
    expect(await casse.p.prepareOne('t1', 'https://cdn.meta/a.jpg')).toBeNull();
  });

  it('URL vide -> null immédiat (handle non exploitable relu chez Meta)', async () => {
    const { p, j } = preparer();
    expect(await p.prepareOne('t1', '')).toBeNull();
    expect(j.numeros).toBe(0);
  });
});

describe('TemplateMediaPreparer.prepare (cartes de carousel)', () => {
  it('rend chaque carte avec son media id, et ne résout le numéro QU’UNE fois pour tout le lot', async () => {
    const { p, j } = preparer();
    const cartes = await p.prepare('t1', [{ mediaUrl: 'https://cdn.meta/a.jpg' }, { mediaUrl: 'https://cdn.meta/b.jpg' }]);
    expect(cartes.map((c) => c.mediaId)).toEqual(['MID-1', 'MID-2']);
    expect(j.numeros).toBe(1);
  });

  it('carte sans URL -> rendue SANS media id (c’est carouselSendBlocker qui refusera en la nommant)', async () => {
    const { p } = preparer();
    const cartes = await p.prepare('t1', [{ body: 'sans visuel' }]);
    expect(cartes[0]!.mediaId).toBeUndefined();
  });

  it('aucun numéro d’envoi -> cartes rendues telles quelles, sans exception', async () => {
    const { p, j } = preparer({ pn: null });
    const cartes = await p.prepare('t1', [{ mediaUrl: 'https://cdn.meta/a.jpg' }]);
    expect(cartes[0]!.mediaId).toBeUndefined();
    expect(j.telecharges).toHaveLength(0);
  });

  it('un visuel partagé par une carte ET l’en-tête ne se téléverse qu’une fois (cache commun)', async () => {
    const { p, j } = preparer();
    await p.prepare('t1', [{ mediaUrl: 'https://cdn.meta/commun.jpg' }]);
    expect(await p.prepareOne('t1', 'https://cdn.meta/commun.jpg')).toBe('MID-1');
    expect(j.televerses).toHaveLength(1);
  });
});
