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

/**
 * Le scénario que le client désigne : celui dont le nom est sa réponse, sinon le SEUL dont le nom est contenu dans sa
 * réponse (« lancer le scénario SMATIS Devis (flow) »), sinon le SEUL dont le nom contient sa réponse (« devis »).
 * Deux candidats à la même étape : aucun, on ne devine pas lequel.
 */
export function scenarioDuMoyen(moyen: string, scenarios: readonly ScenarioEnLigne[]): ScenarioEnLigne | null {
  const dit = normaliser(moyen);
  if (dit === '') return null;
  const avecNom = scenarios.map((s) => ({ s, n: normaliser(s.nom) })).filter((x) => x.n !== '');
  for (const correspond of [
    (n: string) => n === dit,
    (n: string) => dit.includes(n),
    (n: string) => n.includes(dit),
  ]) {
    const trouves = avecNom.filter((x) => correspond(x.n));
    if (trouves.length === 1) return trouves[0]!.s;
    if (trouves.length > 1) return null;
  }
  return null;
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
    .replace(/^(le|un|ce|notre|votre)\s+(client|contact|prospect|visiteur)\s+/i, '')
    .replace(/^(qu'il|qu’il|il)\s+/i, '')
    .replace(/[.!?\s]+$/, '');
  return sans === '' ? moment.trim() : sans;
}
