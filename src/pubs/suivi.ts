import type { DepensePub, EtatCampagneMeta } from '../meta/pubs-creation';
import type { GestesConnexionPub } from './connexion';

/**
 * Le balayage du suivi des publicités : toutes les quinze minutes, on relit chez Meta ce que les campagnes
 * publiées sont devenues. IO injectée.
 *
 * On lit au lieu d'écouter : les webhooks de compte publicitaire ne signalent pas tous les passages de
 * statut, l'écran afficherait « en revue » une pub refusée. La cadence reste très en deçà du plafond du
 * niveau « Limited ». Le routage ne dépend jamais de ce balayage : il ne lit que nos tables, les leads
 * continuent d'être routés quand Meta est muet.
 */

/** Ce que le balayage sait faire. Chaque méthode est étroite, pour qu'un faux tienne en quelques lignes. */
export interface SuiviPubsDeps {
  publicites: {
    /** Les espaces qui ont une connexion publicitaire et au moins une publicité à suivre. */
    espacesASuivre(): Promise<string[]>;
    /** Les campagnes de cet espace qu'il faut relire. Vide = rien à faire, aucun appel à Meta. */
    campagnesASuivre(tenantId: string): Promise<string[]>;
  };
  /** Accès facultatif : plus de connexion entre-temps = cet espace est simplement sauté. */
  acces: Pick<GestesConnexionPub, 'siConnecte'>;
  /** Les lectures chez Meta. */
  meta: {
    lireCampagnes(campagneIds: readonly string[], jeton: string): Promise<Map<string, EtatCampagneMeta>>;
    lireDepenses(campagneIds: readonly string[], jeton: string): Promise<Map<string, DepensePub>>;
  };
  /** Écrit ce que Meta a rendu, et l'heure de lecture. */
  noterSuivi(tenantId: string, campagneId: string, v: {
    etat: EtatCampagneMeta | null; depense: DepensePub | null;
  }): Promise<void>;
  /** Le module d'accès a déjà mémorisé le refus ; le suivi le reconnaît encore pour son bilan et son alerte. */
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
 * Relit chez Meta toutes les campagnes à suivre, espace par espace. Isolé par espace : un jeton mort ne prive
 * pas les autres clients de leurs chiffres. Les deux lectures (statut, dépense) sont indépendantes : des
 * statistiques pas encore prêtes, cas normal d'une campagne neuve, ne font pas perdre son statut. Ne lève
 * jamais : son appelant est un `setInterval`.
 */
export async function balayerLesPubs(deps: SuiviPubsDeps): Promise<BilanSuivi> {
  const bilan: BilanSuivi = { espaces: 0, campagnes: 0, jetonsRejetes: 0 };
  let espaces: string[];
  try {
    espaces = await deps.publicites.espacesASuivre();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('suivi des publicités : impossible de lister les espaces :', message(err));
    return bilan;
  }

  for (const tenantId of espaces) {
    try {
      const campagnes = await deps.publicites.campagnesASuivre(tenantId);
      // Aucun appel à Meta quand il n'y a rien à suivre.
      if (campagnes.length === 0) continue;
      const utilisation = await deps.acces.siConnecte(tenantId, async (appelerMeta) => {
        const [etats, depenses] = await Promise.all([
          lireOuRien(() => appelerMeta((jeton) => deps.meta.lireCampagnes(campagnes, jeton)), 'statuts', tenantId, deps),
          lireOuRien(() => appelerMeta((jeton) => deps.meta.lireDepenses(campagnes, jeton)), 'dépenses', tenantId, deps),
        ]);
        return { etats, depenses };
      });
      if (!utilisation.connecte) continue;
      bilan.espaces += 1;
      const { etats, depenses } = utilisation.valeur;

      // L'accès central marque un jeton rejeté une seule fois, même si les deux lectures échouent ensemble.
      // Le suivi agrège aussi l'alerte : deux alertes identiques feraient ignorer la seule qui compte.
      if (etats.jetonRefuse || depenses.jetonRefuse) {
        bilan.jetonsRejetes += 1;
        deps.alerter('pubs-jeton', `connexion publicitaire refusée par Meta pour l’espace ${tenantId} : le suivi s’arrête, le routage des leads continue`);
        continue;
      }

      for (const campagneId of campagnes) {
        const etat = etats.valeur?.get(campagneId) ?? null;
        const depense = depenses.valeur?.get(campagneId) ?? null;
        // On écrit même quand les deux sont nuls : `lu_le` avance, et l'écran peut dire « relu il y a 3 minutes,
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
 * Une des deux lectures, dont l'échec n'emporte pas l'autre. Elle distingue « jeton refusé »
 * (« reconnectez-vous ») de « panne » (« réessayez ») sur le code de Meta, jamais sur la phrase, qui se
 * reformule.
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
