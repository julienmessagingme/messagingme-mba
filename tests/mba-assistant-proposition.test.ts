import { describe, it, expect } from 'vitest';
import { estSuppression, MAX_QUAND, propositionMbaSchema, type Operation } from '../src/mba/assistant/proposition';
import { DESCRIPTION_SKILL_MAX } from '../src/http/mba';

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

  it('ajouter un site, et mettre en service', () => {
    expect(ok([{ type: 'site.ajouter', url: 'https://exemple.fr' }]).success).toBe(true);
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

  it('⚠️ ajouter un document : la conversation n’en dépose plus, l’onglet Fichiers le fait', () => {
    // Le dépôt de pièce jointe de l'assistant (et son magasin en mémoire) est retiré : aucun jeton ne peut plus
    // exister, donc une opération d'ajout serait offerte et inerte. Et le contenu d'un fichier ne passe jamais
    // par le modèle.
    expect(ok([{ type: 'fichier.ajouter', jeton: 'a'.repeat(32), nom: 'tarifs.pdf' }]).success).toBe(false);
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

describe('les messages interactifs (lot du 2026-10-07)', () => {
  const ajout = { type: 'message_interactif.ajouter', titre: 'boutons-rdv', composant: 'interactive_reply_buttons', consigne: 'Quand : rdv' };

  it('ajouter, modifier et supprimer un message interactif', () => {
    expect(ok([ajout]).success).toBe(true);
    expect(ok([{ type: 'message_interactif.modifier', cible: 'm1', titre: 'boutons-rdv', consigne: 'Quand : rdv\nTexte : ...' }]).success).toBe(true);
    expect(ok([{ type: 'message_interactif.supprimer', cible: 'm1', libelle: 'boutons-rdv' }]).success).toBe(true);
  });

  it('le titre est un slug, comme celui d’une consigne', () => {
    expect(ok([{ ...ajout, titre: 'Boutons RDV' }]).success).toBe(false);
  });

  it('🔴 un composant hors des neuf est refusé : c’est une énumération fermée', () => {
    expect(ok([{ ...ajout, composant: 'catalog_message' }]).success).toBe(false);
  });

  it('🔴 un formulaire, et seulement pour un composant formulaire (les deux sens)', () => {
    expect(ok([{ ...ajout, composant: 'flow' }]).success).toBe(false);
    expect(ok([{ ...ajout, composant: 'flow', formulaire: '3234400576763440' }]).success).toBe(true);
    expect(ok([{ ...ajout, formulaire: '3234400576763440' }]).success).toBe(false);
    expect(ok([{ ...ajout, composant: 'flow', formulaire: '../autre-espace' }]).success).toBe(false);
  });

  it('🔴 le type et le formulaire ne passent pas par une modification', () => {
    const r = propositionMbaSchema.safeParse({ message: 'x', operations: [{ type: 'message_interactif.modifier', cible: 'm1', titre: 't', consigne: 'c', composant: 'image' }] });
    // La clé inconnue est ignorée (tolérance au bruit), donc elle ne peut rien changer : elle n'arrive pas à l'application.
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.operations[0]).not.toHaveProperty('composant');
  });

  it('⚠️ les opérations gardent leur nom competence.*, et la suppression sa forme', () => {
    expect(ok([{ type: 'competence.ajouter', titre: 'rdv', quand: 'Quand le client veut un rendez-vous', instruction: 'Prendre un rendez-vous' }]).success).toBe(true);
    expect(ok([{ type: 'competence.supprimer', cible: 's1', libelle: 'RDV' }]).success).toBe(true);
  });

  it('une seule suppression par diff vaut aussi pour les messages interactifs', () => {
    expect(ok([
      { type: 'message_interactif.supprimer', cible: 'm1', libelle: 'a' },
      { type: 'faq.supprimer', cible: 'f1', libelle: 'b' },
    ]).success).toBe(false);
  });
});

describe('les consignes (corrigé le 2026-10-08)', () => {
  const consigne = { type: 'competence.ajouter', titre: 'politique-de-retour', quand: 'Quand le client parle d’un retour', instruction: 'Rappeler le délai de 30 jours' };

  it('🔴 l’ancienne forme { nom, instruction } est refusée : Meta l’aurait refusée ou ignorée', () => {
    // Elle ne vit plus que dans un onglet resté ouvert pendant le déploiement : refusée ici (422 à l'application),
    // elle n'atteint pas Meta, qui refusait la création en 400 et ignorait la modification en 200.
    expect(ok([{ type: 'competence.ajouter', nom: 'RDV', instruction: 'Prendre un rendez-vous' }]).success).toBe(false);
    expect(ok([{ type: 'competence.modifier', cible: 's1', nom: 'RDV', instruction: 'Prendre un rendez-vous' }]).success).toBe(false);
  });

  it('🔴 le titre est un slug de 64 au plus, comme Meta l’exige', () => {
    expect(ok([consigne]).success).toBe(true);
    expect(ok([{ ...consigne, titre: 'Politique de retour' }]).success).toBe(false);
    expect(ok([{ ...consigne, titre: '-retour' }]).success).toBe(false);
    expect(ok([{ ...consigne, titre: 'a'.repeat(64) }]).success).toBe(true);
    expect(ok([{ ...consigne, titre: 'a'.repeat(65) }]).success).toBe(false);
  });

  it('🔴 le quand est requis et borné à la limite de Meta (1 024)', () => {
    const { quand: _q, ...sansQuand } = consigne;
    expect(ok([sansQuand]).success).toBe(false);
    expect(ok([{ ...consigne, quand: 'x'.repeat(1024) }]).success).toBe(true);
    expect(ok([{ ...consigne, quand: 'x'.repeat(1025) }]).success).toBe(false);
  });

  it('la borne du quand est celle de l’onglet, donc celle de Meta', () => {
    expect(MAX_QUAND).toBe(DESCRIPTION_SKILL_MAX);
  });

  it('🔴 la modification exige la même forme, plus sa cible', () => {
    const { type: _t, ...champs } = consigne;
    const modif = { type: 'competence.modifier', cible: 's1', ...champs };
    expect(ok([modif]).success).toBe(true);
    const { quand: _q, ...sansQuand } = modif;
    expect(ok([sansQuand]).success).toBe(false);
    expect(ok([{ ...modif, titre: 'Politique de retour' }]).success).toBe(false);
    const { cible: _c, ...sansCible } = modif;
    expect(ok([sansCible]).success).toBe(false);
  });
});
