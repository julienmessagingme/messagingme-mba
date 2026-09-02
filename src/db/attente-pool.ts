/**
 * MESURER L'ATTENTE D'UNE CONNEXION (lot 7 du plan post-audit, 2026-09-02).
 *
 * Question de Julien : « les 16 connexions, on fait quoi ? on serre les fesses, on prend une marge, on
 * autoscale, on met des alertes ? » Le calcul a tranché : à 11 ms d'aller-retour, huit connexions tiennent
 * environ 700 requêtes/s par process, et le scénario à 25 clients en demande quelques dizaines. Le pool n'est
 * PAS ce qui cassera. Autoscaler serait même la mauvaise réponse : chaque instance arrive avec SON pool, donc
 * ajouter des instances augmente la pression sur la seule ressource qui ne scale pas avec elles.
 *
 * 🔴 LE VRAI DÉFAUT N'EST PAS LE CHIFFRE, C'EST L'AVEUGLEMENT. À saturation, le comportement est déjà correct
 * (chaque requête attend puis échoue proprement au bout de `DB_CONN_TIMEOUT_MS`, avec une trace). Mais personne
 * ne regarde, donc on l'apprendrait par un client qui appelle.
 *
 * 🔴 ET LE BON INDICATEUR N'EST PAS « À COMBIEN DU PLAFOND ON EST ». C'est « quelqu'un a-t-il attendu, et
 * combien de temps ». Quinze connexions sur seize sans une seule attente, tout va bien ; des attentes à huit
 * sur seize, c'est autre chose qui cloche. Une jauge lue au moment où l'on ouvre `/ops` afficherait zéro
 * presque toujours et RATERAIT le pic, qui est justement ce qu'on cherche (objection de Julien, et elle est
 * juste). Mesurer chaque acquisition, elle, ne peut rater aucun pic : rien n'est échantillonné.
 *
 * ⚠️ DEUX CHOSES DIFFÉRENTES SE CACHENT DANS « ATTENDRE », et les confondre rendrait la mesure illisible :
 *  - ouvrir une connexion NEUVE coûte une poignée de millisecondes (TCP + TLS), et c'est normal, surtout au
 *    démarrage où le pool est vide ;
 *  - attendre qu'une connexion se LIBÈRE, pool déjà au maximum, est le signal qu'on cherche.
 * D'où deux compteurs et non un : la durée est toujours enregistrée, mais seule une acquisition faite sur un
 * pool SATURÉ compte comme une attente.
 */

/** Ce qu'un seau d'une minute retient. Volontairement sans p95 : voir `SEUIL_ATTENTE_MS`. */
export interface SeauAttente {
  /** Nombre d'acquisitions mesurées dans la minute. */
  echantillons: number;
  /** Parmi elles, celles faites alors que le pool était SATURÉ. C'est le signal. */
  attentes: number;
  /** La plus longue acquisition de la minute, en millisecondes, TOUTES causes confondues. */
  maxMs: number;
  /**
   * 🔴 La plus longue acquisition faite sur un pool SATURE. C'est LE signal, et il est distinct du precedent :
   * `maxMs` inclut l'ouverture normale d'une connexion neuve (TCP + TLS), qui coute des dizaines de
   * millisecondes et n'a rien d'anormal. Les confondre faisait crier au loup un ecran d'exploitation, et un
   * indicateur qui crie au loup se fait ignorer le jour ou il a raison. Releve par l'audit du 2026-09-02.
   */
  maxAttenteMs: number;
  /** Somme des durées, pour une moyenne lisible sans garder les échantillons. */
  sommeMs: number;
}

/**
 * Le p95 n'est pas calculé, et c'est un choix assumé plutôt qu'un oubli : sur une distribution où la quasi
 * totalité des acquisitions valent zéro, le p95 vaut zéro et ne dit RIEN. Le maximum, lui, est exactement le
 * pic qu'on cherche, et il ne coûte pas de garder les échantillons en mémoire.
 */
export const SEUIL_ATTENTE_MS = 1;

