import type { RcsOutbound } from '../rcs/types';
import { destinationsTracables, appliquerLiensRcs } from './rcs-liens';
import { lienPourContact } from './rewrite';
import { messageDe } from '../lib/erreur';

/**
 * Remplace les liens d'un message RCS par nos adresses de redirection, juste avant l'envoi.
 *
 * Branché au POINT DE PASSAGE UNIQUE des envois RCS (`RcsSender.sendTo`), et c'est le choix structurant du
 * lot : les quatre chemins qui envoient du RCS (campagne, bloc de scénario, réponse rapide convertie, inbox)
 * y convergent déjà. Tracer ailleurs voudrait dire l'écrire quatre fois, donc l'oublier une fois.
 *
 * ⚠️ TOUT ÉCHEC EST SILENCIEUX ET SANS CONSÉQUENCE SUR L'ENVOI. Une allocation qui rate laisse l'adresse
 * d'origine dans le bouton : le contact arrive au bon endroit, le clic n'est pas compté. C'est la doctrine du
 * canal, écrite dans le sender lui-même : un message part toujours.
 */

export interface DepotLiensRcs {
  /** Réserve (ou retrouve) le code de cette adresse pour cet espace. */
  allocateRcs(tenantId: string, code: string, destination: string): Promise<string>;
}

export class TraceurLiensRcs {
  /**
   * `<espace> <adresse> -> code`, mémorisé pour la durée du process. Séparateur ESPACE : un identifiant
   * d'espace est un UUID, il n'en contient jamais, la clé composée est donc sans ambiguïté.
   *
   * 🔴 Sans ce cache, une campagne de 5 000 destinataires ferait 5 000 allocations pour la même adresse, sur
   * le chemin le plus chaud du produit. Le cache est sûr POUR TOUJOURS parce que l'association est immuable :
   * la 0107 la garde par un index unique, et rien dans le code ne réattribue un code à une adresse.
   */
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly depot: DepotLiensRcs,
    private readonly base: string,
    private readonly nouveauCode: () => string,
    /** Borne du cache : un espace qui enverrait des milliers d'adresses distinctes ne doit pas faire enfler
     *  la mémoire du worker indéfiniment. Éviction FIFO, la Map gardant l'ordre d'insertion. */
    private readonly maxCache = 1000,
  ) {}

  /** Le préfixe de NOS propres redirections. Une adresse qui commence par là est déjà tracée : la tracer une
   *  seconde fois créerait un code qui redirige vers un code. */
  private get prefixe(): string {
    return `${this.base.replace(/\/+$/, '')}/r/`;
  }

  /** Le code de cette adresse. LÈVE si l'allocation échoue : c'est `tracer` qui absorbe, une adresse à la
   *  fois, pour qu'un lien en échec n'emporte pas les autres liens du message. */
  private async codePour(tenantId: string, destination: string): Promise<string> {
    // \u0000 ECHAPPE, jamais un caractere NUL brut : un NUL dans un fichier source le fait voir comme
    // BINAIRE par git, ce qui supprime le diff, la revue et le blame sur tout le fichier. Le separateur
    // reste le NUL parce qu'il ne peut apparaitre ni dans un identifiant d'espace ni dans une URL.
    const cle = `${tenantId}\u0000${destination}`;
    const connu = this.cache.get(cle);
    if (connu) return connu;
    const code = await this.depot.allocateRcs(tenantId, this.nouveauCode(), destination);
    if (this.cache.size >= this.maxCache) {
      const plusAncien = this.cache.keys().next();
      if (!plusAncien.done) this.cache.delete(plusAncien.value);
    }
    this.cache.set(cle, code);
    return code;
  }

  /**
   * Le message avec ses boutons `openUrl` pointant la redirection, jeton du destinataire compris.
   *
   * Rend le message TEL QUEL (même référence) quand il n'y a rien à tracer : le sender chaîne plusieurs mises
   * en forme et teste l'identité pour savoir si le message a bougé.
   */
  async tracer(tenantId: string, msg: RcsOutbound, jeton?: string): Promise<RcsOutbound> {
    const destinations = destinationsTracables(msg).filter((u) => !u.startsWith(this.prefixe));
    if (destinations.length === 0) return msg;

    const liens = new Map<string, string>();
    for (const destination of destinations) {
      try {
        liens.set(destination, lienPourContact(this.base, await this.codePour(tenantId, destination), jeton));
      } catch (err) {
        // Nommée, jamais fatale : un lien non tracé est une mesure perdue, pas un message perdu.
        // eslint-disable-next-line no-console
        console.error(`RCS ${tenantId}: lien non tracé (${destination}):`, messageDe(err));
      }
    }
    return appliquerLiensRcs(msg, liens);
  }
}
