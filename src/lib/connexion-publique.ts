import { lookup as lookupDns, type LookupAddress } from 'node:dns';
import { connect as connectTcp, isIP, type Socket } from 'node:net';
import { Agent, buildConnector, fetch as fetchUndici } from 'undici';
import { estAdressePrivee } from './adresse-privee';

/**
 * La connexion vérifiée : l'adresse est contrôlée au moment où la socket s'ouvre, pas avant.
 *
 * 🔴 Ce que ça ferme : le « DNS rebinding ». `resolutionPublique` vérifie qu'un nom résout vers une adresse
 * publique, puis `fetch` refait sa propre résolution : un DNS hostile peut répondre public à la première,
 * interne à la seconde. Ici, la résolution qui sert à se connecter est celle qui est vérifiée. La vérification
 * préalable reste pour rendre un refus lisible avant l'appel ; seule celle-ci fait la sécurité.
 *
 * Deux portes : un nom passe par la résolution (`lookupPublic`) ; une adresse écrite en chiffres n'y passe
 * jamais (la pile réseau ne résout pas un littéral), elle est jugée à part dans le connecteur, redirection vers
 * un littéral comprise.
 *
 * `fetch` et `Agent` viennent du même paquet `undici` : la production (Node 22) et le poste (Node 24)
 * embarquent des undici différents, et donner un `Agent` d'une version au `fetch` intégré d'une autre donne un
 * comportement qui dépend de la machine.
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
 * Le `lookup` branché sur la socket : il résout, refuse si une seule adresse est interne (sinon le choix
 * reviendrait à la pile réseau, donc au hasard), et rend sinon exactement ce qu'il a vérifié. Les deux formes
 * de rappel existent : `net.connect` demande `all: true` quand il essaie plusieurs familles.
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
 * L'agent de production, un seul pour le process : il garde les connexions ouvertes, et une connexion
 * réutilisée reste liée à l'adresse vérifiée à son ouverture.
 */
const agentPublic = new Agent({ connect: connecteurPublic() });

/**
 * 🔴 Le `fetch` de tout appel vers une adresse saisie par un client. L'inventaire de ces chemins est tenu par
 * `tests/lib-adresse-privee.test.ts`.
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
 * Vrai si l'appel a été refusé parce que la réponse redirigeait (`redirect: 'error'`). La raison est dans la
 * cause, pas dans le message : undici lève « fetch failed » et range « unexpected redirect » dans `cause`.
 */
export function estRedirectionRefusee(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i += 1) {
    // Le message exact d'undici : un simple « redirect » prendrait pour une redirection une panne DNS sur un hôte
    // dont le nom contient ce mot (`getaddrinfo ENOTFOUND redirect.client.fr`).
    if (e instanceof Error && /unexpected redirect/i.test(e.message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Une socket TCP vérifiée, pour un protocole qui n'est pas du HTTP (le SMTP d'une boîte d'envoi, donné à
 * nodemailer par son option `getSocket`). Même garde que `fetchPublic` : un littéral interne est refusé sans
 * rien ouvrir, un nom passe par `lookupPublic`, et la connexion part sur ce qui a été vérifié.
 *
 * Une socket plutôt qu'une IP vérifiée donnée à nodemailer : il garde le nom pour TLS (SNI, certificat) et
 * bascule sur l'adresse suivante (`autoSelectFamily`). Le plafond de temps couvre la résolution et
 * l'ouverture : nodemailer n'arme le sien qu'une fois la socket reçue, et `dns.lookup` n'accepte aucun signal
 * d'abandon.
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
      // Un auditeur neutre le temps que nodemailer pose les siens : un 'error' sans auditeur ferait tomber le
      // process. Nodemailer reçoit aussi l'événement.
      socket.on('error', () => {});
      ok(socket);
    });
  });
}
