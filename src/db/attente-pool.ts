/**
 * Mesurer l'attente d'une connexion au pool.
 *
 * À saturation, le comportement est déjà correct (chaque requête attend puis échoue au bout de
 * `DB_CONN_TIMEOUT_MS`) ; le défaut serait de ne pas le voir. Le bon indicateur n'est pas « à combien du plafond »
 * mais « quelqu'un a-t-il attendu, et combien de temps » : une jauge lue à l'ouverture de `/ops` raterait le pic,
 * mesurer chaque acquisition n'en rate aucun.
 * Deux choses se cachent dans « attendre » : ouvrir une connexion neuve (TCP + TLS) coûte quelques millisecondes et
 * c'est normal ; attendre qu'une connexion se libère sur un pool saturé est le signal. Seule la seconde compte
 * comme une attente.
 */

/** Ce qu'un seau d'une minute retient. Sans p95 : voir `SEUIL_ATTENTE_MS`. */
export interface SeauAttente {
  /** Nombre d'acquisitions mesurées dans la minute. */
  echantillons: number;
  /** Parmi elles, celles faites alors que le pool était saturé : le signal. */
  attentes: number;
  /** La plus longue acquisition de la minute, en millisecondes, toutes causes confondues. */
  maxMs: number;
  /**
   * La plus longue acquisition faite sur un pool saturé : le vrai signal. `maxMs` inclut l'ouverture normale d'une
   * connexion neuve, et les confondre ferait crier au loup l'écran d'exploitation.
   */
  maxAttenteMs: number;
  /** Somme des durées, pour une moyenne lisible sans garder les échantillons. */
  sommeMs: number;
}

/**
 * Pas de p95 : la quasi-totalité des acquisitions valent zéro, le p95 ne dirait rien. Le maximum est le pic qu'on
 * cherche, sans garder les échantillons.
 */
export const SEUIL_ATTENTE_MS = 1;

const seauVide = (): SeauAttente => ({ echantillons: 0, attentes: 0, maxMs: 0, maxAttenteMs: 0, sommeMs: 0 });

/** L'accumulateur. Une instance par process : l'API et le worker ont chacun leur pool, donc leur mesure. */
export class MesureAttentePool {
  private seau: SeauAttente = seauVide();
  private maxDepuisDemarrageMs = 0;
  /** Profondeur de suspension : un compteur et pas un booléen, pour que deux suspensions imbriquées ne se
   *  désactivent pas l'une l'autre. */
  private suspendu = 0;

  /**
   * Suspend la mesure pendant qu'elle s'écrit elle-même : le vidage écrit par le pool instrumenté, et sans cela
   * la télémétrie s'auto-alimenterait (une ligne chaque minute même au repos).
   */
  async sansSeMesurer<T>(faire: () => Promise<T>): Promise<T> {
    this.suspendu += 1;
    try {
      return await faire();
    } finally {
      this.suspendu -= 1;
    }
  }

  /** `sature` = le pool était au maximum sans connexion libre au moment de la demande. */
  enregistrer(ms: number, sature: boolean): void {
    if (this.suspendu > 0) return;
    const duree = Number.isFinite(ms) && ms > 0 ? ms : 0;
    this.seau.echantillons += 1;
    this.seau.sommeMs += duree;
    if (duree > this.seau.maxMs) this.seau.maxMs = duree;
    if (duree > this.maxDepuisDemarrageMs) this.maxDepuisDemarrageMs = duree;
    if (sature && duree >= SEUIL_ATTENTE_MS) {
      this.seau.attentes += 1;
      if (duree > this.seau.maxAttenteMs) this.seau.maxAttenteMs = duree;
    }
  }

  /**
   * Rend le seau courant et en repart un neuf, une fois par minute. Atomique pour l'appelant (boucle Node à un seul
   * fil) : aucune acquisition ne se perd entre le relevé et la remise à zéro.
   */
  vider(): SeauAttente {
    const seau = this.seau;
    this.seau = seauVide();
    return seau;
  }

  /**
   * Remet un seau qu'on n'a pas pu écrire, fusionné avec ce qui s'est accumulé entre-temps. Une fusion et non un
   * `enregistrer`, qui perdrait le nombre d'échantillons et d'attentes.
   */
  reinjecter(seau: SeauAttente): void {
    this.seau.echantillons += seau.echantillons;
    this.seau.attentes += seau.attentes;
    this.seau.sommeMs += seau.sommeMs;
    if (seau.maxMs > this.seau.maxMs) this.seau.maxMs = seau.maxMs;
    if (seau.maxAttenteMs > this.seau.maxAttenteMs) this.seau.maxAttenteMs = seau.maxAttenteMs;
  }

  /** Le pic depuis le démarrage du process, jamais remis à zéro : la mémoire longue de l'écran. */
  get maxDepuisDemarrage(): number {
    return this.maxDepuisDemarrageMs;
  }
}

/** Le sous-ensemble de `pg.Pool` dont l'instrumentation a besoin, testable sans base. */
export interface PoolInstrumentable {
  connect: {
    (): Promise<unknown>;
    (cb: (err: Error | undefined, client: unknown, release: unknown) => void): void;
  };
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options?: { max?: number };
}

/**
 * Branche la mesure sur le pool, en un seul endroit.
 *
 * Sur `connect` et pas `query` : `pg.Pool.query` appelle `this.connect(...)` en interne (pg-pool), donc envelopper
 * `connect` sur l'instance capture aussi toutes les requêtes des stores. Les deux formes sont couvertes, avec
 * rappel (celle de `query`) et sans (celle des transactions). Une acquisition qui échoue est mesurée aussi : un
 * délai dépassé sur pool saturé est la plus longue attente possible.
 */
export function instrumenterPool(pool: PoolInstrumentable, mesure: MesureAttentePool, maintenant: () => number = () => Date.now()): void {
  const original = pool.connect.bind(pool) as PoolInstrumentable['connect'];
  const sature = (): boolean => pool.idleCount === 0 && pool.totalCount >= (pool.options?.max ?? Infinity);

  const instrumente = ((cb?: (err: Error | undefined, client: unknown, release: unknown) => void): unknown => {
    const debut = maintenant();
    const etaitSature = sature();
    if (typeof cb === 'function') {
      return (original as (c: typeof cb) => void)((err, client, release) => {
        mesure.enregistrer(maintenant() - debut, etaitSature);
        cb(err, client, release);
      });
    }
    return (original as () => Promise<unknown>)().then(
      (client) => { mesure.enregistrer(maintenant() - debut, etaitSature); return client; },
      (err: unknown) => { mesure.enregistrer(maintenant() - debut, etaitSature); throw err; },
    );
  }) as PoolInstrumentable['connect'];

  pool.connect = instrumente;
}
