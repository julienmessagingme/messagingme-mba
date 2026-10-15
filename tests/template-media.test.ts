import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
  /** Les téléchargements GARDÉS (`telecharger`, https et adresse publique), « FORMAT adresse ». */
  gardes: string[];
  televerses: Array<{ pn: string; mime: string }>;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function preparer(over: Partial<TemplateMediaDeps> & { pn?: string | null } = {}) {
  const j: Journal = { numeros: 0, telecharges: [], gardes: [], televerses: [] };
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
    // Par défaut, aucune fiche dans la médiathèque de l'espace : le téléchargement gardé s'applique.
    lireFichier: async () => null,
    telecharger: async (format, url) => { j.gardes.push(`${format} ${url}`); return { octets: PNG, mime: 'image/png' }; },
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

describe('TemplateMediaPreparer.prepareFichier (le fichier du bloc « message rapide », spec médias § 3.2)', () => {
  const CODE = 'abcdefghjkmnpqrstvwxyz0123';
  const fiche = (mime: string, nom: string | null) => async (tenant: string, code: string) =>
    tenant === 't1' && code === CODE ? { bytes: Buffer.from('octets'), mime, nom } : null;

  it('🔴 une adresse /m/ de l’espace se lit DIRECTEMENT dans sa médiathèque, sans aucun appel HTTP', async () => {
    const { p, j } = preparer({ lireFichier: fiche('video/mp4', 'demo.mp4') });
    expect(await p.prepareFichier('t1', `https://api.messagingme.app/m/${CODE}.mp4`)).toEqual({ mediaId: 'MID-1', type: 'video', nom: 'demo.mp4' });
    expect(j.telecharges).toEqual([]);
    expect(j.televerses).toEqual([{ pn: 'PN-1', mime: 'video/mp4' }]);
  });

  it('un PDF devient un document, et garde son nom', async () => {
    const { p } = preparer({ lireFichier: fiche('application/pdf', 'devis.pdf') });
    expect(await p.prepareFichier('t1', `https://api.messagingme.app/m/${CODE}.pdf`)).toMatchObject({ type: 'document', nom: 'devis.pdf' });
  });

  it('🔴 point de revue 3 : une adresse /m/ sur un ANCIEN nom d’hôte se reconnaît à son chemin', async () => {
    const { p, j } = preparer({ lireFichier: fiche('application/pdf', 'devis.pdf') });
    expect(await p.prepareFichier('t1', `https://mba.messagingme.app/m/${CODE}.pdf`)).toMatchObject({ type: 'document' });
    expect(j.telecharges).toEqual([]);
  });

  it('🔴 le code d’un AUTRE espace n’est pas lu dans sa médiathèque : le téléchargement gardé s’applique, et une vidéo y échoue', async () => {
    const lus: string[] = [];
    const { p, j } = preparer({
      lireFichier: async (tenant, code) => { lus.push(`${tenant}/${code}`); return null; },
      telecharger: async (format, url) => { j.gardes.push(`${format} ${url}`); return { refus: 'le serveur du fichier a répondu HTTP 404' }; },
    });
    expect(await p.prepareFichier('t2', `https://api.messagingme.app/m/${CODE}.mp4`)).toBeNull();
    expect(lus).toEqual([`t2/${CODE}`]);
    expect(j.gardes).toEqual([`VIDEO https://api.messagingme.app/m/${CODE}.mp4`]);
    expect(j.televerses).toEqual([]);
  });

  it('🔴 une adresse saisie par le client passe par le téléchargement GARDÉ, jamais par un fetch nu (relecture du lot C, n° 1)', async () => {
    const { p, j } = preparer();
    expect(await p.prepareFichier('t1', 'https://exemple.fr/visuel.png')).toEqual({ mediaId: 'MID-1', type: 'image', nom: null });
    expect(j.gardes).toEqual(['IMAGE https://exemple.fr/visuel.png']);
    expect(j.telecharges).toEqual([]);
  });

  it('🔴 une vidéo externe passe aussi la lecture de son encodage : un HEVC n’est pas téléversé (n° 2)', async () => {
    const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    const boite = (t: string, ...c: Buffer[]) => { const x = Buffer.concat(c); return Buffer.concat([u32(8 + x.length), Buffer.from(t, 'ascii'), x]); };
    const pleine = (t: string, ...c: Buffer[]) => boite(t, Buffer.alloc(4), ...c);
    const hevc = Buffer.concat([boite('ftyp', Buffer.from('isom', 'ascii'), u32(1)), boite('moov', boite('trak', boite('mdia',
      pleine('hdlr', Buffer.alloc(4), Buffer.from('vide', 'ascii'), Buffer.alloc(12)),
      boite('minf', boite('stbl', pleine('stsd', u32(1), boite('hvc1', Buffer.alloc(78))))))))]);
    const { p, j } = preparer({ telecharger: async () => ({ octets: hevc, mime: 'video/mp4' }) });
    expect(await p.prepareFichier('t1', 'https://exemple.fr/demo.mp4')).toBeNull();
    expect(j.televerses).toEqual([]);
  });

  it('🔴 le cache porte l’ESPACE : un même numéro rattaché à un autre espace ne réutilise pas son identifiant (n° 6)', async () => {
    const { p, j } = preparer({ lireFichier: fiche('application/pdf', 'devis.pdf'), telecharger: async () => ({ refus: 'HTTP 404' }) });
    expect(await p.prepareFichier('t1', `https://api.messagingme.app/m/${CODE}.pdf`)).toMatchObject({ mediaId: 'MID-1' });
    expect(await p.prepareFichier('t2', `https://api.messagingme.app/m/${CODE}.pdf`)).toBeNull();
    expect(j.televerses).toHaveLength(1);
  });

  it('🔴 en production, le téléchargement gardé est celui des en-têtes de modèle (fetchPublic et resolutionPublique)', () => {
    const cablage = readFileSync(new URL('../src/workflow/wiring.ts', import.meta.url), 'utf8');
    expect(cablage).toMatch(/telecharger:[^\n]*=>\s*telechargerEnteteProduction\(/);
  });

  it('un type que WhatsApp ne prend pas en en-tête est refusé, rien n’est téléversé', async () => {
    const { p, j } = preparer({ lireFichier: fiche('text/html', null) });
    expect(await p.prepareFichier('t1', `https://api.messagingme.app/m/${CODE}.png`)).toBeNull();
    expect(j.televerses).toEqual([]);
  });

  it('cache par numéro et par adresse : une campagne ne téléverse pas la même vidéo par destinataire', async () => {
    const { p, j } = preparer({ lireFichier: fiche('video/mp4', 'demo.mp4') });
    await p.prepareFichier('t1', `https://api.messagingme.app/m/${CODE}.mp4`);
    expect(await p.prepareFichier('t1', `https://api.messagingme.app/m/${CODE}.mp4`)).toEqual({ mediaId: 'MID-1', type: 'video', nom: 'demo.mp4' });
    expect(j.televerses).toHaveLength(1);
  });
});
