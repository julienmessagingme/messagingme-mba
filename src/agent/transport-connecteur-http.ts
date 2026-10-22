import { resolutionPublique, type VerdictResolution } from '../lib/adresse-privee';
import { fetchPublic, estRedirectionRefusee, estRefusAdresseInterne } from '../lib/connexion-publique';
import { lireCorpsBorne } from '../lib/corps-borne';

/**
 * Le transport d'un Connecteur HTTP déjà préparé.
 *
 * Les adapters appelants possèdent la source, l'authentification et l'interprétation métier. Ce module possède
 * uniquement le protocole réseau commun : résolution publique, connexion protégée contre le DNS rebinding,
 * redirections refusées, abandon et lecture bornée.
 */

export type LectureTransportConnecteur =
  | { nature: 'aucune' }
  | { nature: 'texte'; maxOctets: number };

export interface AppelTransportConnecteur {
  url: string;
  methode: string;
  entetes: Record<string, string>;
  corps: string | null;
  signal: AbortSignal;
  lecture: LectureTransportConnecteur;
}

export type ResultatTransportConnecteur =
  | { nature: 'reponse'; httpStatus: number; texte?: string; dureeMs: number }
  | { nature: 'adresse_refusee'; dureeMs: number }
  | { nature: 'redirection_refusee'; httpStatus?: number; dureeMs: number }
  | { nature: 'abandon'; dureeMs: number }
  | { nature: 'reseau'; dureeMs: number }
  | { nature: 'corps_trop_gros'; httpStatus: number; dureeMs: number }
  | { nature: 'corps_interrompu'; httpStatus: number; dureeMs: number };

export interface TransportConnecteurHttp {
  executer(appel: AppelTransportConnecteur): Promise<ResultatTransportConnecteur>;
}

export interface TransportConnecteurHttpDeps {
  fetch: typeof fetch;
  verifierResolution(url: string): Promise<VerdictResolution>;
}

/**
 * Fabrique injectable pour les tests du transport. Les adapters injectent l'interface complète, jamais les deux
 * primitives : un faux `fetch` sans garde DNS ne peut ainsi plus constituer un transport valide par accident.
 */
export function creerTransportConnecteurHttp(
  deps: TransportConnecteurHttpDeps = {
    fetch: fetchPublic,
    verifierResolution: (url) => resolutionPublique(url),
  },
): TransportConnecteurHttp {
  const dureeDepuis = (debut: number): number => Date.now() - debut;

  const annulerCorps = async (res: Response): Promise<void> => {
    if (res.body) await res.body.cancel().catch(() => {});
  };

  return {
    async executer(appel): Promise<ResultatTransportConnecteur> {
      const debut = Date.now();
      if (appel.signal.aborted) return { nature: 'abandon', dureeMs: dureeDepuis(debut) };

      let resolution: VerdictResolution;
      try {
        resolution = await deps.verifierResolution(appel.url);
      } catch {
        return { nature: 'reseau', dureeMs: dureeDepuis(debut) };
      }
      if (appel.signal.aborted) return { nature: 'abandon', dureeMs: dureeDepuis(debut) };
      if (!resolution.ok) return { nature: 'adresse_refusee', dureeMs: dureeDepuis(debut) };

      let res: Response;
      try {
        res = await deps.fetch(appel.url, {
          method: appel.methode,
          headers: appel.entetes,
          ...(appel.corps !== null ? { body: appel.corps } : {}),
          redirect: 'error',
          signal: appel.signal,
        });
      } catch (err) {
        if (estRefusAdresseInterne(err)) return { nature: 'adresse_refusee', dureeMs: dureeDepuis(debut) };
        if (estRedirectionRefusee(err)) return { nature: 'redirection_refusee', dureeMs: dureeDepuis(debut) };
        if (appel.signal.aborted) return { nature: 'abandon', dureeMs: dureeDepuis(debut) };
        return { nature: 'reseau', dureeMs: dureeDepuis(debut) };
      }

      // `redirect: 'error'` lève avec Undici. Un faux fetch ou une autre implementation peut néanmoins rendre
      // la réponse : le contrat du Connecteur HTTP reste le même dans les deux cas.
      if (res.status >= 300 && res.status < 400) {
        await annulerCorps(res);
        return { nature: 'redirection_refusee', httpStatus: res.status, dureeMs: dureeDepuis(debut) };
      }

      if (appel.lecture.nature === 'aucune') {
        // La sonde ne lit pas le corps, mais libère le flux : une réponse volumineuse ne garde pas la connexion.
        await annulerCorps(res);
        return { nature: 'reponse', httpStatus: res.status, dureeMs: dureeDepuis(debut) };
      }

      const lu = await lireCorpsBorne(res, appel.lecture.maxOctets);
      // Un abandon pendant la lecture est un abandon, pas une fausse « réponse interrompue ».
      if (appel.signal.aborted) return { nature: 'abandon', dureeMs: dureeDepuis(debut) };
      if (lu.trop_gros) {
        return { nature: 'corps_trop_gros', httpStatus: res.status, dureeMs: dureeDepuis(debut) };
      }
      if (lu.casse) {
        return { nature: 'corps_interrompu', httpStatus: res.status, dureeMs: dureeDepuis(debut) };
      }
      return { nature: 'reponse', httpStatus: res.status, texte: lu.texte, dureeMs: dureeDepuis(debut) };
    },
  };
}

/** Le transport de production, partagé par défaut par les trois adapters. */
export const transportConnecteurHttp = creerTransportConnecteurHttp();
