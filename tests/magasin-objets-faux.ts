import { Readable } from 'node:stream';
import type { MagasinObjets } from '../src/lib/magasin-objets';

/**
 * Un magasin d'objets en mémoire (lot A des médias). Jamais dans `src/` : le câblage de production ne doit pas pouvoir
 * l'importer. `echouer` fait lever l'opération et la clé qu'on lui nomme, pour exercer les reprises.
 */
export function magasinFaux(echouer: (op: 'deposer' | 'lire' | 'effacer', cle: string) => boolean = () => false) {
  const objets = new Map<string, { octets: Buffer; type: string }>();
  const lever = (op: 'deposer' | 'lire' | 'effacer', cle: string): void => {
    if (echouer(op, cle)) throw new Error(`magasin faux : ${op} refusé pour ${cle}`);
  };
  const magasin: MagasinObjets = {
    deposer: async (cle, octets, type) => {
      lever('deposer', cle);
      objets.set(cle, { octets: Buffer.from(octets), type });
    },
    lireFlux: async (cle) => {
      lever('lire', cle);
      const o = objets.get(cle);
      return o ? Readable.from([o.octets]) : null;
    },
    lireOctets: async (cle) => {
      lever('lire', cle);
      return objets.get(cle)?.octets ?? null;
    },
    effacer: async (cle) => {
      lever('effacer', cle);
      objets.delete(cle);
    },
    effacerPrefixe: async (prefixe) => {
      const cles = [...objets.keys()].filter((k) => k.startsWith(prefixe));
      for (const k of cles) await magasin.effacer(k);
      return cles.length;
    },
  };
  return { magasin, objets };
}

/** Lit un flux en entier : ce que `/m/` enverrait. */
export async function lireTout(flux: Readable): Promise<Buffer> {
  const morceaux: Buffer[] = [];
  for await (const m of flux) morceaux.push(Buffer.from(m as Buffer));
  return Buffer.concat(morceaux);
}
