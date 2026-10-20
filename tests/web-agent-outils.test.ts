import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BORNES_ACTION as BORNES_ACTION_ECRAN, CODE_CHAMP_ACTION_RE as CODE_CHAMP_ACTION_RE_ECRAN, HANDLER_DU_TYPE, MAX_NOM_OUTIL,
  TOUJOURS_LA, TYPES_CHAMP_ACTION as TYPES_CHAMP_ACTION_ECRAN, cibleDeLOutil, codeLibre, corpsDeLaCible, manqueDeLAction,
  normaliserCodeChamp, normaliserNomOutil, typeDuHandler,
  type CibleSaisieAgent,
  BORNES_ENCHAINEMENT as BORNES_ENCHAINEMENT_ECRAN, CLE_CHAMP_DEMANDE_RE as CLE_CHAMP_DEMANDE_RE_ECRAN,
  PARAM_DEJA_DEMANDE as PARAM_DEJA_DEMANDE_ECRAN, TYPES_ETAPE as TYPES_ETAPE_ECRAN, enchainementIrreversible, etapeVide,
  manqueDeLEnchainement, type EtapeSaisie, type TypeEtape,
  CLES_RESERVEES as CLES_RESERVEES_ECRAN, manqueDeLaQualification,
} from '../web/lib/agent-outils';
import { BORNES_ENCHAINEMENT, CLES_RESERVEES, CLE_CHAMP_DEMANDE_RE, PARAM_DEJA_DEMANDE } from '../src/agent/enchainement';
import { signeDuHandler } from '../web/lib/signes-outils';
import { BORNES_OUTIL } from '../web/lib/mba-outils';
import {
  BORNES_ACTION, BORNES_CIBLE, CODE_CHAMP_ACTION_RE, HANDLERS_A_CIBLE, OUTILS_MAISON, TYPES_CHAMP_ACTION,
} from '../src/agent/outils-maison';
import { lireCibleSaisie, nomTechniqueDAction } from '../src/agent/reglages';

/**
 * Le nom exposé d'un outil, normalisé côté navigateur, et sa parité avec ce que le serveur accepte.
 *
 * Les deux builds ne partagent aucun module : une règle recopiée finit par diverger, et le champ laisse alors
 * passer un nom que la route refuse en 400, c'est-à-dire une erreur technique pour une faute que l'écran
 * savait déjà. On ancre donc la normalisation SUR la règle du serveur, lue dans sa source.
 */

