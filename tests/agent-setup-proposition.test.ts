import { describe, it, expect } from 'vitest';
import {
  differences, propositionSchema, SCHEMA_PROPOSITION, type EtatCourant,
} from '../src/agent/setup/proposition';
import { ficheVide } from '../src/agent/fiche';
import { OUTILS_MAISON } from '../src/agent/outils-maison';

/**
 * Ce que l'IA de construction a le droit de proposer, et le diff qu'on montre au client.
 *
 * 🔴 CE SCHÉMA EST UNE FRONTIÈRE DE SÉCURITÉ. L'IA de setup lit du contenu tiers (le site du client) : un
 * contenu hostile peut l'orienter. Ce qu'elle peut écrire est énuméré, et le reste ne passe pas. La liste de
 * ce qu'elle NE peut PAS écrire compte autant que l'autre : mention légale d'IA, plafonds, modèle, risque
 * d'un outil, et surtout son activation.
 */

const COURANT = (): EtatCourant => ({ mentionIaFrequence: 'session', inactiviteMinutes: 30, fiche: ficheVide(), outils: [] });

describe('propositionSchema', () => {
  it('accepte une proposition de fiche partielle', () => {
    const r = propositionSchema.safeParse({
      message: 'Je propose ceci.',
      fiche: { objectif: 'Cerner le besoin puis proposer un essai.' },
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.fiche).toEqual({ objectif: 'Cerner le besoin puis proposer un essai.' });
  });

  it('🔴 ÉCARTE tout ce qui touche à la sécurité, sans faire échouer le tour', () => {
    // Écarté, pas refusé : un modèle qui renvoie du bruit ne doit pas casser la conversation, il doit juste
    // n'obtenir rien. C'est le comportement de `safeParse` sur un objet Zod non strict, et il est voulu.
    const r = propositionSchema.safeParse({
      message: 'Voici.',
      mentionIa: 'Vous parlez à un humain.',
      maxTours: 999,
      budgetMicroEur: 100_000_000,
      modele: 'un-modele-a-moi',
      status: 'active',
      fiche: { objectif: 'Aider.', mentionIa: 'menteur', sorties: [] },
      outils: [{ handler: 'poser_tag', description: 'Tague.', nePasUtiliser: 'Jamais au hasard.', actif: true, risk: 'read', autonome: true }],
    });
    expect(r.success).toBe(true);
    const data = r.success ? r.data : null;
    expect(data).not.toHaveProperty('mentionIa');
    expect(data).not.toHaveProperty('maxTours');
    expect(data).not.toHaveProperty('status');
    expect(data!.fiche).not.toHaveProperty('mentionIa');
    expect(data!.outils![0]).not.toHaveProperty('actif');
    expect(data!.outils![0]).not.toHaveProperty('risk');
    expect(data!.outils![0]).not.toHaveProperty('autonome');
  });

  it('🔴 un handler hors catalogue est REFUSÉ', () => {
    // Une énumération fermée : le modèle ne peut pas inventer un comportement, ni même en nommer un qui
    // n'existe pas et qui produirait un outil actif refusant à chaque appel.
    expect(propositionSchema.safeParse({
      message: 'Voici.',
      outils: [{ handler: 'rm_rf', description: 'Efface tout.', nePasUtiliser: '' }],
    }).success).toBe(false);
  });

  it('un code de sortie hors alphabet est refusé', () => {
    // Le code devient un handle d'arête dans le builder : la même règle que le formulaire s'applique ici.
    expect(propositionSchema.safeParse({
      message: 'Voici.',
      fiche: { sorties: [{ code: 'Besoin Cerné', label: 'Besoin cerné' }] },
    }).success).toBe(false);
  });

  it('🔴 le même outil proposé DEUX FOIS est refusé', () => {
    // Deux entrées pour le même handler produiraient deux lignes de diff portant la même clé, et
    // l'application tenterait de créer deux fois le même outil : la seconde se ferait refuser sur un nom
    // deja pris, en laissant la premiere derriere elle.
    expect(propositionSchema.safeParse({
      message: 'Voici.',
      outils: [
        { handler: 'poser_tag', description: 'Tague.', nePasUtiliser: 'Jamais au hasard.' },
        { handler: 'poser_tag', description: 'Tague encore.', nePasUtiliser: '' },
      ],
    }).success).toBe(false);
  });

  it('🔴 le DÉLAI D’INACTIVITÉ est proposable, et le diff le dit en toutes lettres', () => {
    // Demande de Julien du 2026-09-11 : « au bout de combien de temps de non réaction, on ne relance plus
    // l'agent IA ? ». Le réglage existait, l'entretien ne le demandait pas, donc il gardait sa valeur
    // d'usine chez tout le monde.
    const p = propositionSchema.parse({ message: 'voici', inactiviteMinutes: 120 });
    const d = differences(COURANT(), p);
    expect(d).toEqual([{
      champ: 'inactiviteMinutes',
      label: 'Silence du contact : quand l’agent lâche',
      // 🔴 EN CLAIR, PAS EN NOMBRE NU : « 1440 » ne se lit pas, et c'est un diff qu'un humain doit JUGER.
      // Lui demander la division reviendrait à l'inviter à cliquer « Garder » sans lire.
      avant: '30 minutes',
      apres: '2 heures',
    }]);
  });

  it('une durée INCHANGÉE ne produit aucune ligne de diff', () => {
    // Preuve inverse : sans elle, écrire la ligne à chaque tour passerait le test ci-dessus, et le client
    // apprendrait à valider un diff qui ne change rien.
    expect(differences(COURANT(), propositionSchema.parse({ message: 'voici', inactiviteMinutes: 30 }))).toEqual([]);
  });

  it('🔴 les BORNES sont celles de la base, pas des valeurs choisies ici', () => {
    // La colonne porte le même CHECK (1 à 1440). Accepter 5000 ferait remonter un 500 au moment d'appliquer,
    // sur une proposition que le client venait de valider.
    expect(propositionSchema.safeParse({ message: 'x', inactiviteMinutes: 1440 }).success).toBe(true);
    expect(propositionSchema.safeParse({ message: 'x', inactiviteMinutes: 1441 }).success).toBe(false);
    expect(propositionSchema.safeParse({ message: 'x', inactiviteMinutes: 0 }).success).toBe(false);
    expect(propositionSchema.safeParse({ message: 'x', inactiviteMinutes: 30.5 }).success).toBe(false);
  });

  it('une réponse sans message est refusée', () => {
    // Une proposition sans explication est un diff que personne ne peut juger.
    expect(propositionSchema.safeParse({ mentionIaFrequence: 'session', fiche: { objectif: 'Aider.' } }).success).toBe(false);
  });
});

describe('SCHEMA_PROPOSITION', () => {
  it('🔴 est le miroir de `propositionSchema`', () => {
    // Un champ présent ici et absent là serait promis au modèle puis jeté en silence ; un champ présent là
    // et absent ici ne serait jamais rempli.
    const zod = propositionSchema.shape;
    expect(Object.keys(SCHEMA_PROPOSITION.properties).sort()).toEqual(Object.keys(zod).sort());
    const ficheZod = zod.fiche.unwrap().shape;
    expect(Object.keys(SCHEMA_PROPOSITION.properties.fiche.properties).sort()).toEqual(Object.keys(ficheZod).sort());
  });

  it('🔴 ce que Zod EXIGE, le schéma envoyé au modèle l’exige aussi', () => {
    // Comparer les seuls noms de clés laisserait passer un écart de nullabilité. L'invariant n'est PAS
    // l'égalité, c'est l'inclusion dans ce sens-là : un champ exigé par Zod mais annoncé optionnel au modèle
    // ferait rejeter des propositions pour un champ qu'on n'a jamais demandé.
    //
    // ⚠️ L'inverse est VOULU et présent aujourd'hui : `nePasUtiliser` est exigé du modèle (le mandat dit que
    // cette clause n'est jamais vide, c'est elle qui évite les appels de trop) mais toléré absent par Zod,
    // avec un repli sur la chaîne vide. Un modèle qui l'oublie ne doit pas faire échouer tout un tour de
    // conversation ; il doit juste ne rien proposer sur ce champ.
    const requisZod = (forme: Record<string, { isOptional(): boolean }>) => Object.entries(forme)
      .filter(([, v]) => !v.isOptional()).map(([k]) => k);

    for (const nom of requisZod(propositionSchema.shape)) {
      expect([...SCHEMA_PROPOSITION.required], nom).toContain(nom);
    }
    const outilZod = propositionSchema.shape.outils.unwrap().element.shape;
    for (const nom of requisZod(outilZod)) {
      expect([...SCHEMA_PROPOSITION.properties.outils.items.required], nom).toContain(nom);
    }
  });

  it('🔴 l’énumération des handlers est celle du catalogue', () => {
    expect([...SCHEMA_PROPOSITION.properties.outils.items.properties.handler.enum].sort())
      .toEqual(OUTILS_MAISON.map((o) => o.handler).sort());
  });

  it('ne porte aucun bruit numérique', () => {
    // Même garde qu'en tâche 15 : un schéma dérivé d'un schéma Zod produit `minimum: -9007199254740991` et
    // consorts, qu'on paie dans le prompt à CHAQUE tour.
    expect(JSON.stringify(SCHEMA_PROPOSITION)).not.toContain('9007199254740991');
  });
});

describe('differences', () => {
  it('ne rend QUE ce qui change vraiment', () => {
    // Un modèle qui recopie l'objectif à l'identique ne doit pas produire de ligne : le client apprendrait à
    // cliquer « Garder » sans lire, et c'est l'habitude que ce diff existe pour empêcher.
    const courant: EtatCourant = { mentionIaFrequence: 'session', inactiviteMinutes: 30, fiche: { ...ficheVide(), objectif: 'Aider les clients.' }, outils: [] };
    expect(differences(courant, { message: 'x', fiche: { objectif: 'Aider les clients.' } })).toEqual([]);
    const change = differences(courant, { message: 'x', fiche: { objectif: 'Cerner le besoin.' } });
    expect(change).toHaveLength(1);
    expect(change[0]).toMatchObject({ champ: 'fiche.objectif', avant: 'Aider les clients.', apres: 'Cerner le besoin.' });
  });

  it('compare les règles d’arrêt sur leur contenu, pas sur leur objet', () => {
    const courant: EtatCourant = {
      mentionIaFrequence: 'session', inactiviteMinutes: 30,
      fiche: { ...ficheVide(), sorties: [{ code: 'rdv', label: 'Rendez-vous pris' }] },
      outils: [],
    };
    expect(differences(courant, { message: 'x', fiche: { sorties: [{ code: 'rdv', label: 'Rendez-vous pris' }] } })).toEqual([]);
    const change = differences(courant, {
      message: 'x',
      fiche: { sorties: [{ code: 'rdv', label: 'Rendez-vous pris' }, { code: 'devis', label: 'Devis demandé' }] },
    });
    expect(change[0]!.apres).toContain('devis');
  });

  it('🔴 un outil ABSENT est annoncé comme un ajout', () => {
    // Sans ça, le client verrait un diff de description sans comprendre qu'il crée aussi l'outil, donc qu'il
    // ajoute une capacité à son agent.
    const change = differences(COURANT(), {
      message: 'x',
      outils: [{ handler: 'poser_tag', description: 'Tague le contact.', nePasUtiliser: 'Pas de tag inventé.' }],
    });
    expect(change).toHaveLength(2);
    expect(change[0]!.label).toContain('à ajouter');
    expect(change[0]!.avant).toBe('');
  });

  it('un outil DÉJÀ posé n’est pas annoncé comme un ajout, et ses mots inchangés ne bougent pas', () => {
    const courant: EtatCourant = {
      mentionIaFrequence: 'session', inactiviteMinutes: 30,
      fiche: ficheVide(),
      outils: [{ handler: 'poser_tag', description: 'Tague le contact.', nePasUtiliser: 'Pas de tag inventé.' }],
    };
    expect(differences(courant, {
      message: 'x',
      outils: [{ handler: 'poser_tag', description: 'Tague le contact.', nePasUtiliser: 'Pas de tag inventé.' }],
    })).toEqual([]);
    const change = differences(courant, {
      message: 'x',
      outils: [{ handler: 'poser_tag', description: 'Tague le contact quand il dit ce qu’il cherche.', nePasUtiliser: 'Pas de tag inventé.' }],
    });
    expect(change).toHaveLength(1);
    expect(change[0]!.label).not.toContain('à ajouter');
  });

  it('une proposition vide rend une liste vide', () => {
    expect(differences(COURANT(), { message: 'Je n’ai rien à changer.' })).toEqual([]);
  });
});

/**
 * Les CONNECTEURS dans une proposition (lot L2, décision D-L2-4).
 *
 * 🔴 LA FRONTIÈRE NE BOUGE PAS. L'assistant peut réécrire les deux textes qui décident QUAND le modèle
 * appelle un connecteur. Il ne peut ni le créer, ni toucher à son adresse, à son secret, à son gabarit, à
 * ses paramètres, à son risque, ni à son activation : déclarer une source, c'est écrire une adresse réseau
 * et un secret, et cela reste un geste d'administrateur.
 */
describe('proposition : les connecteurs', () => {
  const etat: EtatCourant = {
    mentionIaFrequence: 'session',
    inactiviteMinutes: 30,
    fiche: ficheVide(),
    outils: [],
    connecteurs: [{ nom: 'lire_commande', titre: 'Lire une commande', description: 'ancien', nePasUtiliser: 'ancien non', origine: 'http' as const, sourceId: null }],
  };

  it('réécrit les mots d’un connecteur EXISTANT, et le diff les montre', () => {
    const p = propositionSchema.parse({
      message: 'voici',
      connecteurs: [{ nom: 'lire_commande', description: 'quand le client demande où en est sa commande', nePasUtiliser: 'jamais pour annuler' }],
    });
    const d = differences(etat, p);
    expect(d.map((x) => x.champ)).toEqual(['connecteur.lire_commande.description', 'connecteur.lire_commande.nePasUtiliser']);
    expect(d[0]!.avant).toBe('ancien');
  });

  it('🔴 un connecteur INCONNU est ignoré : l’assistant n’en crée pas', () => {
    // Sinon le client verrait un diff qui promet un branchement vers un système qui n'existe pas.
    const p = propositionSchema.parse({
      message: 'voici',
      connecteurs: [{ nom: 'appeler_stripe', description: 'x', nePasUtiliser: 'y' }],
    });
    expect(differences(etat, p)).toEqual([]);
  });

  it('🔴 rien de la SOURCE ne passe le schéma, même si le modèle l’écrit', () => {
    // `safeParse` sans `.strict()` écarte silencieusement : le modèle n'obtient rien, et la conversation ne
    // casse pas pour autant.
    const p = propositionSchema.parse({
      message: 'voici',
      connecteurs: [{
        nom: 'lire_commande', description: 'd', nePasUtiliser: 'n',
        baseUrl: 'https://evil.test', authSecret: 'vole', risk: 'read', actif: true, chemin: '/tout',
      }],
    });
    expect(Object.keys(p.connecteurs![0]!)).toEqual(['nom', 'description', 'nePasUtiliser']);
  });

  it('un connecteur proposé DEUX FOIS est refusé', () => {
    const r = propositionSchema.safeParse({
      message: 'x',
      connecteurs: [
        { nom: 'lire_commande', description: 'a', nePasUtiliser: '' },
        { nom: 'lire_commande', description: 'b', nePasUtiliser: '' },
      ],
    });
    expect(r.success).toBe(false);
  });
});
