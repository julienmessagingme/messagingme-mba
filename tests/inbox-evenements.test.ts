import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CAUSE_CLE_API, CAUSE_HORS_COMPTE, CAUSE_MAX, auteurDeLEnvoi, automatique, colonnesAuteur, type AuteurDuChangement,
} from '../src/inbox/evenements';
import { assignerReponse, type AssignationDeps, type CampagneAssignante } from '../src/inbox/assignation-campagne';
import { bancDuFil } from './banc-du-fil';

/**
 * LE JOURNAL DES ÉVÉNEMENTS D'UNE CONVERSATION (migration 0192, panneau Détail de l'Inbox), ce qui se vérifie
 * sans base. Ce que les requêtes écrivent vraiment, et quand elles n'écrivent rien : le test d'intégration
 * `tests/integration/conversation-evenements.integration.test.ts`, en CI.
 */

const UUID = '11111111-1111-4111-8111-111111111111';

describe('qui a fait le geste : un collaborateur, ou une cause', () => {
  it('un identifiant de collaborateur passe tel quel', () => {
    expect(colonnesAuteur({ collaborateur: UUID })).toEqual({ acteur: UUID, cause: null });
  });

  it('🔴 un identifiant qui n’est pas un uuid devient null AVANT la base, et porte une CAUSE', () => {
    // Une clé d'API (`apikey:...`) ou l'identité d'observation de /ops, passée à `::uuid`, ferait échouer la
    // requête entière : c'est-à-dire le CHANGEMENT lui-même, pour une ligne de journal. Et sans cause, la ligne
    // n'aurait ni acteur ni cause, ce que la lecture réserve au collaborateur SUPPRIMÉ : une clé d'API s'affichait
    // « ancien collaborateur » (relecture du 2026-09-29).
    expect(colonnesAuteur({ collaborateur: 'apikey:abc' })).toEqual({ acteur: null, cause: CAUSE_CLE_API });
    expect(colonnesAuteur({ collaborateur: 'ops-observation' })).toEqual({ acteur: null, cause: CAUSE_HORS_COMPTE });
    expect(colonnesAuteur({ collaborateur: null })).toEqual({ acteur: null, cause: CAUSE_HORS_COMPTE });
  });

  it('une cause est bornée, jamais refusée : un nom de campagne trop long ne fait pas échouer l’assignation', () => {
    const longue = colonnesAuteur({ cause: automatique('campagne ' + 'x'.repeat(500)) }).cause ?? '';
    expect(longue.length).toBe(CAUSE_MAX);
    expect(longue.endsWith('…')).toBe(true);
    expect(colonnesAuteur({ cause: '   ' })).toEqual({ acteur: null, cause: null });
  });

  it('l’envoi qui prend le fil dit qui écrit : l’opérateur, ou la machine par sa cause', () => {
    expect(auteurDeLEnvoi('humain', UUID)).toEqual({ collaborateur: UUID });
    expect(auteurDeLEnvoi('api', null)).toEqual({ cause: 'automatique : envoi par l’API' });
    expect(auteurDeLEnvoi('mcp', null)).toEqual({ cause: 'automatique : envoi par un agent tiers (MCP)' });
  });
});

/**
 * 🔴 L'ÉVÉNEMENT S'ÉCRIT DANS LA MÊME REQUÊTE QUE LE CHANGEMENT. Deux requêtes laisseraient une fenêtre où l'un
 * existe sans l'autre. Garde structurelle, sur la source : chaque écriture de l'Inbox porte son `insert into
 * conversation_evenements`, et autant d'inserts que de requêtes (une requête séparée pour le journal ferait
 * passer le compte à deux requêtes pour un insert).
 */
