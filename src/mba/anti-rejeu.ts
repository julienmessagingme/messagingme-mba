/**
 * Un geste qui envoie ne se rejoue pas pour le même client, le temps d'une demande : l'agent de Meta peut
 * appeler le même outil plusieurs fois dans un tour, et le client recevrait chaque fois le premier message.
 * En mémoire du processus : le relais tourne dans l'API, en une seule instance ; à revoir avant le multi-instance.
 */
export class AntiRejeu {
  /** Clé -> instant (ms) où elle se libère. */
  private readonly vus = new Map<string, number>();

  constructor(private readonly dureeMs: number, private readonly maintenant: () => number = Date.now) {}

  /** Une seule clé, à la durée par défaut. Voir `prendreTous`. */
  prendre(cle: string): boolean {
    return this.prendreTous([[cle, this.dureeMs]]);
  }

  /**
   * Prend toutes ces clés si aucune n'est prise, et le dit : `true` = ce geste peut partir. Chaque clé a sa durée.
   * Vérifier et retenir d'un seul geste synchrone : avec un `await` entre les deux, des appels simultanés
   * passeraient tous la vérification.
   */
  prendreTous(cles: ReadonlyArray<readonly [string, number]>): boolean {
    const t = this.maintenant();
    // Ce ménage est l'expiration (le `has` qui suit ne lit pas l'heure), et il borne la mémoire : sans lui, une
    // clé ne repartirait jamais, et la table grandirait d'une entrée par client et par outil, pour toujours.
    for (const [k, fin] of this.vus) if (t >= fin) this.vus.delete(k);
    if (cles.some(([k]) => this.vus.has(k))) return false;
    for (const [k, duree] of cles) this.vus.set(k, t + duree);
    return true;
  }

  /** Oublie ces clés : un geste refusé n'a rien envoyé, et doit pouvoir être redemandé. */
  oublier(...cles: string[]): void {
    for (const k of cles) this.vus.delete(k);
  }
}

/** Deux minutes : bien plus qu'un tour de l'agent de Meta (quelques secondes), bien moins qu'une vraie redemande. */
export const DUREE_ANTI_REJEU_MS = 2 * 60_000;

/**
 * Le plancher : un même outil, pour un même client, ne repart pas avant 30 s, quel que soit son dernier message.
 * La clé par message ne suffit pas : une réaction ou une demande coupée en deux change le dernier message, et un
 * rappel de l'agent relancerait le scénario. Au-delà, c'est le message qui départage. Doit rester au-dessus de
 * l'attente de fin de tour et sous le délai d'une vraie redemande (un test tient les deux bornes).
 */
export const PLANCHER_ANTI_REJEU_MS = 30_000;
