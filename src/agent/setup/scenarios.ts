import type { Bascule } from './couverture';

/**
 * LE SCÉNARIO D'UN MOMENT, CHOISI DANS L'ENTRETIEN ET POSÉ PAR « ENREGISTRER » (décision de Julien du 2026-10-12, plan
 * `docs/superpowers/plans/2026-10-12-scenario-dans-l-entretien.md`). Le client dit, pour un moment, quel scénario
 * lancer ; le serveur rapproche sa réponse d'un scénario EN LIGNE de l'espace, et le diff propose l'outil
 * « Lancer un scénario » qui le vise. 🔴 La cible vient de la liste réelle, jamais du modèle : un nom qui ne désigne
 * pas un seul scénario sans ambiguïté ne propose rien, et le bloc « Pour finir » dit alors de le poser à la main.
 */
export interface ScenarioEnLigne { id: string; nom: string }

export interface ScenarioAPoser { workflowId: string; nom: string; moment: string }

/** Casse, accents, guillemets et espaces mis de côté : « SMATIS devis (flow) » et « smatis Devis (Flow) » se valent. */
function normaliser(texte: string): string {
  return texte.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[«»"“”'’]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** `mot` figure dans `texte` en mots entiers : « devis » est dans « un devis », pas dans « devisage ». Textes normalisés. */
function contientEnMots(texte: string, mot: string): boolean {
  const echappe = mot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${echappe}($|[^a-z0-9])`).test(texte);
}

/** En deçà, une réponse (« ok », « rien », « si ») se retrouve dans trop de noms pour en désigner un. */
const REPONSE_MIN_POUR_UN_FRAGMENT = 4;

/**
 * Le scénario que le client désigne, en mots entiers :
 *  1. celui dont le nom EST sa réponse ;
 *  2. sinon celui dont le nom est CONTENU dans sa réponse (« lancer le scénario SMATIS Devis (flow) ») ; plusieurs
 *     noms contenus, on garde celui qui contient les autres (« SMATIS Devis (flow) » et « Devis » : le premier) ;
 *  3. sinon, pour une réponse d'au moins quatre caractères, le SEUL dont le nom contient sa réponse (« devis »).
 * Deux candidats qui restent : aucun, on ne devine pas lequel.
 */
export function scenarioDuMoyen(moyen: string, scenarios: readonly ScenarioEnLigne[]): ScenarioEnLigne | null {
  const dit = normaliser(moyen);
  if (dit === '') return null;
  const avecNom = scenarios.map((s) => ({ s, n: normaliser(s.nom) })).filter((x) => x.n !== '');
  const exacts = avecNom.filter((x) => x.n === dit);
  if (exacts.length > 0) return exacts.length === 1 ? exacts[0]!.s : null;
  const contenus = avecNom.filter((x) => contientEnMots(dit, x.n));
  if (contenus.length > 0) {
    // Un nom contenu dans un autre nom contenu n'est que son fragment : il ne compte pas.
    const englobants = contenus.filter((x) => !contenus.some((y) => y !== x && y.n !== x.n && contientEnMots(y.n, x.n)));
    return englobants.length === 1 ? englobants[0]!.s : null;
  }
  if (dit.length < REPONSE_MIN_POUR_UN_FRAGMENT) return null;
  const contenants = avecNom.filter((x) => contientEnMots(x.n, dit));
  return contenants.length === 1 ? contenants[0]!.s : null;
}

/** Un moment confié à un scénario reconnu ; `dejaVise` : un outil `lancer_scenario` de l'agent le vise déjà. */
export interface ScenarioDuMoment { moment: string; workflowId: string; nom: string; dejaVise: boolean }

/**
 * Les moments « scénario » dont le moyen désigne un scénario en ligne. Ceux qui n'y sont pas restent à poser à la main,
 * et le bloc « Pour finir » le dit (`etapesDeFin`). `vises` : les `workflowId` des outils `lancer_scenario` de l'agent.
 */
export function scenariosDesMoments(
  bascules: readonly Bascule[], scenarios: readonly ScenarioEnLigne[], vises: ReadonlySet<string>,
): ScenarioDuMoment[] {
  const out: ScenarioDuMoment[] = [];
  for (const b of bascules) {
    if (b.action !== 'scenario' || !b.moyen || b.moyen.trim() === '') continue;
    const s = scenarioDuMoyen(b.moyen, scenarios);
    if (s) out.push({ moment: b.moment, workflowId: s.id, nom: s.nom, dejaVise: vises.has(s.id) });
  }
  return out;
}

/**
 * Les outils « Lancer un scénario » à proposer : un par scénario reconnu (le premier moment qui le cite donne la
 * description), sans ceux que l'agent vise déjà.
 */
export function scenariosAPoser(desMoments: readonly ScenarioDuMoment[]): ScenarioAPoser[] {
  const out: ScenarioAPoser[] = [];
  for (const m of desMoments) {
    if (m.dejaVise || out.some((x) => x.workflowId === m.workflowId)) continue;
    out.push({ workflowId: m.workflowId, nom: m.nom, moment: m.moment });
  }
  return out;
}

/**
 * Le moyen d'un moment dont le client a décrit la suite sans que le modèle la note (route `POST /setup`, second passage
 * du point) : un texte FIXE, qui ferme le point sans recopier le message du client dans la consigne du tour, et qui ne
 * désigne aucun scénario.
 */
export const MOYEN_DECRIT_PAR_LE_CLIENT = 'décrit par le client dans la conversation';

/** La clé de la ligne de diff d'un scénario à poser : la console s'en sert pour savoir si le client l'a gardée. */
export const champScenario = (workflowId: string): string => `scenario.${workflowId}`;

/**
 * La situation qui complète « Appelle cet outil dès que le contact … », la consigne que l'onglet Outils pose sur tout
 * outil « Lancer un scénario » (`TEXTES_AGENT_PAR_TYPE.scenario`, `web/lib/mba-outils.ts`) et que la console reprend à
 * l'enregistrement : le moment, sans son « quand le client » de tête ni sa ponctuation finale. Corrigeable dans le diff.
 */
export function situationDuMoment(moment: string): string {
  const sans = moment.trim()
    .replace(/^(quand|lorsque|si|dès que|des que)\s+/i, '')
    .replace(/^(l['’]|(le|la|un|une|ce|cette|notre|votre)\s+)(client|cliente|contact|prospect|visiteur|utilisateur|utilisatrice|personne)\s+/i, '')
    .replace(/^(qu'il|qu’il|il)\s+/i, '')
    .replace(/[.!?\s]+$/, '');
  return sans === '' ? moment.trim() : sans;
}
