/**
 * LA CADENCE D'UN ENREGISTREMENT AUTOMATIQUE : quand envoyer, et quand ne pas envoyer. Sans React, pour qu'une horloge
 * simulée la mette à l'épreuve (`cadence-enregistrement.test.ts`) ; `useEnregistrementScenario` la pilote.
 *
 * 🔴 POURQUOI ELLE EXISTE (2026-10-20) : l'éditeur de scénario a envoyé 434 enregistrements en cinq minutes, dépassé le
 * plafond de 300 requêtes par minute et par utilisateur, et la console entière a répondu « trop de requêtes » pendant
 * une minute. Trois défauts s'additionnaient, chacun a sa parade ici :
 *   - une modification arrivée PENDANT un envoi relançait l'envoi suivant SANS délai : pendant un glisser ou une frappe
 *     continue, les envois s'enchaînaient au rythme du serveur (36 ms). La relance repasse par le délai (`delaiMs`), et
 *     deux départs restent espacés d'au moins `espacementMs`, quoi qu'il arrive ;
 *   - React Flow change la liste des blocs pour une sélection, une mesure ou chaque pixel d'un glisser, et chacun
 *     planifiait un envoi du MÊME scénario : au moment de partir, on compare à ce que le serveur a déjà, et on n'envoie
 *     rien si c'est identique ;
 *   - un refus de débit (429) ne freinait rien : l'envoi se met en pause le temps que le serveur demande, puis reprend
 *     seul. Le plafond couvre toutes les routes de l'utilisateur, donc insister couperait toute la console.
 *
 * Invariants : jamais deux envois en vol ; le dernier état finit toujours par partir (sauf après un échec qui n'est pas
 * un 429 : aucune relance automatique, sinon une erreur persistante, session expirée en tête, bouclerait ; la prochaine
 * modification ou `maintenant` reprend).
 */
export interface ReglagesCadence {
  /** Attente après la dernière modification avant d'envoyer. */
  readonly delaiMs: number;
  /** Écart minimum entre deux départs, même pendant une édition continue. */
  readonly espacementMs: number;
}

/** La cadence d'un scénario : 1,2 s après la dernière modification, au plus un départ toutes les 5 s (choix de Julien). */
export const CADENCE_SCENARIO: ReglagesCadence = { delaiMs: 1200, espacementMs: 5000 };

/** Ce que `maintenant` attend au plus un envoi en vol, pour ne jamais bloquer un bouton sur une requête qui traîne. */
export const ATTENTE_MAX_ENVOI_MS = 4000;

export interface EtatCadence {
  readonly enCours: boolean;
  /** L'échec du dernier envoi, `null` après un succès. */
  readonly erreur: unknown;
}

export interface Horloge {
  maintenant(): number;
  programmer(f: () => void, ms: number): unknown;
  annuler(minuteur: unknown): void;
}

const HORLOGE_REELLE: Horloge = {
  maintenant: () => Date.now(),
  programmer: (f, ms) => setTimeout(f, ms),
  annuler: (m) => clearTimeout(m as ReturnType<typeof setTimeout>),
};

export interface DependancesCadence {
  /** L'état courant, sérialisé : deux états égaux donnent la même chaîne. */
  lire(): string;
  /** Envoie un état ; rejette en cas d'échec. */
  envoyer(contenu: string, keepalive: boolean): Promise<void>;
  /** Un refus de débit : la pause demandée en ms. `null` pour tout autre échec. */
  pauseApres(erreur: unknown): number | null;
  surEtat?(etat: EtatCadence): void;
  horloge?: Horloge;
}

export class CadenceEnregistrement {
  private reference: string;
  private sale = false;
  private enVol: Promise<void> | null = null;
  private minuteur: unknown = null;
  private dernierDepart = Number.NEGATIVE_INFINITY;
  private pauseJusqua = 0;
  private erreur: unknown = null;
  /** Posé par `arreter` : plus aucun départ programmé, même au retour d'un envoi de fermeture refusé. */
  private arrete = false;
  private readonly horloge: Horloge;

  /** `initial` : l'état que le serveur a déjà (le scénario tel qu'ouvert). */
  constructor(private readonly deps: DependancesCadence, private readonly reglages: ReglagesCadence, initial: string) {
    this.reference = initial;
    this.horloge = deps.horloge ?? HORLOGE_REELLE;
  }

