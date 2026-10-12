import { describe, it, expect } from 'vitest';
import { blocDeFin, etapesDeFin, TITRE_FIN, type EntreeFin } from '../src/agent/setup/fin';

/**
 * Le bloc « Pour finir » de l'entretien de construction (décision de Julien, 2026-10-12) : écrit par le serveur sur
 * l'état réel, une étape par chose qui reste à faire, et rien d'autre.
 */
const base: EntreeFin = {
  aAppliquer: true, connaissanceUrl: null, fichesDeConnaissance: 3, bascules: [],
  outilsApi: 0, outilsMcp: 0, modele: 'zai/glm-4.7-flash',
};

describe('etapesDeFin', () => {
  it('🔴 dit d’appliquer la proposition quand elle change quelque chose, et pas sinon', () => {
    expect(etapesDeFin(base)[0]).toMatch(/« Appliquer »/);
    expect(etapesDeFin({ ...base, aAppliquer: false }).join('\n')).not.toMatch(/Appliquer »/);
  });

  it('🔴 nomme le site à importer quand l’agent n’a encore aucune fiche', () => {
    const e = etapesDeFin({ ...base, fichesDeConnaissance: 0, connaissanceUrl: 'https://www.smatis.fr/' });
    expect(e).toContain('Base de connaissance : importez les pages de https://www.smatis.fr/.');
  });

  it('sans adresse et sans fiche, demande des fiches ou un document ; avec des fiches, ne dit rien', () => {
    expect(etapesDeFin({ ...base, fichesDeConnaissance: 0 }).join('\n')).toMatch(/ajoutez des fiches ou un document/);
    expect(etapesDeFin(base).join('\n')).not.toMatch(/Base de connaissance/);
  });

  it('🔴 un moment qui demande un connecteur absent le dit, un moment servi par un humain ne dit rien', () => {
    const e = etapesDeFin({
      ...base,
      bascules: [
        { moment: 'le client veut un devis', action: 'outil_api' },
        { moment: 'le client veut parler à un conseiller', action: 'humain' },
        { moment: 'il veut son attestation', action: 'outil_mcp' },
        { moment: 'il veut prendre rendez-vous', action: 'scenario' },
      ],
    }).join('\n');
    expect(e).toMatch(/branchez le connecteur API pour « le client veut un devis »/);
    expect(e).toMatch(/branchez l’outil MCP pour « il veut son attestation »/);
    expect(e).toMatch(/préparez le scénario à lancer pour « il veut prendre rendez-vous »/);
    expect(e).not.toMatch(/conseiller/);
  });

  it('un connecteur déjà branché ne redemande rien', () => {
    const e = etapesDeFin({ ...base, outilsApi: 1, bascules: [{ moment: 'le client veut un devis', action: 'outil_api' }] });
    expect(e.join('\n')).not.toMatch(/Connecteurs API/);
  });

  it('🔴 nomme le modèle de l’agent, posé à la création, et renvoie à son onglet', () => {
    expect(etapesDeFin(base)).toContain('Modèle : l’agent utilise zai/glm-4.7-flash. Changez-le dans l’onglet « Modèle » si besoin.');
    expect(etapesDeFin({ ...base, modele: null }).join('\n')).toMatch(/vérifiez le modèle de l’agent/);
  });

  it('finit TOUJOURS par Tester puis Activer', () => {
    const e = etapesDeFin({ ...base, aAppliquer: false });
    expect(e.at(-2)).toMatch(/^Tester :/);
    expect(e.at(-1)).toMatch(/^Activer :.*« Activer »/);
  });
});

describe('blocDeFin', () => {
  it('numérote les étapes sous son titre', () => {
    const lignes = blocDeFin(base).split('\n');
    expect(lignes[0]).toBe(TITRE_FIN);
    expect(lignes[1]).toMatch(/^1\. Relisez/);
    expect(lignes.at(-1)).toMatch(/^\d+\. Activer :/);
  });

  it('n’écrit aucun tiret cadratin ni demi-cadratin', () => {
    // Règle de rédaction de Julien : ces deux signes se repèrent comme « écrit par une IA ».
    const tout = blocDeFin({
      ...base, fichesDeConnaissance: 0, connaissanceUrl: 'https://x.fr',
      bascules: [{ moment: 'm', action: 'outil_api' }, { moment: 'n', action: 'scenario' }],
    });
    const tirets = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    expect(tout).not.toMatch(tirets);
  });
});
