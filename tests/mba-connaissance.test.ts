import { describe, expect, it } from 'vitest';
import {
  appliquerMutationConnaissance,
  type ClientConnaissanceMba,
  type ContexteConnaissanceMba,
  type DependancesConnaissanceMba,
} from '../src/mba/connaissance';
import type { BusinessInfo, Faq, Skill, Website } from '../src/mba/client';

class ClientMetaLie implements ClientConnaissanceMba {
  readonly appels: Array<{ methode: string; args: unknown[] }> = [];
  private readonly agentId = 'agent-settings-42';
  private businessInfo: BusinessInfo = {
    business_description: 'Garage à Lyon',
    payment_method: 'Carte',
    contact_info: { email: 'bonjour@garage.fr', address: 'Lyon' },
  };

  async getSettings(numero: string) {
    this.appels.push({ methode: 'getSettings', args: [numero] });
    return { agent_id: this.agentId };
  }

  async listFaqs(numero: string): Promise<Faq[]> {
    this.appels.push({ methode: 'listFaqs', args: [numero] });
    return [{ id: 'faq-1', question: 'Horaires ?', answer: '9 h–18 h' }];
  }

  async createFaq(numero: string, faq: Faq): Promise<Faq> {
    this.appels.push({ methode: 'createFaq', args: [numero, faq] });
    return { id: 'faq-2', ...faq };
  }

  async updateFaq(numero: string, id: string, faq: Faq): Promise<Faq> {
    this.appels.push({ methode: 'updateFaq', args: [numero, id, faq] });
    return { id, ...faq };
  }

  async deleteFaq(numero: string, id: string) {
    this.appels.push({ methode: 'deleteFaq', args: [numero, id] });
  }

  async listSkills(numero: string, agentId: string): Promise<Skill[]> {
    this.appels.push({ methode: 'listSkills', args: [numero, agentId] });
    return [];
  }

  async createSkill(numero: string, agentId: string, skill: { title: string; description: string; skill: string }) {
    this.appels.push({ methode: 'createSkill', args: [numero, agentId, skill] });
    return { id: 'skill-1', ...skill };
  }

  async updateSkill(numero: string, id: string, skill: Skill): Promise<Skill> {
    this.appels.push({ methode: 'updateSkill', args: [numero, id, skill] });
    return { id, ...skill };
  }

  async deleteSkill(numero: string, id: string) {
    this.appels.push({ methode: 'deleteSkill', args: [numero, id] });
  }

  async listWebsites(numero: string): Promise<Website[]> {
    this.appels.push({ methode: 'listWebsites', args: [numero] });
    return [];
  }

  async createWebsite(numero: string, url: string): Promise<Website> {
    this.appels.push({ methode: 'createWebsite', args: [numero, url] });
    return { id: 'site-1', url };
  }

  async deleteWebsite(numero: string, id: string) {
    this.appels.push({ methode: 'deleteWebsite', args: [numero, id] });
  }

  async getBusinessInfo(numero: string) {
    this.appels.push({ methode: 'getBusinessInfo', args: [numero] });
    return this.businessInfo;
  }

  async putBusinessInfo(numero: string, info: BusinessInfo) {
    this.appels.push({ methode: 'putBusinessInfo', args: [numero, info] });
    this.businessInfo = info;
    return info;
  }

  async listFiles(numero: string) {
    this.appels.push({ methode: 'listFiles', args: [numero] });
    return [{ id: 'file-1', file_name: 'conditions.pdf', status: 'ready' }];
  }

  async deleteFile(numero: string, id: string) {
    this.appels.push({ methode: 'deleteFile', args: [numero, id] });
  }
}

function contexte(client: ClientConnaissanceMba): ContexteConnaissanceMba {
  return {
    tenantId: 'tenant-1',
    phoneNumberId: 'phone-1',
    client,
    origine: 'formulaire',
    acteur: { id: 'user-1', email: null },
  };
}

const dependances: DependancesConnaissanceMba = {
  historique: { ecrire: async () => {} },
};

