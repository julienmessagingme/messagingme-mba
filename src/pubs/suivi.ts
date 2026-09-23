import type { DepensePub, EtatCampagneMeta } from '../meta/pubs-creation';

/**
 * LE BALAYAGE DU SUIVI DES PUBLICITÉS (lot 3, commit 3, spec § 3.5) : toutes les quinze minutes, on relit
 * chez Meta ce que les campagnes publiées sont devenues. IO INJECTÉE : aucun import qui tire pg ni fetch.
 *
 * 🔴 POURQUOI ON LIT AU LIEU D'ÉCOUTER. Meta propose des webhooks de compte publicitaire, et ils ne
 * signalent PAS tous les passages de statut (source tierce, § « Ce que dit Meta »). Un suivi bâti sur eux
 * afficherait « en revue » sur une publicité refusée depuis deux jours, sans que rien ne le signale. On
 * relit donc, à une cadence choisie pour rester très en deçà du plafond du niveau « Limited ».
 *
 * 🔴 ET LE ROUTAGE NE DÉPEND JAMAIS DE CE BALAYAGE. Un jeton rejeté, un Meta muet, une panne : les leads
 * continuent d'arriver et d'être routés, parce que le routage ne lit que nos tables. Ce qui s'arrête ici,
 * c'est l'affichage de chiffres, pas la réponse à un prospect.
 */

/** Ce que le balayage sait faire. Chaque méthode est étroite, pour qu'un faux tienne en quelques lignes. */
export interface SuiviPubsDeps {
  /** Les espaces qui ont une connexion publicitaire ET au moins une publicité à suivre. */
  espacesASuivre(): Promise<string[]>;
  /** Les campagnes de cet espace qu'il faut relire. Vide = rien à faire, aucun appel à Meta. */
  campagnesASuivre(tenantId: string): Promise<string[]>;
  /** Le jeton en clair. `null` = plus de connexion (déconnectée entre-temps) : on passe. */
  jeton(tenantId: string): Promise<string | null>;
  lireCampagnes(campagneIds: readonly string[], jeton: string): Promise<Map<string, EtatCampagneMeta>>;
  lireDepenses(campagneIds: readonly string[], jeton: string): Promise<Map<string, DepensePub>>;
  /** Écrit ce que Meta a rendu, et l'heure de lecture. */
  noterSuivi(tenantId: string, campagneId: string, v: {
    etat: EtatCampagneMeta | null; depense: DepensePub | null;
  }): Promise<void>;
  /** Meta a refusé le jeton : la connexion est invalide, l'écran doit le dire. */
  marquerJetonRejete(tenantId: string): Promise<void>;
  /** Ce jeton est-il refusé PAR META, par opposition à une panne passagère ? */
  estJetonRefuse(err: unknown): boolean;
  /** Prévient l'exploitation. Un jeton mort ne se répare pas tout seul, et personne ne lit les journaux. */
  alerter(sujet: string, message: string): void;
}

export interface BilanSuivi {
  espaces: number;
  campagnes: number;
  jetonsRejetes: number;
}

/**
 * RELIT CHEZ META TOUTES LES CAMPAGNES À SUIVRE, espace par espace.
 *
 * 🔴 ISOLÉ PAR ESPACE, et c'est ce qui rend le balayage utile à une flotte. Un client dont le jeton est mort
 * ne doit pas empêcher les dix-neuf autres d'avoir leurs chiffres. C'est le même motif que l'isolation par
 * message du webhook, et il a la même raison : le lot appartient à plusieurs personnes.
 *
 * 🔴 LES DEUX LECTURES SONT INDÉPENDANTES. La dépense peut échouer quand le statut passe, et l'inverse.
 * Les enchaîner dans un seul `try` ferait perdre le statut d'une campagne parce que ses statistiques
 * n'étaient pas prêtes, ce qui est le cas NORMAL d'une campagne qui vient d'être publiée.
 *
 * ⚠️ NE LÈVE JAMAIS : son appelant est un `setInterval`, et une exception qui remonte tuerait le balayage
 * jusqu'au prochain redémarrage du worker.
 */
