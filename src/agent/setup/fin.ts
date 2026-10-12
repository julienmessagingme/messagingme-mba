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
}

export const TITRE_FIN = 'Pour finir :';
/** Le bouton qui écrit la proposition dans les onglets, tel que la console l'affiche. */
export const BOUTON_ENREGISTRER = 'Enregistrer';

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
      out.push(`Scénarios : préparez le scénario à lancer pour « ${b.moment} ».`);
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
