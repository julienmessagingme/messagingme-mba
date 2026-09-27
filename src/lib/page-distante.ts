import { isSendableButtonUrl } from '../meta/button-url';
import { fetchPublic, estRefusAdresseInterne } from './connexion-publique';
import { lireCorpsBorne } from './corps-borne';
import { resolutionPublique, type VerdictResolution } from './adresse-privee';

/**
 * Lecture d'une page publique depuis le serveur, et la garde qui la rend acceptable.
 *
 * 🔴 Le serveur tourne dans le réseau Docker du VPS, à portée de l'admin NPM, des autres conteneurs et des
 * métadonnées du fournisseur : toute lecture d'une adresse saisie par un client passe par ici, une seconde
 * copie de la garde qui divergerait ouvrirait une SSRF.
 */

/** Plafond de lecture d'une page distante. Au-delà on refuse plutôt que de charger le tas en mémoire. */
export const MAX_PAGE_OCTETS = 2_000_000;

/** Ce qu'une lecture rend. Le corps est déjà décodé en texte, et déjà borné. */
export interface PageDistante {
  status: number;
  contentType: string;
  body: string;
}

/**
 * URL sûre à récupérer depuis le serveur : bloque les schémas non HTTP et les hôtes internes. Elle ne lit que
 * le texte de l'hôte ; ce vers quoi il résout est vérifié par `fetchUrlBorne`.
 */
export function urlRecuperable(raw: string): boolean {
  if (!isSendableButtonUrl(raw)) return false;
  const hote = new URL(raw.trim()).hostname.toLowerCase();
  if (hote === 'localhost' || hote.endsWith('.localhost') || hote.endsWith('.local') || hote.endsWith('.internal')) return false;
  // Littéraux IPv4 privés / loopback / lien-local / métadonnées cloud.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hote);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return false;
  }
  return true;
}

/**
 * Récupération d'une page distante, bornée en taille et en délai (un admin attend devant l'écran).
 *
 * Les redirections sont suivies à la main et chaque saut est revalidé : en `redirect: 'follow'`, une page
 * publique pourrait renvoyer un 302 vers `169.254.169.254` et contourner le contrôle de l'URL saisie.
 */
export function fetchUrlBorne(
  timeoutMs = 10_000,
  /** Défaut : le `fetch` vérifié à la connexion (DNS rebinding), `connexion-publique.ts`. */
  fetchImpl: typeof fetch = fetchPublic,
  /** Injectée pour tester sans DNS. Défaut : la vraie résolution. */
  verifierResolution: (url: string) => Promise<VerdictResolution> = resolutionPublique,
): (url: string) => Promise<PageDistante> {
  return async (url: string) => {
    let courante = url;
    for (let saut = 0; saut <= 3; saut += 1) {
      // `urlRecuperable` ne lit que le texte de l'hôte : un nom public peut résoudre vers le réseau Docker ou les
      // métadonnées. La résolution est vérifiée à chaque saut, c'est la redirection qui porte le contournement.
      const resolution = await verifierResolution(courante);
      if (!resolution.ok) throw new Error(`hôte non autorisé (${resolution.raison ?? 'adresse interne'})`);
      const res = await fetchImpl(courante, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'text/html,application/json,text/csv;q=0.9,*/*;q=0.8' },
      }).catch((err: unknown) => {
        // Refus à la connexion (le nom a résolu vers l'intérieur entre la vérification et l'appel) : même message que
        // la vérification préalable, pas un « fetch failed » qui ferait chercher une panne.
        if (estRefusAdresseInterne(err)) throw new Error('hôte non autorisé (adresse interne)');
        throw err;
      });
      if (res.status >= 300 && res.status < 400) {
        const destination = res.headers.get('location');
        if (destination === null) throw new Error('redirection sans destination');
        const absolue = new URL(destination, courante).toString();
        if (!urlRecuperable(absolue)) throw new Error('redirection vers un hôte non autorisé');
        courante = absolue;
        continue;
      }
      const annonce = Number(res.headers.get('content-length') ?? '0');
      if (annonce > MAX_PAGE_OCTETS) throw new Error('page trop lourde');
      // Lecture bornée en flux, coupée à l'octet qui dépasse : le `content-length` ci-dessus évite d'ouvrir le flux
      // quand le serveur annonce la couleur, mais un serveur peut mentir.
      const corps = await lireCorpsBorne(res, MAX_PAGE_OCTETS);
      if (corps.trop_gros) throw new Error('page trop lourde');
      // Une page dont le flux a lâché n'est pas une page vide : l'importer ferait entrer un document tronqué.
      if (corps.casse) throw new Error('la lecture de la page a été interrompue');
      return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: corps.texte };
    }
    throw new Error('trop de redirections');
  };
}
