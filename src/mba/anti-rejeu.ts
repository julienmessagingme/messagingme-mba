/**
 * UN GESTE QUI ENVOIE NE SE REJOUE PAS POUR LE MÊME CLIENT, le temps d'une demande (essai réel du 2026-09-22).
 *
 * 🔴 VÉCU : l'agent de Meta a appelé « Lancer un scénario » SEPT fois dans le même tour (Conversation Turns : sept
 * appels, tous réussis), et chaque appel relançait le parcours depuis le début : le client a reçu sept fois le
 * premier message. La réponse de l'outil est corrigée, mais le comportement d'un modèle ne se garantit pas : ce
 * garde, lui, garantit que le client ne reçoit qu'une fois, quoi que fasse l'agent.
 *
 * ⚠️ EN MÉMOIRE DU PROCESSUS : le relais tourne dans l'API, une seule instance. À revoir avant le multi-instance,
 * comme les plafonds de débit (`CLAUDE.md`, § Sécurité).
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
   * PREND toutes ces clés si AUCUNE n'est prise, et le dit : `true` = ce geste peut partir. Chaque clé a sa durée.
   *
   * 🔴 VÉRIFIER ET RETENIR D'UN SEUL GESTE, SYNCHRONE (revue finale du 2026-09-22). La première version exposait
   * « déjà fait ? » et « retenir » séparément, et l'appelant attendait la base entre les deux : sept appels
   * SIMULTANÉS passaient tous la vérification avant que le premier ne retienne, et partaient tous (7 sur 7,
   * mesuré). Sans `await` ici, deux appels ne peuvent pas s'intercaler.
   */
  prendreTous(cles: ReadonlyArray<readonly [string, number]>): boolean {
    const t = this.maintenant();
    // Ce ménage EST l'expiration (le `has` qui suit ne lit pas l'heure), et il borne la mémoire : sans lui, une
    // clé ne repartirait jamais, et la table grandirait d'une entrée par client et par outil, pour toujours.
    for (const [k, fin] of this.vus) if (t >= fin) this.vus.delete(k);
    if (cles.some(([k]) => this.vus.has(k))) return false;
    for (const [k, duree] of cles) this.vus.set(k, t + duree);
    return true;
  }

  /** Oublie ces clés : un geste REFUSÉ n'a rien envoyé, et doit pouvoir être redemandé. */
  oublier(...cles: string[]): void {
    for (const k of cles) this.vus.delete(k);
  }
}

/** Deux minutes : bien plus qu'un tour de l'agent de Meta (quelques secondes), bien moins qu'une vraie redemande. */
export const DUREE_ANTI_REJEU_MS = 2 * 60_000;

/**
 * Le PLANCHER : un même outil, pour un même client, ne repart pas avant 30 s, QUEL QUE SOIT son dernier message.
 *
 * 🔴 LA CLÉ PAR MESSAGE NE SUFFIT PAS SEULE (relecture du 2026-09-22) : une réaction 👍, un clic, ou une demande
 * coupée en deux (« je veux la brochure », puis « svp ») changent le dernier message reçu, et un rappel de l'agent
 * juste après prenait une clé neuve : le scénario repartait du début. Au-delà du plancher, c'est le message qui
 * départage, et une vraie redemande relance (celle de l'essai réel arrivait 55 s après). Il doit rester au-dessus
 * de l'attente de fin de tour et au-dessous de ces 55 s : un test tient les deux bornes.
 */
export const PLANCHER_ANTI_REJEU_MS = 30_000;
