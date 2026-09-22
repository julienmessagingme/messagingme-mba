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
  private readonly vus = new Map<string, number>();

  constructor(private readonly dureeMs: number, private readonly maintenant: () => number = Date.now) {}

  /**
   * PREND la clé si personne ne l'a prise il y a moins de `dureeMs`, et le dit : `true` = ce geste peut partir.
   *
   * 🔴 VÉRIFIER ET RETENIR D'UN SEUL GESTE, SYNCHRONE (revue finale du 2026-09-22). La première version exposait
   * « déjà fait ? » et « retenir » séparément, et l'appelant attendait la base entre les deux : sept appels
   * SIMULTANÉS passaient tous la vérification avant que le premier ne retienne, et partaient tous (7 sur 7,
   * mesuré). Sans `await` ici, deux appels ne peuvent pas s'intercaler.
   */
  prendre(cle: string): boolean {
    const t = this.maintenant();
    // Le ménage se fait ici : sans lui, la table grandirait d'une entrée par client et par outil, pour toujours.
    for (const [k, v] of this.vus) if (t - v >= this.dureeMs) this.vus.delete(k);
    if (this.vus.has(cle)) return false;
    this.vus.set(cle, t);
    return true;
  }

  /** Oublie la clé : un geste REFUSÉ n'a rien envoyé, et doit pouvoir être redemandé. */
  oublier(cle: string): void {
    this.vus.delete(cle);
  }
}

/** Deux minutes : bien plus qu'un tour de l'agent de Meta (quelques secondes), bien moins qu'une vraie redemande. */
export const DUREE_ANTI_REJEU_MS = 2 * 60_000;