describe('chaque écriture de l’Inbox porte son événement dans sa propre requête', () => {
  const source = readFileSync(resolve(__dirname, '../src/inbox/store.pg.ts'), 'utf8');
  /** Le corps d'une méthode, jusqu'à la méthode suivante. */
  const corps = (signature: string): string => {
    const i = source.indexOf(signature);
    expect(i, `méthode introuvable : ${signature}`).toBeGreaterThan(-1);
    const suite = source.slice(i + signature.length);
    const fin = suite.search(/\n {2}(?:private )?async [a-zA-Z]+\(/);
    return fin === -1 ? suite : suite.slice(0, fin);
  };
  const compte = (texte: string, motif: string): number => texte.split(motif).length - 1;

  it.each([
    'private async upsertConversationByWaId(',
    'async setAssigneeByWaId(',
    'async assignerSiLibre(',
    'async setControlOwner(',
    'async marquerEscalade(',
    'private async basculerRangement(',
    'async signalerConversation(',
    'async setAssignee(',
    'async prendreSiLibre(',
    'async ouvrirUneDemande(',
  ])('%s', (signature) => {
    const c = corps(signature);
    const requetes = compte(c, 'this.pool.query');
    expect(requetes, 'au moins une requête').toBeGreaterThan(0);
    expect(compte(c, 'insert into conversation_evenements'), 'un événement par requête, dans la requête').toBe(requetes);
  });

  it('« Archivé » et « Traité » passent par le même rangement, qui écrit l’événement', () => {
    expect(corps('async archiverConversation(')).toContain('this.basculerRangement(');
    expect(corps('async marquerTraitee(')).toContain('this.basculerRangement(');
  });

  /**
   * 🔴 A (décision de Julien du 2026-09-30) : « TRAITÉ » RELANCE LE DÉLAI DE REPRISE d'un fil de l'équipe, dans la même
   * requête ; l'archivage et le retrait de « Traité » n'y touchent pas. Le balayage et la remise « personne ne suit »
   * comptent donc depuis le plus tardif de la dernière réponse de l'équipe et de ce clic. Son effet en base :
   * `tests/integration/inbox-traite.integration.test.ts`. Vérifié dans les deux sens : `relance` vidée, ce cas échoue.
   */
  it('🔴 « Traité », et lui seul, relance le délai de reprise d’un fil que l’équipe tient', () => {
    const c = corps('private async basculerRangement(');
    expect(c).toContain("const relance = colonne === 'traitee_le'");
    expect(c).toContain("control_changed_at = case when $3::boolean and c.control_owner = 'app_human' then now() else c.control_changed_at end");
    expect(c).toMatch(/escaladee_le = case when \$3::boolean then null else c\.escaladee_le end\$\{relance\}/);
  });

  it('🔴 la demande ouverte par une réouverture ne vise qu’un fil que l’équipe tient encore', () => {
    expect(corps('async ouvrirUneDemande(')).toContain("'escaladee'");
    expect(corps('async ouvrirUneDemande(')).toContain("c.control_owner = 'app_human'");
  });

  it('🔴 l’état d’avant se lit sous `for no key update`, jamais `for update` (relecture du 2026-09-29)', () => {
    // `for update` bloque aussi les insertions filles (message, événement, analyse), dont la clé étrangère pose
    // `for key share` sur la conversation. Le verrou juste est celui que l'update prend lui-même.
    expect(source).not.toMatch(/for update\) avant/);
    expect(source.match(/for no key update\) avant/g)).toHaveLength(6);
  });

  it('🔴 « rendre » à l’agent de Meta se classe AVANT la lecture des colonnes', () => {
    // Sans cet ordre, le drapeau serait lu après `ancien_detenteur = 'mba'`, qui rend `prise_mba` : l'inverse du geste.
    const c = corps('async setControlOwner(');
    expect(c).toMatch(/case when \$11::boolean then 'rendue_mba'\s+when maj\.ancien_detenteur = 'mba' then 'prise_mba'/);
    // `$11` : la onzième valeur, juste après l'acteur (`$9`) et la cause (`$10`).
    expect(c).toContain('auteur.acteur, auteur.cause, opts.rendAgentDeMeta === true,');
  });

  it('🔴 les bornes d’une demande (0194) : `escaladee` exige `ouvreUneDemande` ET un robot, `rendue_scenario` vient de l’équipe', () => {
    // `escaladee` ouvre une demande du Quantitatif > Performance. Sans l'option, un opérateur qui prend le fil en
    // écrivant (`prisEnEcrivant`, de `app_workflow` à `app_human`) ouvrirait une demande déjà répondue, à 0 s.
    // `rendue_scenario` vient APRÈS les branches de l'agent de Meta : un fil qui le quitte reste `prise_mba`.
    const c = corps('async setControlOwner(');
    expect(c).toMatch(/when \$3 = 'mba' then 'rendue_mba'\s+when \$3 = 'app_workflow' and maj\.ancien_detenteur = 'app_human' then 'rendue_scenario' end\)/);
    // `escaladee` a SA ligne : un fil qui quitte l'agent de Meta pour l'équipe (la campagne au devenir Inbox) écrit
    // la prise ET le passage. Le drapeau d'escalade (`$8`) n'y est pour rien (décision du 2026-09-29).
    expect(c).toContain(`(case when $12::boolean and $3 = 'app_human' and maj.ancien_detenteur in ('app_workflow', 'mba') then 'escaladee' end)`);
    expect(c).toContain('opts.messageEnvoyeLe ?? null, opts.escalade === true, auteur.acteur');
    expect(c).toMatch(/opts\.rendAgentDeMeta === true,\s+opts\.ouvreUneDemande === true\]/);
  });

  it('🔴 la frise ne nomme que des collaborateurs DE L’ESPACE (acteur, cible, et l’assigné du panneau)', () => {
    const c = corps('async detailConversation(');
    expect(c).toContain('left join users ua on ua.id = e.acteur_id and ua.tenant_id = e.tenant_id');
    expect(c).toContain('left join users uc on uc.id = e.cible_id and uc.tenant_id = e.tenant_id');
    expect(c).toContain('left join users u on u.id = c.assigned_to and u.tenant_id = c.tenant_id');
  });
});

