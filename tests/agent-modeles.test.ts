import { describe, it, expect } from 'vitest';
import { prixParMillion, modelesProposables, MODELES_CHOISIS, IDS_MODELES_CHOISIS, type ModeleGateway } from '../src/agent/modeles';
import { lireCatalogueGateway } from '../src/agent/llm/modeles-gateway';
import type { HttpGet } from '../src/lib/http-get';

/**
 * La liste déroulante des modèles (2026-09-09, demande de Julien).
 *
 * 🔴 CE QUE CES CAS PROTÈGENT. Un prix affiché est une PROMESSE COMMERCIALE : trop bas, on vend à perte sans
 * s'en apercevoir ; à zéro, on annonce la gratuité. Et une liste qui laisse passer un modèle sans gestion des
 * outils ne dégrade pas l'agent, elle le fait INVENTER ses réponses, sur des contrats d'assurance.
 */

/** Un modèle du catalogue, au format réel du Gateway : le prix est en DOLLARS PAR JETON, en chaîne. */
const gw = (id: string, input: string, output: string, outils = true): ModeleGateway => ({
  id,
  pricing: { input, output },
  supported_parameters: outils ? ['max_tokens', 'tools', 'tool_choice'] : ['max_tokens'],
  type: 'language',
});

/** Le catalogue réel, mesuré chez Vercel le 2026-09-09 (extrait : trois de nos dix). */
const CATALOGUE: ModeleGateway[] = [
  gw('zai/glm-4.7-flash', '0.00000007', '0.0000004'),
  gw('anthropic/claude-haiku-4.5', '0.000001', '0.000005'),
  gw('mistral/mistral-small', '0.0000001', '0.0000003'),
  gw('un/modele-que-personne-na-choisi', '0.000002', '0.000009'),
];

describe('prixParMillion : dollars par jeton -> euros par million, commission comprise', () => {
  it('🔴 les TROIS multiplications sont faites, et dans le bon sens', () => {
    // 0,00000007 $/jeton = 0,07 $ par million ; x 0,92 = 0,0644 € ; +10 % = 0,07084 €.
    expect(prixParMillion('0.00000007', 0.92, 10)).toBeCloseTo(0.07084, 6);
  });

  it('🔴 un prix ABSENT ou illisible rend null, JAMAIS zéro', () => {
    // Zéro s'afficherait « gratuit », ce qui est une affirmation, et elle serait fausse.
    for (const v of [undefined, '', 'offert', '0', '-1', 'NaN']) {
      expect(prixParMillion(v as string | undefined, 0.92, 10), `sur ${JSON.stringify(v)}`).toBeNull();
    }
  });

  it('accepte un nombre autant qu’une chaîne : le Gateway rend des chaînes, un mock rend souvent des nombres', () => {
    expect(prixParMillion(0.000001, 1, 0)).toBeCloseTo(1, 9);
  });

  it('🔴 un taux aberrant retombe sur 1, jamais sur 0', () => {
    // Même règle que `microEurosDepuisDollars` : un zéro rendrait tout gratuit à l'écran.
    expect(prixParMillion('0.000001', 0, 0)).toBeCloseTo(1, 9);
    expect(prixParMillion('0.000001', Number.NaN, 0)).toBeCloseTo(1, 9);
  });

  it('une commission de 0 est valide et ne majore rien', () => {
    expect(prixParMillion('0.000001', 1, 0)).toBeCloseTo(1, 9);
    expect(prixParMillion('0.000001', 1, 100)).toBeCloseTo(2, 9);
  });
});