/** La règle telle que la route la pose, lue dans sa source : le schéma Zod n'exporte pas son motif. */
function motifServeur(): RegExp {
  const source = readFileSync(new URL('../src/http/agent-tools.ts', import.meta.url), 'utf8');
  const m = /const NOM = z\.string\(\)\.trim\(\)\.regex\((\/\^[^/]+\/)/.exec(source);
  expect(m, 'le motif du nom a changé de forme dans src/http/agent-tools.ts').not.toBeNull();
  return new RegExp(m![1]!.slice(1, -1));
}

describe('normaliserNomOutil', () => {
  it('🔴 tout ce qu’elle rend est ACCEPTÉ par le serveur', () => {
    const motif = motifServeur();
    for (const brut of [
      'Poser un tag', 'mba_terminer', 'ENVOYER LE BLOC', 'poser_tâg', 'écrire-variable',
      'a'.repeat(200), 'chercher   la   connaissance', 'outil#1', '_debut', 'fin_',
    ]) {
      const propre = normaliserNomOutil(brut);
      expect(propre, brut).toMatch(motif);
      expect(propre.length, brut).toBeLessThanOrEqual(MAX_NOM_OUTIL);
    }
  });

  it('retire les accents plutôt que de les remplacer par un tiret bas', () => {
    // « poser_tâg » doit devenir « poser_tag » : un filtre naïf sur l'alphabet rendrait « poser_ta_g », que
    // le client ne reconnaîtrait pas comme son nom.
    expect(normaliserNomOutil('poser_tâg')).toBe('poser_tag');
    expect(normaliserNomOutil('créer_rdv')).toBe('creer_rdv');
  });

  it('resserre les séparateurs et met en minuscules', () => {
    expect(normaliserNomOutil('Poser un tag')).toBe('poser_un_tag');
    expect(normaliserNomOutil('outil -- 2')).toBe('outil_2');
  });

  it('🔴 une saisie sans aucun caractère alphanumérique rend une chaîne VIDE', () => {
    // Et pas « _ », que la règle du serveur accepterait : le champ enregistrerait alors « _ » comme nom
    // d'outil exposé au modèle. Vide, l'écran garde le nom précédent, ce que fait le champ à la sortie.
    for (const brut of ['   ', '###', '---', '.', '  --  ']) {
      expect(normaliserNomOutil(brut), brut).toBe('');
    }
  });

  it('🔴 les noms par défaut du catalogue passent la règle du serveur', () => {
    const motif = motifServeur();
    for (const o of OUTILS_MAISON) {
      expect(o.nomDefaut, o.handler).toMatch(motif);
      // Et ils sont déjà normalisés : l'écran ne doit pas proposer de « corriger » un nom qu'il vient de créer.
      expect(normaliserNomOutil(o.nomDefaut), o.handler).toBe(o.nomDefaut);
    }
  });
});

/**
 * 🔴 L'ONGLET OUTILS PRÉSENTÉ COMME CELUI DE L'AGENT DE META (RC4) : ce que l'écran pose doit être ce que le serveur
 * accepte. Les deux builds ne partagent aucun module, donc chaque liste recopiée côté console est tenue ici contre sa
 * source serveur.
 */
describe('RC4 : la console et le catalogue serveur disent la même chose', () => {
  it('🔴 « Toujours là » = les outils du catalogue SANS cible, ni plus ni moins', () => {
    const sansCible = OUTILS_MAISON.map((o) => o.handler).filter((h) => !(HANDLERS_A_CIBLE as readonly string[]).includes(h));
    expect([...TOUJOURS_LA].sort()).toEqual(sansCible.sort());
  });

  it('🔴 les cartes à cible posent exactement les handlers à cible du serveur', () => {
    expect(Object.values(HANDLER_DU_TYPE).sort()).toEqual([...HANDLERS_A_CIBLE].sort());
    for (const h of HANDLERS_A_CIBLE) expect(typeDuHandler(h), h).not.toBeNull();
  });

  it('🔴 l’action : les types de champ, les bornes et l’alphabet du code de l’écran sont ceux du serveur', () => {
    expect([...TYPES_CHAMP_ACTION_ECRAN]).toEqual([...TYPES_CHAMP_ACTION]);
    const { parAgent: _parAgent, texte: _texte, ...bornesDeLaCible } = BORNES_ACTION;
    expect({ ...BORNES_ACTION_ECRAN }).toEqual(bornesDeLaCible);
    expect(CODE_CHAMP_ACTION_RE_ECRAN.source).toBe(CODE_CHAMP_ACTION_RE.source);
  });

  it('🔴 ce que l’écran envoie pour une action est ce que le serveur accepte', () => {
    const saisie = {
      type: 'action' as const, nom: ' Résiliation ', consigne: 'Dis-lui que c’est noté.',
      champs: [
        { code: 'contrat', libelle: ' Numéro de contrat ', type: 'texte' as const, valeurs: [] },
        { code: 'motif', libelle: 'Motif', type: 'liste' as const, valeurs: ['prix', ' ', 'autre'] },
      ],
    };
    expect(manqueDeLAction(saisie)).toBeNull();
    const lue = lireCibleSaisie('declencher_action', corpsDeLaCible(saisie));
    expect(lue).toEqual({
      handler: 'declencher_action', nom: 'Résiliation', consigne: 'Dis-lui que c’est noté.',
      champs: [
        { code: 'contrat', libelle: 'Numéro de contrat', type: 'texte' },
        { code: 'motif', libelle: 'Motif', type: 'liste', valeurs: ['prix', 'autre'] },
      ],
    });
    // Relue depuis le binding, l'action redonne la même saisie (au rognage près) : l'écran de modification ne perd rien.
    expect(cibleDeLOutil(lue as unknown as Record<string, unknown>)).toEqual({
      type: 'action', nom: 'Résiliation', consigne: 'Dis-lui que c’est noté.',
      champs: [
        { code: 'contrat', libelle: 'Numéro de contrat', type: 'texte', valeurs: [] },
        { code: 'motif', libelle: 'Motif', type: 'liste', valeurs: ['prix', 'autre'] },
      ],
    });
  });

  it('le code d’un champ, tiré de son libellé, est un code que le serveur accepte, et libre dans la liste', () => {
    expect(normaliserCodeChamp('Numéro de contrat')).toBe('numero_de_contrat');
    expect(normaliserCodeChamp('2e adresse !')).toBe('e_adresse');
    expect(normaliserCodeChamp('###')).toBe('');
    // Tapé dans le champ du code, le tiret bas final reste : « ref_ » mène à « ref_client ».
    expect(normaliserCodeChamp('ref_', true)).toBe('ref_');
    expect(normaliserCodeChamp('ref_')).toBe('ref');
    for (const brut of ['Numéro de contrat', 'É-mail', 'x'.repeat(80)]) {
      expect(CODE_CHAMP_ACTION_RE.test(normaliserCodeChamp(brut)), brut).toBe(true);
    }
    expect(codeLibre('motif', ['motif', 'motif_2'])).toBe('motif_3');
    expect(codeLibre('', [])).toBe('champ');
    // Le nom technique d'une action neuve posée par Claude Code suit la même règle d'unicité.
    expect(nomTechniqueDAction('Résiliation', [])).toBe('action_resiliation');
    expect(nomTechniqueDAction('Résiliation', ['action_resiliation'])).toBe('action_resiliation_2');
    expect(nomTechniqueDAction('###', [])).toBe('action_client');
  });

  it('une action incomplète est dite avant le serveur : nom, libellé, liste sans valeurs, code en double', () => {
    const ok = { type: 'action' as const, nom: 'A', consigne: '', champs: [] };
    expect(manqueDeLAction(ok)).toBeNull();
    expect(manqueDeLAction({ ...ok, nom: ' ' })).not.toBeNull();
    const champ = { code: 'c', libelle: 'C', type: 'texte' as const, valeurs: [] };
    expect(manqueDeLAction({ ...ok, champs: [{ ...champ, libelle: '' }] })).not.toBeNull();
    expect(manqueDeLAction({ ...ok, champs: [{ ...champ, type: 'liste' }] })).not.toBeNull();
    expect(manqueDeLAction({ ...ok, champs: [champ, champ] })).not.toBeNull();
    expect(manqueDeLAction({ ...ok, champs: [{ ...champ, code: 'Code' }] })).not.toBeNull();
  });

  it('chaque outil du catalogue a son dessin : aucune ligne sans icône', () => {
    for (const o of OUTILS_MAISON) expect(signeDuHandler(o.handler), o.handler).not.toBeNull();
  });

  it('🔴 les bornes que l’écran applique sont celles de la cible côté serveur', () => {
    expect({ tag: BORNES_OUTIL.tag, champ: BORNES_OUTIL.champ, valeur: BORNES_OUTIL.valeur, valeurs: BORNES_OUTIL.valeurs }).toEqual({ ...BORNES_CIBLE });
  });

  it('🔴 ce que l’écran envoie comme cible est ACCEPTÉ par le serveur, et relu à l’identique', () => {
    const saisies: CibleSaisieAgent[] = [
      { type: 'tag', tag: '  rdv_pris ' },
      { type: 'champ', champ: 'statut', valeurs: ['client', 'prospect'] },
      { type: 'bloc', workflowId: '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b', code: 'nod_t1_01HZX5Y6Z7A8B9C0D1E2F3G4H5' },
      { type: 'scenario', workflowId: '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b' },
    ];
    for (const c of saisies) {
      const handler = HANDLER_DU_TYPE[c.type];
      const lue = lireCibleSaisie(handler, corpsDeLaCible(c));
      expect(lue, c.type).not.toBeNull();
      // Relue par l'écran depuis le `binding` que le serveur écrit : la même cible, rognée.
      expect(cibleDeLOutil({ ...lue! }), c.type).toEqual(c.type === 'tag' ? { type: 'tag', tag: 'rdv_pris' } : c);
    }
  });

  it('un binding sans cible se relit en cible VIDE, que l’écran montre « à choisir » au lieu de planter', () => {
    expect(cibleDeLOutil({ handler: 'poser_tag' })).toEqual({ type: 'tag', tag: '' });
    expect(cibleDeLOutil({ handler: 'ecrire_variable', valeurs: [1, 'a'] })).toEqual({ type: 'champ', champ: '', valeurs: ['a'] });
    expect(cibleDeLOutil({ handler: 'terminer' })).toBeNull();
  });
});

describe('outil enchaîné : la console et le serveur disent la même chose (2026-10-20)', () => {
  it('mêmes types d’étapes, mêmes bornes, même alphabet de champ, même paramètre réservé', () => {
    expect([...TYPES_ETAPE_ECRAN]).toEqual(['demander', 'valeur', 'tag', 'urgent', 'bloc', 'scenario', 'transferer']);
    expect({ ...BORNES_ENCHAINEMENT_ECRAN }).toEqual({ ...BORNES_ENCHAINEMENT });
    expect(CLE_CHAMP_DEMANDE_RE_ECRAN.source).toBe(CLE_CHAMP_DEMANDE_RE.source);
    expect(PARAM_DEJA_DEMANDE_ECRAN).toBe(PARAM_DEJA_DEMANDE);
    expect([...CLES_RESERVEES_ECRAN]).toEqual([...CLES_RESERVEES]);
  });

  const WF = '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b';
  const etape = (type: TypeEtape, over: Partial<EtapeSaisie> = {}): EtapeSaisie => ({ ...etapeVide(type), ...over });
  const Q = etape('demander', { champ: 'prenom', question: 'ton prénom' });
  const TAG = etape('tag', { tag: 'lead_chaud' });
  const BLOC = etape('bloc', { workflowId: WF, code: 'nod_t1_01HZX5Y6Z7A8B9C0D1E2F3G4H5' });
  const SC = etape('scenario', { workflowId: WF });
  const TR = etape('transferer');

  /** 🔴 La parité qui compte : ce que l'écran laisse partir, le serveur l'accepte, et inversement. */
  it.each([
    ['le parcours Pigier', [Q, TAG, SC], true],
    ['un ordre libre avant les envois', [TAG, Q, etape('urgent'), BLOC, SC], true],
    ['un scénario qui ne ferme pas la marche', [SC, TAG], false],
    ['un bloc avant une question', [BLOC, Q], false],
    ['deux questions sur le même champ', [Q, { ...Q, question: 'encore' }], false],
    ['aucune étape', [], false],
    ['des questions puis le transfert à l’équipe', [Q, TAG, TR], true],
    ['un transfert qui ne ferme pas la marche', [TR, TAG], false],
    ['un scénario ET un transfert', [Q, SC, TR], false],
    ['une question sur un champ réservé (la phrase de l’agent)', [{ ...Q, champ: 'message' }, TR], false],
  ] as const)('%s', (_nom, etapes, accepte) => {
    const c: CibleSaisieAgent = { type: 'enchainement', etapes: [...etapes] };
    expect(manqueDeLEnchainement(c) === null).toBe(accepte);
    expect(lireCibleSaisie('enchainer', corpsDeLaCible(c)) !== null).toBe(accepte);
  });

  it('une cible enchaînée relue à l’écran repart à l’identique', () => {
    const c: CibleSaisieAgent = { type: 'enchainement', etapes: [{ ...Q, valeurs: ['A', 'B'] }, TAG, SC] };
    const binding = { handler: 'enchainer', ...corpsDeLaCible(c) };
    expect(cibleDeLOutil(binding)).toEqual(c);
    expect(typeDuHandler('enchainer')).toBe('enchainement');
    expect(signeDuHandler('enchainer')).toBe('scenario');
  });

  it('une étape de transfert relue à l’écran repart à l’identique', () => {
    const c: CibleSaisieAgent = { type: 'enchainement', etapes: [Q, TR] };
    expect(cibleDeLOutil({ handler: 'enchainer', ...corpsDeLaCible(c) })).toEqual(c);
  });

  it('irréversible côté écran exactement quand un bloc ou un scénario part', () => {
    expect(enchainementIrreversible([Q, TAG])).toBe(false);
    expect(enchainementIrreversible([Q, BLOC])).toBe(true);
    expect(enchainementIrreversible([Q, SC])).toBe(true);
    expect(enchainementIrreversible([Q, TR])).toBe(false);
  });
});

describe('« Qualifier et transférer » : la console et le serveur disent la même chose (2026-10-20)', () => {
  const Q = (champ: string, over: Partial<EtapeSaisie> = {}): EtapeSaisie => ({ ...etapeVide('demander'), champ, question: `ton ${champ}`, ...over });

  it.each([
    ['les quatre questions de Pigier', [Q('prenom'), Q('nom'), Q('campus', { valeurs: ['Pau', 'Bayonne'] }), Q('formation_souhaitee')], true],
    ['une seule question', [Q('prenom')], true],
    ['aucune question', [], false],
    ['deux questions sur le même champ', [Q('prenom'), Q('prenom', { question: 'encore' })], false],
    ['une question sans texte', [Q('prenom', { question: ' ' })], false],
    ['une question sur un champ réservé', [Q('deja_demande')], false],
  ] as const)('%s', (_nom, etapes, accepte) => {
    const c: CibleSaisieAgent = { type: 'qualification', etapes: [...etapes] };
    expect(manqueDeLaQualification(c) === null).toBe(accepte);
    expect(lireCibleSaisie('qualifier_transferer', corpsDeLaCible(c)) !== null).toBe(accepte);
  });

  it('le corps envoyé ne porte que des questions, et se relit à l’identique', () => {
    const c: CibleSaisieAgent = { type: 'qualification', etapes: [Q('prenom'), Q('campus', { valeurs: ['Pau'] })] };
    expect(corpsDeLaCible(c)).toEqual({
      questions: [{ champ: 'prenom', question: 'ton prenom', valeurs: [] }, { champ: 'campus', question: 'ton campus', valeurs: ['Pau'] }],
    });
    expect(cibleDeLOutil({ handler: 'qualifier_transferer', ...corpsDeLaCible(c) })).toEqual(c);
    expect(typeDuHandler('qualifier_transferer')).toBe('qualification');
    expect(signeDuHandler('qualifier_transferer')).toBe('humain');
  });
});
