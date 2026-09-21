import { lookup as lookupDns, type LookupAddress } from 'node:dns';
import { connect as connectTcp, isIP, type Socket } from 'node:net';
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
 * UNE SOCKET TCP VÉRIFIÉE, pour un protocole qui n'est pas du HTTP (le SMTP d'une boîte d'envoi, que nodemailer
 * reçoit par son option `getSocket`).
 *
 * 🔴 LA MÊME GARDE QUE `fetchPublic`, DANS LA SOCKET : un littéral interne est refusé sans rien ouvrir, un nom est
 * résolu par `lookupPublic`, qui refuse si une seule adresse est interne, et la connexion part sur ce qui a été
 * vérifié. Il n'y a donc pas d'écart où glisser une autre réponse DNS.
 *
 * ⚠️ POURQUOI UNE SOCKET, ET PAS UNE ADRESSE VÉRIFIÉE DONNÉE À NODEMAILER. Lui passer l'IP coupait trois choses
 * qu'il fait bien : garder le NOM pour TLS (SNI et certificat), basculer sur l'adresse suivante quand la première
 * ne répond pas, et ne rien mettre dans le SNI quand l'hôte est écrit en chiffres. Ici il garde tout cela :
 * `autoSelectFamily` essaie les adresses vérifiées l'une après l'autre, et le nom d'hôte reste le sien.
 *
 * ⚠️ UN PLAFOND DE TEMPS COUVRE LA RÉSOLUTION ET L'OUVERTURE : nodemailer n'arme le sien qu'une fois la socket
 * reçue, et `dns.lookup` n'accepte aucun signal d'abandon.
 */
export function ouvrirSocketPublique(
  hote: string,
  port: number,
  opts: { resoudre?: ResoudreTout; estInterdite?: (ip: string) => boolean; delaiMs?: number } = {},
): Promise<Socket> {
  const estInterdite = opts.estInterdite ?? estAdressePrivee;
  const nu = hote.trim().replace(/^\[|\]$/g, '');
  if (isIP(nu) !== 0 && estInterdite(nu)) return Promise.reject(new AdresseInterdite());
  return new Promise<Socket>((ok, ko) => {
    const socket = connectTcp({
      host: nu, port, autoSelectFamily: true,
      lookup: lookupPublic(opts.resoudre ?? resoudreParDefaut, estInterdite) as never,
    });
    const echec = (err: Error): void => { clearTimeout(echeance); socket.destroy(); ko(err); };
    const echeance = setTimeout(
      () => echec(Object.assign(new Error('connexion trop lente'), { code: 'ETIMEDOUT' })), opts.delaiMs ?? 20_000,
    );
    socket.once('error', echec);
    socket.once('connect', () => {
      clearTimeout(echeance);
      socket.removeListener('error', echec);
      // Un auditeur neutre le temps que nodemailer pose les siens : une erreur dans l'intervalle ne doit pas
      // faire tomber le process (un 'error' sans auditeur lève). Nodemailer reçoit aussi l'événement.
      socket.on('error', () => {});
      ok(socket);
    });
  });
}
