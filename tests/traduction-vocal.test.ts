import { describe, it, expect } from 'vitest';
import { transcrireMessage, RienATranscrire, type DepsTranscrire, type MessageATranscrire } from '../src/inbox/transcrire';
import type { HttpTransport } from '../src/meta/http';
import type { LangueConsole } from '../src/traduction/traduire';

/**
 * LES VOCAUX : transcrire PUIS traduire, en un seul geste pour l'opérateur.
 *
 * 🔴 CE QUE CE FICHIER GARDE. D'abord la SOURCE de la traduction : c'est la TRANSCRIPTION, jamais
 * `body`, qui vaut `[audio]` ou la légende, et dont la traduction ne produirait rien tout en coûtant
 * un appel. Ensuite la langue détectée, qui était rendue par `transcrire` depuis le 2026-09-09 et
 * JETÉE : sans elle, il faudrait un second appel de détection, ou bien on traduirait en français un
 * vocal déjà français.
 */

/** Un transport qui rend la réponse de transcription qu'on lui donne. Aucun réseau. */
function transport(reponse: unknown): HttpTransport {
  return {
    post: async () => ({ status: 200, json: reponse, headers: {} }),
    get: async () => ({ status: 404, json: null, headers: {} }),
  } as unknown as HttpTransport;
}

const VOCAL_ESPAGNOL = { text: 'Hola, tengo un problema', language: 'es', durationInSeconds: 3 };

interface Montage {
  message?: Partial<MessageATranscrire>;
  reponse?: unknown;
  /** Ce que le traducteur rend. `null` = la traduction n'aboutit pas. */
  traduction?: { texte: string; langueSource: string | null } | null;
  cible?: LangueConsole | null;
  /** Aucun traducteur câblé du tout (instance sans modèle). */
  sansTraducteur?: boolean;
}

function monter(o: Montage = {}) {
  const traduits: string[] = [];
  const ecritures: Array<{ texte: string; modele: string; langue: string | null }> = [];
  const rangees: Array<{ messageId: string; texte: string; langue: string }> = [];
  const deps: DepsTranscrire = {
    lireMessage: async () => ({
      id: 'm-vocal', mediaId: 'media-1', mediaMime: 'audio/ogg; codecs=opus', transcription: null,
      ...o.message,
    }),
    ecrireTranscription: async (_t, _m, texte, modele, langue) => { ecritures.push({ texte, modele, langue }); },
    ...(o.sansTraducteur ? {} : {
      traduire: async (_t, texte) => {
        traduits.push(texte);
        return o.traduction === undefined ? { texte: 'Bonjour, j ai un probleme', langueSource: 'es' } : o.traduction;
      },
      rangerTraduction: async (_t, messageId, texte, langue) => { rangees.push({ messageId, texte, langue }); },
    }),
    telecharger: async () => ({ bytes: Buffer.from('OggS'), mime: 'audio/ogg' }),
    transport: transport(o.reponse ?? VOCAL_ESPAGNOL),
    cle: 'cle-maison',
    modele: 'openai/whisper-1',
    tailleMaxOctets: 2048 * 1024,
  };
  return {
    deps, traduits, ecritures, rangees,
    lire: () => transcrireMessage(deps, 't1', 'm-vocal', 'c1', o.cible === undefined ? 'fr' : o.cible),
  };
}

