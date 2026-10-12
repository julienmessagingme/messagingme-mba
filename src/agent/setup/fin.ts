import type { Bascule } from './couverture';

/**
 * CE QU'IL RESTE À FAIRE QUAND L'ENTRETIEN DE CONSTRUCTION SE FERME, écrit par le serveur (décision de Julien,
 * 2026-10-12). Le dernier tour ne disait rien de la suite : le client lisait « C'est noté : vouvoiement. » et ne savait
 * ni qu'il fallait enregistrer la proposition, ni où importer son site, ni comment allumer l'agent. Le calcul part de
 * l'état réel, jamais du modèle : une étape qu'un modèle oublie est une étape que le client ne fait pas.
 */
export interface EntreeFin {
  /** La proposition montrée porte au moins un changement : il faut l'enregistrer. */
  aAppliquer: boolean;
  /** L'adresse donnée au point `connaissance`, si l'entretien en a retenu une. */
  connaissanceUrl: string | null;
  /** Combien de fiches de connaissance l'agent a déjà. */
  fichesDeConnaissance: number;
  bascules: readonly Bascule[];
  /** Ce qui est branché sur cet agent aujourd'hui, par origine. */
  outilsApi: number;
  outilsMcp: number;
  /** Le modèle de l'agent, s'il est connu. */
  modele: string | null;
  /** L'import du site donné vient de partir, sur ce même tour : ses fiches arrivent, il reste à les relire. */
  importEnCours?: boolean;
  /**
   * Les moments « scénario » dont le scénario est reconnu (`scenariosDesMoments`) : l'outil est proposé dans le diff,
   * ou l'agent l'a déjà. Un moment « scénario » absent d'ici est à poser à la main.
   */
  scenarios?: ReadonlyArray<{ moment: string; nom: string; dejaVise: boolean }>;
}

export const TITRE_FIN = 'Pour finir :';
/** Le bouton qui écrit la proposition dans les onglets, tel que la console l'affiche. */
export const BOUTON_ENREGISTRER = 'Enregistrer';
/** La case d'autonomie d'une action irréversible, telle que l'onglet Outils l'affiche (`AutonomieOutil`). */
export const CASE_AUTONOMIE = 'Autoriser l’agent à faire ça seul';

export function etapesDeFin(e: EntreeFin): string[] {
  const out: string[] = [];
  if (e.aAppliquer) {
    // Le libellé du bouton de la console (`web/components/AgentConstruction.tsx`), tenu par
    // `tests/agent-setup-fin.test.ts` : « Appliquer » a été écrit ici le premier jour, alors que le bouton s'appelle
    // « Enregistrer » (Julien, 2026-10-12).
    out.push('Relisez la proposition ci-dessous : chaque ligne se garde, se corrige ou se jette. Cliquez ensuite sur '
      + `« ${BOUTON_ENREGISTRER} » : rien n’est écrit dans les onglets tant que vous ne l’avez pas fait.`);
  }
  if (e.importEnCours && e.connaissanceUrl) {
    out.push(`Base de connaissance : relisez les fiches importées de ${e.connaissanceUrl} une fois l’import fini.`);
  } else if (e.fichesDeConnaissance === 0) {
    out.push(e.connaissanceUrl
      ? `Base de connaissance : importez les pages de ${e.connaissanceUrl}.`
      : 'Base de connaissance : ajoutez des fiches ou un document, sinon l’agent transmettra toutes les questions '
        + 'de fond.');
  }
  for (const b of e.bascules) {
    if (b.action === 'outil_api' && e.outilsApi === 0) {
      out.push(`Outils : branchez le connecteur API pour « ${b.moment} » (menu Tools > Connecteurs API).`);
    } else if (b.action === 'outil_mcp' && e.outilsMcp === 0) {
      out.push(`Outils : branchez l’outil MCP pour « ${b.moment} » (menu Tools > Connecteurs MCP).`);
    } else if (b.action === 'scenario') {
      // L'outil naît éteint, comme tout outil ajouté (route `POST .../tools`), et « Lancer un scénario » est une action
      // irréversible : sans la case d'autonomie, chaque appel est refusé. Sans ces deux gestes, « Enregistrer » pose un
      // outil que l'agent n'appelle jamais. Les libellés sont ceux de l'écran (`AutonomieOutil`, `LigneOutilAgent`).
      const reconnu = e.scenarios?.find((s) => s.moment === b.moment);
      out.push(!reconnu
        ? `Outils : pour « ${b.moment} », onglet « Outils », « Ajouter un outil », « Lancer un scénario » : choisissez `
          + `le scénario, cochez « ${CASE_AUTONOMIE} », puis allumez l’outil.`
        : reconnu.dejaVise
          ? `Outils : l’outil qui lance « ${reconnu.nom} » est déjà là ; vérifiez qu’il est allumé et que `
            + `« ${CASE_AUTONOMIE} » est coché (onglet « Outils », « Modifier »).`
          : `Outils : après « ${BOUTON_ENREGISTRER} », l’outil qui lance « ${reconnu.nom} » naît éteint : onglet `
            + `« Outils », « Modifier » sur sa ligne, cochez « ${CASE_AUTONOMIE} », puis allumez-le.`);
    }
  }
  out.push(e.modele
    ? `Modèle : l’agent utilise ${e.modele}. Changez-le dans l’onglet « Modèle » si besoin.`
    : 'Modèle : vérifiez le modèle de l’agent dans l’onglet « Modèle ».');
  out.push('Tester : parlez-lui dans l’onglet « Tester », il vous répond comme à un client.');
  out.push('Activer : quand le test vous convient, cliquez sur « Activer » en haut de la fiche.');
  return out;
}

/** Le bloc ajouté au dernier message de l'entretien, étapes numérotées. */
export function blocDeFin(e: EntreeFin): string {
  return [TITRE_FIN, ...etapesDeFin(e).map((t, i) => `${i + 1}. ${t}`)].join('\n');
}