describe('le contrôle du fil dit qui demande chaque bascule', () => {
  const OPERATEUR: AuteurDuChangement = { collaborateur: UUID };
  const parDe = (b: ReturnType<typeof bancDuFil>): unknown[] => b.ecritures.map((e) => e.opts?.par);

  it('🔴 un geste de la console porte l’opérateur que la route lui passe, pas une cause', async () => {
    const b = bancDuFil({ conversations: { m: { owner: 'mba' }, h: { owner: 'app_human' } } });
    await b.fil.reprendreLaMain('t1', 'm', OPERATEUR);
    await b.fil.rendreLaMain('t1', 'h', OPERATEUR);
    expect(parDe(b)).toEqual([OPERATEUR, OPERATEUR]);
  });

  it('🔴 « Rendre la main » sur un fil que notre colonne croit déjà à l’agent reste un RENDU dans la frise', async () => {
    // Relecture du 2026-09-29 : ce chemin écrit `app_workflow` (on ne rouvre que notre côté), et la frise, qui ne
    // lisait que les colonnes, y voyait un fil QUITTER l'agent, donc « prise à l'agent de Meta par Alice ».
    const b = bancDuFil({ conversations: { m: { owner: 'mba' }, h: { owner: 'app_human' } } });
    expect(await b.fil.rendreLaMain('t1', 'm', OPERATEUR)).toBe('app_workflow');
    expect(b.ecritures[0]!.opts?.rendAgentDeMeta).toBe(true);
    // Les autres gestes ne le posent pas : un vrai rendu écrit `mba`, que les colonnes classent seules, et une
    // prise reste une prise.
    await b.fil.rendreLaMain('t1', 'h', OPERATEUR);
    await b.fil.reprendreLaMain('t1', 'm', OPERATEUR);
    expect(b.ecritures.slice(1).map((e) => e.opts?.rendAgentDeMeta)).toEqual([undefined, undefined]);
  });

  it('🔴 un envoi prend le fil au nom de celui qui écrit', async () => {
    const b = bancDuFil({ conversations: { m: { owner: 'mba' } } });
    await b.fil.prisEnEcrivant('t1', 'm', OPERATEUR);
    expect(parDe(b)).toEqual([OPERATEUR]);
  });

  it('les bascules automatiques portent leur cause, écrite par le module', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const b = bancDuFil({ conversations: { h: { owner: 'app_human' }, w: { owner: 'app_workflow' }, m: { owner: 'mba' } } });
    await b.fil.rendreApresInactivite('t1', 'h', 'app_human', 'mba');
    await b.fil.reprendrePourLApp('t1', 'm');
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', 'Bonjour', { rouverte: false });
    expect(parDe(b)).toEqual([
      { cause: 'automatique : délai de reprise écoulé' },
      { cause: 'automatique : un scénario reprend la conversation' },
      { cause: 'automatique : le contact écrit et personne ne suit la conversation' },
    ]);
  });

  it('🔴 le passage à l’équipe porte la cause de SON appelant, le scénario ou l’agent IA qui passe la main (0194)', async () => {
    // Elle portait « escalade vers l'équipe », qui ne disait ni l'un ni l'autre ; c'est désormais la cause de
    // l'événement `escaladee`, que la frise raconte.
    const b = bancDuFil({ conversations: { w: { owner: 'app_workflow' }, v: { owner: 'app_workflow' } } });
    await b.fil.passerAUnHumain('t1', 'w', { escalade: true, cause: 'automatique : scénario Bienvenue' });
    await b.fil.passerAUnHumain('t1', 'v', { escalade: true, cause: 'automatique : agent IA Léa' });
    expect(parDe(b)).toEqual([{ cause: 'automatique : scénario Bienvenue' }, { cause: 'automatique : agent IA Léa' }]);
    expect(b.ecritures.map((e) => e.opts?.escalade)).toEqual([true, true]);
  });

  it('🔴 seuls les passages d’un robot à l’équipe OUVRENT une demande, drapeau d’escalade ou non (2026-09-29)', async () => {
    // Le bloc « passer à un humain » et l'agent IA, avec la marque ; un scénario démarré par le client qui passe la
    // main sans rien avoir envoyé, sans elle (le client attend pourtant) ; la réponse à une campagne au devenir Inbox.
    const b = bancDuFil({ conversations: { e: { owner: 'app_workflow' }, s: { owner: 'app_workflow' }, c: { owner: 'mba' } } });
    await b.fil.passerAUnHumain('t1', 'e', { escalade: true, cause: 'automatique : scénario Bienvenue' });
    await b.fil.passerAUnHumain('t1', 's', { escalade: false, cause: 'automatique : scénario Mot-clé' });
    await b.fil.prendrePourLEquipe('t1', 'c', 'automatique : campagne Rentrée');
    expect(b.ecritures.map((e) => [e.waId, e.owner, e.opts?.ouvreUneDemande, e.opts?.escalade])).toEqual([
      ['e', 'app_human', true, true],
      ['s', 'app_human', true, false],
      ['c', 'app_human', true, undefined],
    ]);
  });

  it('🔴 un opérateur qui écrit ou reprend la main, et l’attente d’une fin de parcours, n’en ouvrent JAMAIS', async () => {
    // Trois bascules vers `app_human` : personne n'attend l'équipe (l'opérateur a déjà la main, le parcours a fini).
    const b = bancDuFil({ conversations: { w: { owner: 'app_workflow' }, m: { owner: 'mba' }, f: { owner: 'app_workflow', enVol: 'wamid.X' } } });
    await b.fil.prisEnEcrivant('t1', 'w', OPERATEUR);
    await b.fil.reprendreLaMain('t1', 'm', OPERATEUR);
    await b.fil.rendreApresParcours('t1', 'f');
    expect(b.ecritures.map((e) => [e.waId, e.owner, e.opts?.ouvreUneDemande])).toEqual([
      ['w', 'app_human', undefined],
      ['m', 'app_human', undefined],
      ['f', 'app_human', undefined],
    ]);
  });

  it('la prise pour l’équipe porte la campagne que son appelant nomme', async () => {
    const b = bancDuFil({ conversations: { m: { owner: 'mba' } } });
    await b.fil.prendrePourLEquipe('t1', 'm', 'automatique : campagne Rentrée');
    expect(parDe(b)).toEqual([{ cause: 'automatique : campagne Rentrée' }]);
  });

  it('la passation de l’agent de Meta porte sa cause jusqu’au dépôt', async () => {
    const causes: string[] = [];
    const b = bancDuFil({ depot: { marquerEscalade: async (_t, _w, cause) => { causes.push(cause); } } });
    await b.fil.agentDeMetaPasseLaMain('t1', 'w');
    expect(causes).toEqual(['automatique : agent de Meta']);
  });
});

describe('la campagne qui répartit se nomme dans la frise', () => {
  const campagne: CampagneAssignante = {
    campaignId: 'c1', nom: 'Rentrée', devenir: 'inbox', assignation: 'personne', assignationUserId: 'u1', premiereReponse: true,
  };

  it('🔴 l’affectation ET la prise du fil portent « automatique : campagne <nom> »', async () => {
    const vus: string[] = [];
    const deps: AssignationDeps = {
      campagneDeLaReponse: async () => campagne,
      membres: async () => [],
      prendreUnRang: async () => 0,
      assigner: async (_t, _w, _u, cause) => { vus.push(`assigner:${cause}`); return true; },
      prendreLeFil: async (_t, _w, cause) => { vus.push(`fil:${cause}`); return true; },
    };
    expect(await assignerReponse('t1', 'w', deps)).toBe('u1');
    expect(vus).toEqual(['fil:automatique : campagne Rentrée', 'assigner:automatique : campagne Rentrée']);
  });
});