export async function balayerLesPubs(deps: SuiviPubsDeps): Promise<BilanSuivi> {
  const bilan: BilanSuivi = { espaces: 0, campagnes: 0, jetonsRejetes: 0 };
  let espaces: string[];
  try {
    espaces = await deps.espacesASuivre();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('suivi des publicités : impossible de lister les espaces :', message(err));
    return bilan;
  }

  for (const tenantId of espaces) {
    try {
      const campagnes = await deps.campagnesASuivre(tenantId);
      // ⚠️ AUCUN APPEL À META quand il n'y a rien à suivre. Sans ce retour, un espace connecté sans
      // publicité publiée consommerait deux appels toutes les quinze minutes, pour rien.
      if (campagnes.length === 0) continue;
      const jeton = await deps.jeton(tenantId);
      if (jeton === null) continue;
      bilan.espaces += 1;

      const [etats, depenses] = await Promise.all([
        lireOuRien(() => deps.lireCampagnes(campagnes, jeton), 'statuts', tenantId, deps),
        lireOuRien(() => deps.lireDepenses(campagnes, jeton), 'dépenses', tenantId, deps),
      ]);

      // 🔴 UN JETON REJETÉ SE RETIENT UNE FOIS, PAS DEUX. Les deux lectures échouent ensemble quand le jeton
      // est mort : marquer et alerter dans chacune produirait deux alertes identiques toutes les quinze
      // minutes, ce qui est le meilleur moyen de faire ignorer la seule qui compte.
      if (etats.jetonRefuse || depenses.jetonRefuse) {
        bilan.jetonsRejetes += 1;
        await deps.marquerJetonRejete(tenantId);
        deps.alerter('pubs-jeton', `connexion publicitaire refusée par Meta pour l’espace ${tenantId} : le suivi s’arrête, le routage des leads continue`);
        continue;
      }

      for (const campagneId of campagnes) {
        const etat = etats.valeur?.get(campagneId) ?? null;
        const depense = depenses.valeur?.get(campagneId) ?? null;
        // ⚠️ ON ÉCRIT MÊME QUAND LES DEUX SONT NULS, et c'est délibéré : `lu_le` avance, donc le balayage
        // suivant ne recommence pas par la même campagne, et l'écran peut dire « relu il y a 3 minutes,
        // Meta n'a encore rien » plutôt que « jamais lu ».
        await deps.noterSuivi(tenantId, campagneId, { etat, depense });
        bilan.campagnes += 1;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`suivi des publicités : espace ${tenantId} ignoré :`, message(err));
    }
  }
  return bilan;
}

/**
 * Une des deux lectures, dont l'échec ne doit pas emporter l'autre.
 *
 * ⚠️ ELLE DISTINGUE « JETON REFUSÉ » DE « PANNE », et c'est la différence entre « reconnectez-vous » et
 * « réessayez » à l'écran. Elle se lit sur le CODE de Meta, jamais sur la phrase : un message se reformule,
 * et une garde qui lit une phrase casse en silence le jour où Meta la réécrit.
 */
async function lireOuRien<T>(
  appel: () => Promise<T>,
  quoi: string,
  tenantId: string,
  deps: SuiviPubsDeps,
): Promise<{ valeur: T | null; jetonRefuse: boolean }> {
  try {
    return { valeur: await appel(), jetonRefuse: false };
  } catch (err) {
    if (deps.estJetonRefuse(err)) return { valeur: null, jetonRefuse: true };
    // eslint-disable-next-line no-console
    console.warn(`suivi des publicités : ${quoi} non relus pour l’espace ${tenantId} :`, message(err));
    return { valeur: null, jetonRefuse: false };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'erreur inconnue';
}
