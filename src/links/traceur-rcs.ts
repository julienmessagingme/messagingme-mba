import type { RcsOutbound } from '../rcs/types';
import { destinationsTracables, appliquerLiensRcs } from './rcs-liens';
import { lienPourContact } from './rewrite';
import { messageDe } from '../lib/erreur';

/**
 * Remplace les liens d'un message RCS par nos adresses de redirection, juste avant l'envoi.
 *
 * Branché au point de passage unique des envois RCS (`RcsSender.sendTo`), où convergent tous les chemins :
 * tracer ailleurs voudrait dire l'écrire à chaque chemin, donc l'oublier une fois.
 * Tout échec est silencieux pour l'envoi : l'adresse d'origine reste dans le bouton, le clic n'est pas compté.
 */

export interface DepotLiensRcs {
  /** Réserve (ou retrouve) le code de cette adresse pour cet espace. */
  allocateRcs(tenantId: string, code: string, destination: string): Promise<string>;
}

export class TraceurLiensRcs {
  /**
   * `<espace>\0<adresse> -> code`, pour la durée du process. Sans ce cache, une campagne de 5 000 destinataires
   * ferait 5 000 allocations pour la même adresse. Il est sûr pour toujours : l'association est immuable
   * (index unique de la 0107, aucun code réattribué).
   */
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly depot: DepotLiensRcs,
    private readonly base: string,
    private readonly nouveauCode: () => string,
    /** Borne du cache (éviction FIFO, la Map garde l'ordre d'insertion) : la mémoire du worker ne doit pas
     *  enfler indéfiniment. */
    private readonly maxCache = 1000,
  ) {}

  /** Le préfixe de nos redirections : une adresse qui commence par là est déjà tracée, la retracer ferait un
   *  code qui redirige vers un code. */
  private get prefixe(): string {
    return `${this.base.replace(/\/+$/, '')}/r/`;
  }

  /** Lève si l'allocation échoue : `tracer` absorbe adresse par adresse, pour qu'un lien en échec n'emporte
   *  pas les autres liens du message. */
  private async codePour(tenantId: string, destination: string): Promise<string> {
    // `\u0000` échappé, jamais un NUL brut (git verrait le fichier comme binaire). Le NUL ne peut apparaître
    // ni dans un identifiant d'espace ni dans une URL.
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
   * Le message avec ses boutons `openUrl` pointant la redirection, jeton du destinataire compris. Même
   * référence quand il n'y a rien à tracer : le sender teste l'identité.
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
