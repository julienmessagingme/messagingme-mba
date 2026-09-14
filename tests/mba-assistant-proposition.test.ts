import { describe, it, expect } from 'vitest';
import { estSuppression, propositionMbaSchema, type Operation } from '../src/mba/assistant/proposition';

/**
 * LA FRONTIÈRE DE CE QUE L'ASSISTANT DU MBA PEUT PROPOSER.
 *
 * 🔴 C'EST UNE FRONTIÈRE DE SÉCURITÉ, PAS DU PARSING. Le contexte envoyé au modèle contient les FAQ du
 * client et les pages aspirées de son site : du texte que nous n'avons pas écrit. Ce que ces cas gardent,
 * ce n'est pas la forme du JSON, c'est la liste de ce qu'une conversation compromise NE PEUT PAS obtenir.
 */
const ok = (operations: unknown[]) => propositionMbaSchema.safeParse({ message: 'Voilà.', operations });

describe('ce que l’assistant PEUT proposer', () => {
  it('ajouter, modifier et supprimer une FAQ', () => {
    expect(ok([{ type: 'faq.ajouter', question: 'Horaires ?', reponse: '9h-18h' }]).success).toBe(true);
    expect(ok([{ type: 'faq.modifier', cible: 'f1', question: 'Horaires ?', reponse: '9h-19h' }]).success).toBe(true);
    expect(ok([{ type: 'faq.supprimer', cible: 'f1', libelle: 'Horaires du dimanche' }]).success).toBe(true);
  });

  it('ajouter un site, un document, et mettre en service', () => {
    expect(ok([{ type: 'site.ajouter', url: 'https://exemple.fr' }]).success).toBe(true);
    expect(ok([{ type: 'fichier.ajouter', jeton: 'a'.repeat(32), nom: 'tarifs.pdf' }]).success).toBe(true);
    expect(ok([{ type: 'activation.mettreEnService' }]).success).toBe(true);
  });

  it('modifier un champ de la fiche d’activité', () => {
    expect(ok([{ type: 'business.modifier', champ: 'horaires', valeur: '9h-18h' }]).success).toBe(true);
  });
});

describe('ce qu’il ne peut PAS, et c’est la moitié qui compte', () => {
  it('🔴 RETIRER l’agent du service', () => {
    // Julien : « si tu veux retirer, tu débranches ton agent MBA en première page ». Couper les réponses aux
    // vrais clients dans la seconde ne se déclenche pas sur une phrase interprétée.
    expect(ok([{ type: 'activation.retirer' }]).success).toBe(false);
    expect(ok([{ type: 'activation.eteindre' }]).success).toBe(false);
  });

  it('🔴 créer un connecteur ou toucher à une adresse réseau', () => {
    // Déclarer une source, c'est écrire une adresse et un secret : un geste d'administrateur. Même frontière
    // que pour l'assistant d'agent IA, où elle est déjà écrite.
    expect(ok([{ type: 'connecteur.creer', baseUrl: 'https://erp.client.fr', secret: 'x' }]).success).toBe(false);
    expect(ok([{ type: 'connecteur.modifier', cible: 'c1', baseUrl: 'https://autre.fr' }]).success).toBe(false);
  });

  it('🔴 SUPPRIMER PLUSIEURS CHOSES D’UN COUP', () => {
    // Rien n'est stocké chez nous : Meta n'a ni corbeille ni historique. Une acceptation rapide sur une
    // purge en lot serait définitive.
    const r = ok([
      { type: 'faq.supprimer', cible: 'f1', libelle: 'A' },
      { type: 'faq.supprimer', cible: 'f2', libelle: 'B' },
    ]);
    expect(r.success).toBe(false);
  });

  it('⚠️ mais UNE suppression accompagnée d’ajouts reste possible', () => {
    // La règle borne les SUPPRESSIONS, pas la taille du diff : remplacer une FAQ par une autre est un geste
    // ordinaire, et l'interdire obligerait à faire deux tours pour une seule intention.
    expect(ok([
      { type: 'faq.supprimer', cible: 'f1', libelle: 'Ancienne' },
      { type: 'faq.ajouter', question: 'Nouvelle ?', reponse: 'Oui' },
      { type: 'business.modifier', champ: 'horaires', valeur: '9h-19h' },
    ]).success).toBe(true);
  });

  it('🔴 inventer un champ de fiche d’activité', () => {
    expect(ok([{ type: 'business.modifier', champ: 'plafond_de_depense', valeur: '99999' }]).success).toBe(false);
  });

  it('🔴 supprimer sans NOMMER ce qu’il supprime', () => {
    // Un diff qui dirait « supprimer faq_8f3a » ne permettrait à personne de vérifier qu'on ne se trompe pas
    // de ligne, ce qui est exactement ce que la confirmation existe pour permettre.
    expect(ok([{ type: 'faq.supprimer', cible: 'f1' }]).success).toBe(false);
    expect(ok([{ type: 'faq.supprimer', cible: 'f1', libelle: '   ' }]).success).toBe(false);
  });

  it('⚠️ un document dont le CONTENU passerait par le modèle', () => {
    // Le modèle ne manipule qu'un jeton : le contenu du fichier ne traverse jamais le prompt.
    expect(ok([{ type: 'fichier.ajouter', nom: 'tarifs.pdf', contenu: 'JVBERi0...' }]).success).toBe(false);
  });
});

describe('la tolérance au bruit', () => {
  it('⚠️ une clé inconnue est IGNORÉE, pas refusée', () => {
    // Doctrine du dépôt : un modèle qui renvoie du bruit ne doit pas casser une conversation valable, il
    // doit juste n'obtenir rien de plus. Un schéma strict rendrait 422 sur un tour par ailleurs parfait.
    const r = propositionMbaSchema.safeParse({ message: 'ok', operations: [], plafondDepense: 99999 });
    expect(r.success).toBe(true);
  });

  it('🔴 mais un message VIDE est refusé : un diff sans explication ne se juge pas', () => {
    expect(propositionMbaSchema.safeParse({ message: '   ', operations: [] }).success).toBe(false);
  });

  it('⚠️ une opération inconnue fait échouer le tour plutôt que d’être ignorée', () => {
    // L'écart avec la clé inconnue est voulu : une opération est une INTENTION D'ÉCRITURE. En laisser tomber
    // une en silence ferait croire au client qu'elle est partie.
    expect(ok([{ type: 'faq.archiver', cible: 'f1' }]).success).toBe(false);
  });
});

describe('estSuppression', () => {
  it('reconnaît les trois familles sans liste à tenir', () => {
    expect(estSuppression({ type: 'faq.supprimer', cible: 'f1', libelle: 'x' } as Operation)).toBe(true);
    expect(estSuppression({ type: 'site.supprimer', cible: 's1', libelle: 'x' } as Operation)).toBe(true);
    expect(estSuppression({ type: 'faq.ajouter', question: 'q', reponse: 'r' } as Operation)).toBe(false);
  });
});
