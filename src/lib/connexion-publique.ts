import { lookup as lookupDns, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, buildConnector, fetch as fetchUndici } from 'undici';
import { estAdressePrivee } from './adresse-privee';

/**
 * LA CONNEXION VÉRIFIÉE : l'adresse est contrôlée AU MOMENT OÙ LA SOCKET S'OUVRE, pas avant.
 *
 * 🔴 CE QUE ÇA FERME : LE « DNS REBINDING ». `resolutionPublique` vérifie qu'un nom résout vers une adresse
 * publique, puis `fetch` refait SA PROPRE résolution pour se connecter. Entre les deux, un serveur DNS hostile
 * peut répondre autre chose : une adresse publique à la vérification, puis le réseau Docker du VPS ou les
 * métadonnées du fournisseur à la connexion. Relevé par plusieurs audits depuis le 2026-09-02. Ici, la
 * résolution qui sert à se connecter est CELLE qui est vérifiée : il n'y a plus d'écart où glisser une autre
 * réponse.
 *
 * ⚠️ LA VÉRIFICATION PRÉALABLE RESTE, ET ELLE A UN AUTRE RÔLE : elle rend un refus LISIBLE avant l'appel
 * (« ce nom pointe vers une adresse interne »), là où un refus à la connexion ne remonte que comme une panne
 * réseau. Elle ne suffit plus seule à la sécurité, elle ne l'est plus du tout pour cette pièce.
 *
 * 🔴 DEUX PORTES, PAS UNE. Un nom passe par la résolution (`lookupPublic`). Une adresse écrite EN CHIFFRES
 * (`http://127.0.0.1/`) n'y passe JAMAIS : la pile réseau ne résout pas un littéral. Elle est donc jugée à part,
 * dans le connecteur, avant d'ouvrir quoi que ce soit. C'est ce qui couvre aussi une redirection vers un
 * littéral, pour un appelant qui suivrait les redirections.
 *
 * 🔴 `fetch` ET `Agent` VIENNENT DU MÊME PAQUET `undici`, et c'est délibéré. La production tourne en Node 22,
 * dont le `fetch` intégré embarque undici 6 ; le poste de développement tourne en Node 24 (undici 7). Donner un
 * `Agent` d'un paquet au `fetch` intégré d'une autre version est le piège classique : un comportement qui
 * diffère selon la machine. Ici, les deux viennent de la même version, partout.
 */

/** Refus d'une adresse interne au moment de la connexion. Le code se lit dans la chaîne `cause` de l'erreur. */
export class AdresseInterdite extends Error {
  readonly code = 'ADRESSE_INTERNE';
  constructor() {
    // Sans jamais citer l'adresse : elle renseignerait sur la topologie interne.
    super('connexion refusée : adresse interne');
    this.name = 'AdresseInterdite';
  }
}

/** Résolution injectable, pour éprouver la garde sans DNS. Même forme que `dns.lookup(..., { all: true })`. */
export type ResoudreTout = (hote: string, rappel: (err: Error | null, adresses: LookupAddress[]) => void) => void;

const resoudreParDefaut: ResoudreTout = (hote, rappel) => {
  lookupDns(hote, { all: true, verbatim: true }, (err, adresses) => rappel(err, adresses ?? []));
};

/** Signature de `lookup` attendue par `net.connect` / `tls.connect`. */
type Lookup = (
  hote: string,
  options: { all?: boolean } | number | undefined,
  rappel: (err: Error | null, adresse?: string | LookupAddress[], famille?: number) => void,
) => void;

/**
 * Le `lookup` branché sur la socket : il résout, REFUSE si une seule adresse est interne, et rend sinon
 * exactement ce qu'il a vérifié.
 *
 * 🔴 UNE SEULE ADRESSE INTERDITE CONDAMNE LE NOM, comme dans `resolutionPublique` : sinon le choix entre une
 * adresse publique et une adresse privée reviendrait à la pile réseau, donc au hasard.
 *
 * ⚠️ Les deux formes de rappel existent : `net.connect` demande `all: true` quand il essaie plusieurs familles
 * (le défaut de Node récent), et une seule adresse sinon.
 */
export function lookupPublic(
  resoudre: ResoudreTout = resoudreParDefaut,
  estInterdite: (ip: string) => boolean = estAdressePrivee,
): Lookup {
  return (hote, options, rappel) => {
    resoudre(hote, (err, adresses) => {
      if (err) return rappel(err);
      if (adresses.length === 0) return rappel(Object.assign(new Error('nom introuvable'), { code: 'ENOTFOUND' }));
      if (adresses.some((a) => estInterdite(a.address))) return rappel(new AdresseInterdite());
      const toutes = typeof options === 'object' && options !== null && options.all === true;
      if (toutes) return rappel(null, adresses);
      const premiere = adresses[0]!;
      return rappel(null, premiere.address, premiere.family);
    });
  };
}

type Connecteur = ReturnType<typeof buildConnector>;

/**
 * Le connecteur de l'agent : un littéral est jugé tout de suite, un nom passe par `lookupPublic`.
 */