  /** Une modification vient d'avoir lieu (peut-être sans effet sur ce qui s'enregistre : c'est vérifié au départ). */
  modifie(): void {
    // Un remontage (StrictMode) repasse par ici : la cadence reprend.
    this.arrete = false;
    this.sale = true;
    this.armer(this.reglages.delaiMs);
  }

  /**
   * Envoie TOUT DE SUITE ce qui reste, sans délai ni espacement (avant une publication, au bouton « réessayer », à la
   * fermeture de l'onglet), et dit si tout est enregistré. Elle attend l'envoi en vol au plus `ATTENTE_MAX_ENVOI_MS`.
   * Une pause de débit en cours la refuse : envoyer ne ferait qu'un refus de plus. En `keepalive` (fermeture), on
   * n'attend pas l'envoi en vol (la page n'y survivrait pas) et on tente malgré une pause : c'est la dernière chance.
   */
  async maintenant(keepalive = false): Promise<boolean> {
    this.annulerMinuteur();
    if (!keepalive && !(await this.attendreLEnvoiEnVol())) return false;
    if (!keepalive && this.horloge.maintenant() < this.pauseJusqua) {
      // Le minuteur vient d'être annulé : sans ce réarmement, la reprise à la fin de la pause n'aurait plus lieu.
      if (this.sale || this.deps.lire() !== this.reference) this.armer(this.reglages.delaiMs);
      return !this.sale && this.deps.lire() === this.reference;
    }
    if (this.deps.lire() !== this.reference) await this.partir(keepalive);
    else this.oublierLErreur();
    return this.erreur === null && this.deps.lire() === this.reference;
  }

  /** Le composant s'en va : plus aucun départ programmé (l'appelant vide avant, par `maintenant(true)`). */
  arreter(): void {
    this.arrete = true;
    this.annulerMinuteur();
  }

  private async attendreLEnvoiEnVol(): Promise<boolean> {
    const limite = this.horloge.maintenant() + ATTENTE_MAX_ENVOI_MS;
    while (this.enVol) {
      const reste = limite - this.horloge.maintenant();
      if (reste <= 0) return false;
      const fini = await Promise.race([
        this.enVol.then(() => true),
        new Promise<boolean>((r) => { this.horloge.programmer(() => r(false), reste); }),
      ]);
      if (!fini) return false;
    }
    return true;
  }

  /** L'état est revenu à ce que le serveur a : l'échec d'avant ne veut plus rien dire. */
  private oublierLErreur(): void {
    if (this.erreur === null) return;
    this.erreur = null;
    this.notifier(false);
  }

  private annulerMinuteur(): void {
    if (this.minuteur !== null) this.horloge.annuler(this.minuteur);
    this.minuteur = null;
  }

  private armer(delaiMs: number): void {
    this.annulerMinuteur();
    if (this.arrete) return;
    const t = this.horloge.maintenant();
    const quand = Math.max(t + delaiMs, this.dernierDepart + this.reglages.espacementMs, this.pauseJusqua);
    this.minuteur = this.horloge.programmer(() => {
      this.minuteur = null;
      void this.partir(false);
    }, quand - t);
  }

  private partir(keepalive: boolean): Promise<void> {
    // Un envoi en vol replanifie lui-même à son retour s'il reste quelque chose : jamais deux en vol.
    if (this.enVol && !keepalive) return this.enVol;
    const contenu = this.deps.lire();
    if (contenu === this.reference) {
      this.sale = false;
      this.oublierLErreur();
      return Promise.resolve();
    }
    this.sale = false;
    this.dernierDepart = this.horloge.maintenant();
    this.notifier(true);
    const vol = this.voler(contenu, keepalive);
    this.enVol = vol;
    void vol.finally(() => { if (this.enVol === vol) this.enVol = null; });
    return vol;
  }

  private async voler(contenu: string, keepalive: boolean): Promise<void> {
    let relancer = true;
    try {
      await this.deps.envoyer(contenu, keepalive);
      this.reference = contenu;
      this.erreur = null;
    } catch (e) {
      this.erreur = e;
      this.sale = true;
      const pause = this.deps.pauseApres(e);
      if (pause === null) relancer = false;
      else this.pauseJusqua = this.horloge.maintenant() + pause;
    }
    this.notifier(false);
    // La relance passe par le délai ET l'espacement : c'est elle qui enchaînait les envois à 36 ms.
    if (relancer && (this.sale || this.deps.lire() !== this.reference)) this.armer(this.reglages.delaiMs);
  }

  private notifier(enCours: boolean): void {
    this.deps.surEtat?.({ enCours, erreur: this.erreur });
  }
}