describe('un vocal se transcrit, puis se traduit', () => {
  it('transcrire PUIS traduire, en un seul geste pour l operateur', async () => {
    const m = monter();
    const r = await m.lire();
    expect(r.texte).toBe('Hola, tengo un problema'); // ce qui a ete DIT
    expect(r.traduction).toBe('Bonjour, j ai un probleme'); // notre lecture
    expect(r.langue).toBe('es');
    expect(r.deja).toBe(false);
  });

  it('🔴 la source de la traduction est la TRANSCRIPTION, pas le body', async () => {
    // `body` vaut `[audio]` ou la legende : le traduire ne produirait rien, et couterait un appel.
    const m = monter();
    await m.lire();
    expect(m.traduits).toEqual(['Hola, tengo un problema']);
  });

  it('sans traduction active, la transcription reste seule et intacte', async () => {
    const m = monter({ cible: null });
    const r = await m.lire();
    expect(r.traduction).toBeNull();
    expect(r.texte).toBe('Hola, tengo un problema');
    expect(m.traduits).toEqual([]);
  });

  it('une instance SANS traducteur transcrit quand meme, sans rien casser', async () => {
    const m = monter({ sansTraducteur: true });
    const r = await m.lire();
    expect(r.texte).toBe('Hola, tengo un problema');
    expect(r.traduction).toBeNull();
  });

  it('🔴 la langue detectee est ECRITE, elle n est plus jetee', async () => {
    // Elle etait rendue par `transcrire` depuis le 2026-09-09 et personne ne la gardait. Sans elle,
    // il faudrait un second appel de detection pour savoir s'il y a quelque chose a traduire.
    const m = monter();
    await m.lire();
    expect(m.ecritures).toEqual([{ texte: 'Hola, tengo un problema', modele: 'openai/whisper-1', langue: 'es' }]);
  });

  it('une langue non rendue par le fournisseur s ecrit null, pas une supposition', async () => {
    const m = monter({ reponse: { text: 'Hola, tengo un problema' } });
    const r = await m.lire();
    expect(r.langue).toBeNull();
    expect(m.ecritures[0]!.langue).toBeNull();
    // Et on traduit quand meme : sans langue connue, c'est le comportement d'avant la migration.
    expect(m.traduits).toEqual(['Hola, tengo un problema']);
  });

  it('la traduction est RANGEE, pour que le lecteur suivant ne la repaie pas', async () => {
    const m = monter();
    await m.lire();
    expect(m.rangees).toEqual([{ messageId: 'm-vocal', texte: 'Bonjour, j ai un probleme', langue: 'fr' }]);
  });

  it('une traduction qui echoue rend null, et la transcription reste lisible', async () => {
    const m = monter({ traduction: null });
    const r = await m.lire();
    expect(r.texte).toBe('Hola, tengo un problema');
    expect(r.traduction).toBeNull();
    expect(m.rangees).toEqual([]);
  });
});

describe('ce qui ne doit RIEN couter', () => {
  it('🔴 un vocal DEJA dans la langue du lecteur ne se traduit pas', async () => {
    // Le cas que la langue detectee fait gagner : un vocal francais lu par un francophone. Traduire
    // serait un appel paye pour rendre le meme texte.
    const m = monter({ reponse: { text: 'Bonjour, j ai un probleme', language: 'fr' } });
    const r = await m.lire();
    expect(m.traduits).toEqual([]);
    // ...et on ne presente PAS la transcription comme sa propre traduction : l'ecran afficherait
    // deux fois le meme texte, dont l'un annonce comme une lecture de modele.
    expect(r.traduction).toBeNull();
  });

  it('un vocal deja transcrit ne repaie pas la seconde d audio', async () => {
    const m = monter({ message: { transcription: 'Hola, tengo un problema', transcriptionLangue: 'es' } });
    const r = await m.lire();
    expect(r.deja).toBe(true);
    expect(m.ecritures).toEqual([]);
    // ...mais il se TRADUIT, parce que le second geste peut etre demande longtemps apres le premier,
    // par un collegue qui ne lit pas la meme langue.
    expect(m.traduits).toEqual(['Hola, tengo un problema']);
    expect(r.traduction).toBe('Bonjour, j ai un probleme');
  });

  it('🔴 une traduction DEJA rangee dans la bonne langue se relit au lieu de se repayer', async () => {
    const m = monter({
      message: {
        transcription: 'Hola, tengo un problema', transcriptionLangue: 'es',
        traduction: 'Bonjour, j ai un probleme', traductionLangue: 'fr',
      },
    });
    const r = await m.lire();
    expect(m.traduits).toEqual([]);
    expect(r.traduction).toBe('Bonjour, j ai un probleme');
  });

  it('une traduction rangee dans une AUTRE langue ne sert pas, et se refait', async () => {
    // Le sens inverse : un collegue anglophone ouvre un fil traduit en francais. Reutiliser la
    // traduction francaise lui afficherait une langue qu'il n'a pas demandee.
    const m = monter({
      message: {
        transcription: 'Hola, tengo un problema', transcriptionLangue: 'es',
        traduction: 'Bonjour, j ai un probleme', traductionLangue: 'fr',
      },
      cible: 'en',
    });
    await m.lire();
    expect(m.traduits).toEqual(['Hola, tengo un problema']);
  });
});

describe('les refus n ont pas change', () => {
  it('un message sans media ne se transcrit pas, et ce n est pas une panne', async () => {
    const m = monter({ message: { mediaId: null } });
    await expect(m.lire()).rejects.toBeInstanceOf(RienATranscrire);
  });

  it('un message d un autre espace est introuvable', async () => {
    const deps: DepsTranscrire = { ...monter().deps, lireMessage: async () => null };
    await expect(transcrireMessage(deps, 't1', 'm-vocal', 'c1', 'fr')).rejects.toBeInstanceOf(RienATranscrire);
  });
});