export function connecteurPublic(
  resoudre: ResoudreTout = resoudreParDefaut,
  estInterdite: (ip: string) => boolean = estAdressePrivee,
): Connecteur {
  const base = buildConnector({ lookup: lookupPublic(resoudre, estInterdite) as never });
  return (options, rappel) => {
    const hote = options.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hote) !== 0 && estInterdite(hote)) {
      rappel(new AdresseInterdite(), null);
      return;
    }
    base(options, rappel);
  };
}

/** Un `fetch` dont chaque connexion passe par le connecteur vérifié. Injectable pour les tests. */
export function fetchPublicAvec(agent: Agent): typeof fetch {
  return ((entree: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetchUndici(entree as never, { ...(init as object), dispatcher: agent } as never)) as unknown as typeof fetch;
}

/**
 * L'agent de production, UN seul pour le process : il garde les connexions ouvertes d'un appel à l'autre. Une
 * connexion réutilisée a été vérifiée à son ouverture, et reste liée à l'adresse vérifiée.
 */
const agentPublic = new Agent({ connect: connecteurPublic() });

/**
 * 🔴 LE `fetch` DE TOUT APPEL VERS UNE ADRESSE SAISIE PAR UN CLIENT (connecteur, test de requête, épreuve de
 * source, page distante, client MCP). L'inventaire de ces chemins est tenu par `tests/lib-adresse-privee.test.ts`.
 */
export const fetchPublic: typeof fetch = fetchPublicAvec(agentPublic);

/** Vrai si l'erreur (ou une de ses causes) est un refus d'adresse interne à la connexion. */
export function estRefusAdresseInterne(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i += 1) {
    if (e instanceof AdresseInterdite || (e as { code?: unknown }).code === 'ADRESSE_INTERNE') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Vrai si l'appel a été refusé parce que la réponse REDIRIGEAIT (`redirect: 'error'`).
 *
 * 🔴 LA RAISON EST DANS LA CAUSE, PAS DANS LE MESSAGE. Le `fetch` d'undici, comme celui de Node, lève
 * « fetch failed » et range « unexpected redirect » dans `cause` (mesuré contre un serveur local, 2026-09-21).
 * Lire le seul `message`, c'était ne jamais reconnaître une redirection : elle s'affichait « injoignable ».
 */
export function estRedirectionRefusee(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i += 1) {
    // Le message exact d'undici. Un simple « redirect » prendrait pour une redirection une panne DNS sur un
    // hôte dont le NOM contient ce mot (`getaddrinfo ENOTFOUND redirect.client.fr`).
    if (e instanceof Error && /unexpected redirect/i.test(e.message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * L'ADRESSE PUBLIQUE D'UN HÔTE, VÉRIFIÉE, pour un protocole qui n'est pas du HTTP (le SMTP d'une boîte d'envoi).
 *
 * 🔴 ON SE CONNECTE ENSUITE À CETTE ADRESSE-LÀ, EN CHIFFRES. `fetchPublic` place sa garde dans la socket ; un
 * client SMTP fait sa propre résolution, hors de notre portée. Le seul moyen de fermer l'écart entre « vérifier »
 * et « se connecter » est donc de lui donner l'adresse déjà vérifiée, et le NOM d'origine à part, pour TLS (SNI
 * et vérification du certificat portent sur le nom, pas sur l'adresse).
 *
 * Mêmes règles que la connexion vérifiée : une seule adresse interne condamne le nom, un littéral interne est
 * refusé sans résolution, une résolution qui échoue ou qui TRAÎNE est un refus (`dns.lookup` n'accepte aucun
 * signal d'abandon, d'où le plafond).
 */
export function adressePubliqueDe(
  hote: string,
  resoudre: ResoudreTout = resoudreParDefaut,
  estInterdite: (ip: string) => boolean = estAdressePrivee,
  delaiMs = 3_000,
): Promise<string> {
  const nu = hote.trim().replace(/^\[|\]$/g, '');
  if (isIP(nu) !== 0) return estInterdite(nu) ? Promise.reject(new AdresseInterdite()) : Promise.resolve(nu);
  return new Promise<string>((ok, ko) => {
    const echeance = setTimeout(() => ko(Object.assign(new Error('résolution trop lente'), { code: 'ETIMEOUT' })), delaiMs);
    echeance.unref?.();
    lookupPublic(resoudre, estInterdite)(nu, { all: true }, (err, adresses) => {
      clearTimeout(echeance);
      if (err) return ko(err);
      const toutes = adresses as LookupAddress[];
      // 🔴 L'IPv4 D'ABORD, comme nodemailer le faisait en résolvant lui-même (`resolve4` avant `resolve6`). Un
      // conteneur Docker n'a pas d'IPv6 par défaut : prendre la première adresse rendue, souvent une IPv6,
      // rendrait injoignables des serveurs qui l'étaient.
      ok((toutes.find((a) => a.family === 4) ?? toutes[0]!).address);
    });
  });
}
