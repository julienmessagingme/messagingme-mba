import { isSendableButtonUrl } from '../meta/button-url';
import { lireCorpsBorne } from './corps-borne';
import { resolutionPublique, type VerdictResolution } from './adresse-privee';

/**
 * Lecture d'une page publique depuis le serveur, et la garde qui la rend acceptable.
 *
 * 🔴 POURQUOI CE MODULE EXISTE. Deux surfaces demandent au serveur d'aller lire une adresse saisie par un
 * client : l'import de FAQ de l'agent Meta, et l'import de connaissance d'un agent IA. Le serveur tourne dans
 * le réseau Docker du VPS, à portée de l'admin NPM, des autres conteneurs et du service de métadonnées du
 * fournisseur. Une seconde copie de cette garde qui divergerait de celle-ci ouvrirait un lecteur de
 * l'intérieur du réseau (SSRF) au premier oubli.
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
 * URL sûre à récupérer depuis le serveur. Bloque les schémas non HTTP et les hôtes internes.
 *
 * ⚠️ Le contrôle porte sur le NOM D'HÔTE, pas sur l'IP finalement résolue : un domaine public qui pointe vers
 * une adresse privée passe. Le pare-feu reste la dernière barrière.
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
 * Récupération d'une page distante. Bornée : plafond de taille annoncé ET vérifié après lecture (un serveur
 * peut mentir sur `content-length`), et délai court, parce qu'un admin attend devant l'écran pendant ce temps.
 *
 * ⚠️ Les redirections sont suivies À LA MAIN et CHAQUE saut est revalidé. En `redirect: 'follow'`, une page
 * publique parfaitement légitime en apparence peut renvoyer un 302 vers `169.254.169.254` : le contrôle
 * d'origine, qui ne porte que sur l'URL saisie, serait alors contourné en une ligne de configuration côté
 * attaquant.
 */
export function fetchUrlBorne(
  timeoutMs = 10_000,
  fetchImpl: typeof fetch = fetch,
  /** Injectée pour tester sans DNS. Défaut : la vraie résolution. */
  verifierResolution: (url: string) => Promise<VerdictResolution> = resolutionPublique,
): (url: string) => Promise<PageDistante> {
  return async (url: string) => {
    let courante = url;
    for (let saut = 0; saut <= 3; saut += 1) {
      // 🔴 OÙ CE NOM MÈNE-T-IL VRAIMENT ? `urlRecuperable` lit le TEXTE de l'hôte : elle ne peut rien contre
      // un nom public dont l'enregistrement A pointe vers le réseau Docker ou vers les métadonnées du
      // fournisseur. Vérifié à CHAQUE saut, pour la même raison que la revalidation d'origine juste en
      // dessous : c'est la redirection qui porte le contournement, pas l'adresse saisie.
      const resolution = await verifierResolution(courante);
      if (!resolution.ok) throw new Error(`hôte non autorisé (${resolution.raison ?? 'adresse interne'})`);
      const res = await fetchImpl(courante, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'text/html,application/json,text/csv;q=0.9,*/*;q=0.8' },
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
      // ⚠️ Le plafond était vérifié APRÈS `res.text()`, donc une page de deux gigaoctets entrait entièrement
      // en mémoire avant d'être jetée. La lecture est bornée EN FLUX : on coupe à l'octet qui dépasse. Le
      // `content-length` reste vérifié au-dessus, il évite d'ouvrir le flux quand le serveur annonce la
      // couleur, mais il ne peut pas servir de garde à lui seul : un serveur ment.
      const corps = await lireCorpsBorne(res, MAX_PAGE_OCTETS);
      if (corps.trop_gros) throw new Error('page trop lourde');
      // Même raison que le plafond juste au-dessus : une page dont le flux a lâché n'est pas une page vide.
      // L'importer en base de connaissance ferait entrer un document tronqué que personne ne saurait relire.
      if (corps.casse) throw new Error('la lecture de la page a été interrompue');
      return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: corps.texte };
    }
    throw new Error('trop de redirections');
  };
}
