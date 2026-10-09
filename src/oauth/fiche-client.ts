import { z } from 'zod';
import { estRedirectionRefusee, estRefusAdresseInterne, fetchPublic } from '../lib/connexion-publique';
import { resolutionPublique, type VerdictResolution } from '../lib/adresse-privee';
import { lireCorpsBorne } from '../lib/corps-borne';
import { urlRecuperable } from '../lib/page-distante';
import { journaliser } from '../lib/journal';
import { adresseDeRetourPermise, estAdresseDeFiche, type ClientResolu } from './clients';

/**
 * LA FICHE D'IDENTITÉ D'UN CLIENT OAUTH (Client ID Metadata Document ; lot 15, spec
 * `2026-10-09-oauth-autres-clients-design.md`, § 2). Le `client_id` est l'adresse `https` d'un document JSON qui
 * décrit le client ; le domaine de cette adresse prouve son éditeur.
 *
 * 🔴 UNE REQUÊTE SORTANTE VERS UNE ADRESSE CHOISIE PAR UN TIERS, depuis le réseau Docker du VPS : toutes les gardes
 * d'une adresse saisie (texte de l'hôte, résolution publique, connexion vérifiée, AUCUNE redirection suivie, corps lu
 * en flux et borné, délai qui couvre la lecture). Inventorié par `tests/lib-adresse-privee.test.ts`. Elle ne part
 * qu'à `/oauth/authorize` : l'échange du code et le renouvellement comparent l'identifiant lié, sans rien récupérer.
 */

export const PLAFOND_FICHE_OCTETS = 10 * 1024;
export const DELAI_FICHE_MS = 5_000;
/** Une fiche valide sert 10 minutes, un échec 1 minute : un client qui se corrige n'attend pas, un attaquant ne
 *  fait pas partir une requête par appel. */
export const CACHE_FICHE_MS = 10 * 60_000;
export const CACHE_ECHEC_MS = 60_000;
const CACHE_MAX = 500;

/** La fiche, telle qu'on la lit : le reste est ignoré, dont le mode d'authentification (tout client est public). */
const fiche = z.object({
  client_id: z.string(),
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().optional(),
});

/** Les noms qu'un client non épinglé ne peut pas porter : ceux de nos clients vérifiés, et leur éditeur. */
const NOMS_RESERVES = new Set(['claude', 'claudecode', 'claudeai', 'anthropic']);

/**
 * Un nom affichable, ou `null` (le domaine, ou l'hôte de retour, en tient lieu) : 100 caractères au plus, sans
 * caractère de contrôle, de format (invisibles, sens d'écriture) ni séparateur de ligne, qui imiteraient un autre nom ou
 * retourneraient le texte qui le suit sur la page ; et jamais le nom de Claude, qu'un client non épinglé ne porte pas.
 */
export function nomAffichable(brut: string | undefined | null): string | null {
  const nom = (brut ?? '').trim();
  if (nom === '' || nom.length > 100 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(nom)) return null;
  return NOMS_RESERVES.has(nom.toLowerCase().replace(/[^a-z]/g, '')) ? null : nom;
}

export interface DepsFiches {
  /** `fetchPublic` en production : la connexion s'ouvre sur l'adresse vérifiée (DNS rebinding fermé). */
  fetch: typeof fetch;
  /** `resolutionPublique` en production : une adresse interne n'est jamais appelée. */
  verifier(url: string): Promise<VerdictResolution>;
  maintenant?: () => number;
  delaiMs?: number;
}

/** Récupère et valide la fiche, ou dit pourquoi pas. Ne lève jamais. */
async function recuperer(deps: DepsFiches, id: string): Promise<{ client: ClientResolu } | { refus: string }> {
  const verdict = await deps.verifier(id);
  if (!verdict.ok) return { refus: verdict.raison ?? 'adresse refusée' };
  const delai = deps.delaiMs ?? DELAI_FICHE_MS;
  const controle = new AbortController();
  const minuteur = setTimeout(() => controle.abort(), delai);
  try {
    const res = await deps.fetch(id, { method: 'GET', redirect: 'error', signal: controle.signal, headers: { accept: 'application/json' } });
    if (!res.ok) {
      // Le corps est rendu tout de suite : sinon la connexion reste tenue sur l'agent partagé.
      await res.body?.cancel().catch(() => {});
      return { refus: `HTTP ${res.status}` };
    }
    const lu = await lireCorpsBorne(res, PLAFOND_FICHE_OCTETS);
    if (lu.trop_gros) return { refus: 'fiche trop grosse' };
    if (lu.casse) return { refus: 'fiche arrivée incomplète' };
    let json: unknown;
    try {
      json = JSON.parse(lu.texte);
    } catch {
      return { refus: 'fiche illisible (JSON attendu)' };
    }
    const f = fiche.safeParse(json);
    if (!f.success) return { refus: 'fiche mal formée' };
    // 🔴 La fiche nomme sa propre adresse, au caractère près : sinon elle décrirait un autre client que celui qui se
    // présente.
    if (f.data.client_id !== id) return { refus: 'client_id de la fiche différent de son adresse' };
    if (!f.data.redirect_uris.every(adresseDeRetourPermise)) return { refus: 'adresse de retour hors politique dans la fiche' };
    const domaine = new URL(id).hostname;
    return {
      client: {
        id, nom: nomAffichable(f.data.client_name) ?? domaine, adressesDeRetour: [...f.data.redirect_uris], marque: 'domaine', domaine,
      },
    };
  } catch (err) {
    if (controle.signal.aborted) return { refus: `pas de réponse en ${Math.round(delai / 1000)} s` };
    if (estRefusAdresseInterne(err)) return { refus: 'adresse interne' };
    if (estRedirectionRefusee(err)) return { refus: 'redirection (non suivie)' };
    return { refus: 'récupération impossible' };
  } finally {
    clearTimeout(minuteur);
  }
}

export interface LecteurDeFiches {
  /** Le client de cette fiche, ou `null` (adresse refusée, fiche absente ou invalide). */
  lire(id: string): Promise<ClientResolu | null>;
}

/** Le lecteur, avec son cache en mémoire (par processus) et borné. */
export function creerLecteurDeFiches(deps: DepsFiches): LecteurDeFiches {
  const cache = new Map<string, { client: ClientResolu | null; jusqua: number }>();
  const maintenant = deps.maintenant ?? Date.now;
  return {
    async lire(id) {
      if (!estAdresseDeFiche(id) || !urlRecuperable(id)) return null;
      const t = maintenant();
      const deja = cache.get(id);
      if (deja && deja.jusqua > t) return deja.client;
      const r = await recuperer(deps, id);
      // Le refus se journalise sans rien d'autre que le domaine : c'est ce qui dira, à l'essai réel, pourquoi un client
      // ne passe pas.
      if ('refus' in r) journaliser('warn', 'oauth_fiche_refusee', { domaine: new URL(id).hostname, raison: r.refus });
      const client = 'client' in r ? r.client : null;
      if (!deja && cache.size >= CACHE_MAX) {
        const plusAncien = cache.keys().next().value;
        if (plusAncien !== undefined) cache.delete(plusAncien);
      }
      cache.set(id, { client, jusqua: t + (client ? CACHE_FICHE_MS : CACHE_ECHEC_MS) });
      return client;
    },
  };
}

/** Le lecteur de production : `fetchPublic` et `resolutionPublique`. */
export function lecteurDeFichesProduction(): LecteurDeFiches {
  return creerLecteurDeFiches({ fetch: fetchPublic, verifier: (url) => resolutionPublique(url) });
}