const seauVide = (): SeauAttente => ({ echantillons: 0, attentes: 0, maxMs: 0, maxAttenteMs: 0, sommeMs: 0 });

/**
 * L'accumulateur. Une instance par process : l'API et le worker ont chacun LEUR pool, donc chacun sa mesure.
 */
export class MesureAttentePool {
  private seau: SeauAttente = seauVide();
  private maxDepuisDemarrageMs = 0;
  /** Profondeur de suspension. Un compteur et pas un booleen : deux suspensions imbriquees ne doivent pas
   *  se desactiver l'une l'autre. */
  private suspendu = 0;

  /**
   * 🔴 SUSPENDRE LA MESURE PENDANT QU'ELLE S'ECRIT ELLE-MEME (constat de l'audit du 2026-09-02).
   *
   * Le vidage ecrit son seau en base PAR LE POOL INSTRUMENTE. Sans cette suspension, cette ecriture devient
   * le premier echantillon de la minute suivante : la telemetrie s'auto-alimente, une ligne apparait chaque
   * minute meme sur un process au repos, et la promesse « aucune ligne quand il ne se passe rien » devient
   * fausse des la premiere activite. Une mesure qui modifie ce qu'elle mesure ne mesure plus rien.
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
   * Rend le seau courant et en repart un neuf. Appelé une fois par minute par le process, qui l'écrit en base.
   *
   * ⚠️ Le vidage est ATOMIQUE du point de vue de l'appelant (rien ne s'exécute entre les deux lignes, la
   * boucle Node étant à un seul fil) : aucune acquisition ne peut se perdre entre le relevé et la remise à zéro.
   */
  vider(): SeauAttente {
    const seau = this.seau;
    this.seau = seauVide();
    return seau;
  }

  /**
   * REMET un seau qu'on n'a pas pu écrire, fusionné avec ce qui s'est accumulé entre-temps.
   *
   * ⚠️ Une fusion, pas un `enregistrer` : réinjecter un seau comme s'il était UNE acquisition perdrait le
   * nombre d'échantillons et le nombre d'attentes, c'est-à-dire tout sauf le pic. Une mesure qu'on répare de
   * travers vaut moins qu'une mesure manquante, parce qu'elle a l'air juste.
   */
  reinjecter(seau: SeauAttente): void {
    this.seau.echantillons += seau.echantillons;
    this.seau.attentes += seau.attentes;
    this.seau.sommeMs += seau.sommeMs;
    if (seau.maxMs > this.seau.maxMs) this.seau.maxMs = seau.maxMs;
    if (seau.maxAttenteMs > this.seau.maxAttenteMs) this.seau.maxAttenteMs = seau.maxAttenteMs;
  }

  /** Le pic depuis le démarrage du process, JAMAIS remis à zéro : c'est la mémoire longue de l'écran. */
  get maxDepuisDemarrage(): number {
    return this.maxDepuisDemarrageMs;
  }
}

/** Le sous-ensemble de `pg.Pool` dont l'instrumentation a besoin. Le typer ainsi la rend testable sans base. */
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
 * Branche la mesure sur le pool, EN UN SEUL ENDROIT.
 *
 * 🔴 Pourquoi `connect` et pas `query` : `pg.Pool.query` appelle `this.connect(...)` en interne (vérifié dans
 * `node_modules/pg-pool/index.js`). Envelopper `connect` capture donc AUSSI toutes les requêtes des stores,
 * sans toucher un seul d'entre eux. L'envelopper sur l'instance suffit, `query` passant par `this`.
 *
 * Les deux formes de `connect` sont couvertes : avec rappel (celle qu'emprunte `query`) et sans (celle des
 * transactions). En oublier une laisserait la moitié du trafic non mesurée, en silence.
 *
 * Une acquisition qui ÉCHOUE est mesurée elle aussi : un délai dépassé sur pool saturé est la plus longue
 * attente possible, et c'est exactement l'événement qu'on ne veut pas rater.
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