describe('modelesProposables : l’intersection de NOS dix avec le catalogue réel', () => {
  it('🔴 un modèle ABSENT du catalogue ne sort pas : il casserait l’agent au premier message', () => {
    const out = modelesProposables(CATALOGUE, 0.92, 10);
    expect(out.map((m) => m.id).sort()).toEqual(['anthropic/claude-haiku-4.5', 'mistral/mistral-small', 'zai/glm-4.7-flash']);
  });

  it('🔴 un modèle SANS gestion des outils est écarté comme s’il était absent', () => {
    // Le cas qui coûte le plus cher : il répondrait, mais sans jamais chercher dans la base de connaissance.
    const sansOutils = CATALOGUE.map((m) => (m.id === 'mistral/mistral-small' ? gw(m.id, '0.0000001', '0.0000003', false) : m));
    expect(modelesProposables(sansOutils, 0.92, 10).map((m) => m.id)).not.toContain('mistral/mistral-small');
  });

  it('un modèle du catalogue que nous n’avons PAS choisi n’entre pas', () => {
    // La preuve inverse : sans elle, « intersection » pourrait vouloir dire « union » et personne ne le verrait.
    expect(modelesProposables(CATALOGUE, 0.92, 10).map((m) => m.id)).not.toContain('un/modele-que-personne-na-choisi');
  });

  it('🔴 trié par prix d’ENTRÉE croissant, pas par notre ordre d’écriture', () => {
    const out = modelesProposables(CATALOGUE, 0.92, 10);
    expect(out.map((m) => m.id)).toEqual(['zai/glm-4.7-flash', 'mistral/mistral-small', 'anthropic/claude-haiku-4.5']);
    expect(out[0]!.prixEntree).toBeCloseTo(0.07084, 6);
    expect(out[0]!.prixSortie).toBeCloseTo(0.4048, 6);
  });

  it('🔴 catalogue VIDE (Gateway injoignable) -> nos dix SANS prix, jamais un menu vide', () => {
    // Un menu vide interdirait le geste que ce lot vient d'ouvrir. Une tarification indisponible n'a pas à
    // empêcher un réglage.
    const out = modelesProposables([], 0.92, 10);
    expect(out).toHaveLength(MODELES_CHOISIS.length);
    expect(out.every((m) => m.prixEntree === null && m.prixSortie === null)).toBe(true);
  });

  it('un prix inconnu part en FIN de liste, jamais en tête où il passerait pour le moins cher', () => {
    const sansPrix: ModeleGateway = { id: 'mistral/mistral-small', supported_parameters: ['tools'], type: 'language' };
    const out = modelesProposables([...CATALOGUE.filter((m) => m.id !== 'mistral/mistral-small'), sansPrix], 0.92, 10);
    expect(out[out.length - 1]!.id).toBe('mistral/mistral-small');
  });

  it('la liste et l’ensemble d’identifiants disent la MÊME chose', () => {
    // Deux inventaires du même choix : le second sert la garde d'écriture, le premier le menu. Divergents,
    // on proposerait un modèle que le serveur refuserait d'enregistrer.
    expect([...IDS_MODELES_CHOISIS].sort()).toEqual(MODELES_CHOISIS.map((m) => m.id).sort());
    expect(MODELES_CHOISIS).toHaveLength(10);
  });

  it('🔴 le modèle qui tourne AUJOURD’HUI est dans la liste', () => {
    // Le retirer ferait afficher « en place, hors liste » sur tous les agents du parc d'un coup.
    expect(IDS_MODELES_CHOISIS.has('zai/glm-4.7-flash')).toBe(true);
  });
});

describe('lireCatalogueGateway : lecture DÉFENSIVE d’un JSON de tiers', () => {
  const transport = (reponse: { status: number; json: unknown } | Error): HttpGet => ({
    async get() {
      if (reponse instanceof Error) throw reponse;
      return reponse;
    },
  });

  it('lit la forme réelle et garde les trois champs qui servent', async () => {
    const out = await lireCatalogueGateway(transport({ status: 200, json: { data: [CATALOGUE[0]] } }), 'vck_x');
    expect(out).toEqual([{ id: 'zai/glm-4.7-flash', type: 'language', supported_parameters: ['max_tokens', 'tools', 'tool_choice'], pricing: { input: '0.00000007', output: '0.0000004' } }]);
  });

  it('🔴 une panne rend une liste VIDE, jamais une exception', async () => {
    // C'est ce qui fait retomber le menu sur « nos dix sans prix » au lieu de faire tomber la fiche d'agent.
    for (const r of [transport(new Error('réseau')), transport({ status: 500, json: null }), transport({ status: 401, json: { error: 'clé' } })]) {
      expect(await lireCatalogueGateway(r, 'vck_x')).toEqual([]);
    }
  });

  it('🔴 sans clé, aucun appel n’est tenté', async () => {
    let appele = false;
    const espion: HttpGet = { async get() { appele = true; return { status: 200, json: { data: [] } }; } };
    expect(await lireCatalogueGateway(espion, '  ')).toEqual([]);
    expect(appele).toBe(false);
  });

  it('une forme INATTENDUE ne fait pas tomber l’écran : les entrées illisibles sont écartées', async () => {
    const json = { data: [null, 42, { pas_d_id: true }, { id: '' }, { id: 'ok/x', pricing: 'gratuit', supported_parameters: [1, 'tools'] }] };
    const out = await lireCatalogueGateway(transport({ status: 200, json }), 'vck_x');
    expect(out).toEqual([{ id: 'ok/x', supported_parameters: ['tools'] }]);
  });

  it('un corps sans `data` exploitable rend une liste vide', async () => {
    for (const json of [null, {}, { data: 'oui' }, { modeles: [] }]) {
      expect(await lireCatalogueGateway(transport({ status: 200, json }), 'vck_x')).toEqual([]);
    }
  });
});