describe('la connaissance du Meta Business Agent', () => {
  it('crée une compétence sous le véritable agent_id des réglages, en gardant le client lié à son instance', async () => {
    const client = new ClientMetaLie();

    const resultat = await appliquerMutationConnaissance(dependances, contexte(client), {
      type: 'competence.ajouter',
      valeur: { title: 'prise-rdv', description: 'Quand le client veut un rendez-vous', skill: 'Proposer deux créneaux.' },
    });

    expect(resultat).toMatchObject({
      valeur: { id: 'skill-1', title: 'prise-rdv' },
      historique: 'non_requis',
    });
    expect(client.appels).toEqual([
      { methode: 'getSettings', args: ['phone-1'] },
      {
        methode: 'createSkill',
        args: ['phone-1', 'agent-settings-42', {
          title: 'prise-rdv', description: 'Quand le client veut un rendez-vous', skill: 'Proposer deux créneaux.',
        }],
      },
    ]);
  });

  it('modifie une compétence depuis la console sans lectures Meta que cette surface ne journalise pas', async () => {
    const client = new ClientMetaLie();

    const resultat = await appliquerMutationConnaissance(dependances, contexte(client), {
      type: 'competence.modifier',
      id: 'skill-1',
      valeur: { title: 'prise-rdv', description: 'Quand le client veut un rendez-vous', skill: 'Proposer trois créneaux.' },
    });

    expect(resultat.historique).toBe('non_requis');
    expect(client.appels).toEqual([{
      methode: 'updateSkill',
      args: ['phone-1', 'skill-1', {
        title: 'prise-rdv', description: 'Quand le client veut un rendez-vous', skill: 'Proposer trois créneaux.',
      }],
    }]);
  });

  it('fusionne un champ de contact dans la véritable forme BusinessInfo et journalise le geste de l’assistant', async () => {
    const client = new ClientMetaLie();
    const lignes: unknown[] = [];

    const resultat = await appliquerMutationConnaissance(
      { historique: { ecrire: async (_tenant, ligne) => { lignes.push(ligne); } } },
      { ...contexte(client), origine: 'assistant' },
      { type: 'business.modifier', patch: { contact_info: { hours_of_operation: 'Lun–Ven 9 h–18 h' } } },
    );

    expect(resultat.historique).toBe('ecrit');
    expect(client.appels.at(-1)).toEqual({
      methode: 'putBusinessInfo',
      args: ['phone-1', {
        business_description: 'Garage à Lyon',
        payment_method: 'Carte',
        contact_info: {
          email: 'bonjour@garage.fr',
          address: 'Lyon',
          hours_of_operation: 'Lun–Ven 9 h–18 h',
        },
      }],
    });
    expect(lignes).toEqual([expect.objectContaining({
      element: 'business_info',
      operation: 'modification',
      origine: 'assistant',
      avant: expect.objectContaining({ business_description: 'Garage à Lyon' }),
      apres: { contact_info: { hours_of_operation: 'Lun–Ven 9 h–18 h' } },
    })]);
  });

  it('une suppression acceptée reste un succès explicite si seul l’historique échoue', async () => {
    const client = new ClientMetaLie();
    const avertissements: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { avertissements.push(args.map(String).join(' ')); };
    try {
      const resultat = await appliquerMutationConnaissance(
        { historique: { ecrire: async () => { throw new Error('base indisponible'); } } },
        contexte(client),
        { type: 'fichier.supprimer', id: 'file-1' },
      );

      expect(resultat).toEqual({ valeur: { deleted: 'file-1' }, historique: 'indisponible' });
      expect(client.appels.slice(-2)).toEqual([
        { methode: 'listFiles', args: ['phone-1'] },
        { methode: 'deleteFile', args: ['phone-1', 'file-1'] },
      ]);
      expect(avertissements.join('\n')).toContain('Document : conditions.pdf');
    } finally {
      console.warn = warn;
    }
  });

  it('une lecture préalable en échec ne bloque pas la suppression et garde au moins l’identifiant', async () => {
    class ClientLectureEnPanne extends ClientMetaLie {
      override async listFiles(_numero: string): Promise<never> {
        throw new Error('lecture Meta indisponible');
      }
    }
    const client = new ClientLectureEnPanne();
    const lignes: unknown[] = [];

    const resultat = await appliquerMutationConnaissance(
      { historique: { ecrire: async (_tenant, ligne) => { lignes.push(ligne); } } },
      contexte(client),
      { type: 'fichier.supprimer', id: 'file-1' },
    );

    expect(resultat.historique).toBe('ecrit');
    expect(client.appels.at(-1)).toEqual({ methode: 'deleteFile', args: ['phone-1', 'file-1'] });
    expect(lignes).toEqual([expect.objectContaining({
      cible: 'file-1', libelle: 'Document : file-1', avant: { id: 'file-1' }, apres: null,
    })]);
  });

  it('la lecture des réglages en échec ne bloque pas la suppression d’une consigne', async () => {
    class ClientReglagesEnPanne extends ClientMetaLie {
      override async getSettings(_numero: string): Promise<never> {
        throw new Error('réglages Meta indisponibles');
      }
    }
    const client = new ClientReglagesEnPanne();

    const resultat = await appliquerMutationConnaissance(dependances, contexte(client), {
      type: 'competence.supprimer', id: 'skill-1', libelle: 'prise-rdv',
    });

    expect(resultat.historique).toBe('ecrit');
    expect(client.appels.at(-1)).toEqual({ methode: 'deleteSkill', args: ['phone-1', 'skill-1'] });
  });
});
