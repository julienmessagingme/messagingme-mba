import { describe, expect, it } from 'vitest';
import { champEmailEffectif, champEmailSuggere, repartitionPrevue, type MesuresAudience } from './campagne-repartition';
import type { EtageAssistant } from './campagne-chaine';

/** Formateur TRIVIAL : la mise en forme locale n'est pas le sujet, et l'ICU d'une machine à l'autre varie. */
const brut = (n: number): string => String(n);

const CHAINE: EtageAssistant[] = [
  { rang: 1, canal: 'whatsapp' },
  { rang: 2, canal: 'rcs' },
  { rang: 3, canal: 'email' },
];

const MESURES: MesuresAudience = { retenus: 1000, connusInjoignables: 60, sansAdresse: 12 };

describe('repartitionPrevue', () => {
  it('dit combien partent au premier etage et combien basculent au second', () => {
    const lignes = repartitionPrevue(CHAINE, MESURES, brut);
    expect(lignes[0]?.nombre).toBe(940);
    expect(lignes[0]?.texte).toContain('940 partiront en WhatsApp');
    expect(lignes[1]?.nombre).toBe(60);
    expect(lignes[1]?.texte).toContain('60 basculeront en RCS');
  });

  /**
   * 🔴 LA LIGNE E-MAIL DIT CE QU'ON PERD, PAS CE QU'ON ATTEINT. Combien de contacts ARRIVERONT à cet
   * étage dépend des échecs des étages du dessus, qui ne se prévoient pas ; combien n'ont pas d'adresse
   * se compte. Une implémentation qui afficherait « 12 recevront un e-mail » passerait un test écrit sur
   * le seul nombre et annoncerait exactement le contraire de ce qui va se produire.
   */
  it('l etage e-mail annonce ceux qui n ont PAS d adresse', () => {
    const lignes = repartitionPrevue(CHAINE, MESURES, brut);
    expect(lignes[2]?.texte).toContain("12 n'ont pas d'adresse e-mail");
    expect(lignes[2]?.texte).not.toContain('recevront');
  });

  // ⚠️ L'AUTRE SENS : zéro est une PRÉVISION, pas un aveu. La phrase change, et elle rassure à raison.
  it('aucune fiche sans adresse le DIT, au lieu d annoncer « 0 n ont pas d adresse »', () => {
    const lignes = repartitionPrevue(CHAINE, { ...MESURES, sansAdresse: 0 }, brut);
    expect(lignes[2]?.nombre).toBe(0);
    expect(lignes[2]?.texte).toMatch(/Toutes les fiches/);
  });

  /**
   * 🔴 `null` N'EST PAS `0`, ET C'EST LE CŒUR DE CE MODULE. Un premier étage RCS n'a AUCUNE joignabilité
   * mémorisée (la seule mesure du produit est celle de WhatsApp, migration 0133) : annoncer « 0
   * basculeront » serait un chiffre faux et rassurant, sur l'écran qui précède l'envoi.
   */
  it('sans mesure applicable, aucun nombre n est annonce', () => {
    const rcsDAbord: EtageAssistant[] = [{ rang: 1, canal: 'rcs' }, { rang: 2, canal: 'whatsapp' }];
    const lignes = repartitionPrevue(
      rcsDAbord,
      { retenus: 1000, connusInjoignables: null, sansAdresse: null, motifNonPrevisible: 'canal' },
      brut,
    );
    expect(lignes[0]?.nombre).toBeNull();
    expect(lignes[1]?.nombre).toBeNull();
    expect(lignes[1]?.texte).toMatch(/pas prévisible/);
    expect(lignes[1]?.texte).toMatch(/mémorisée que sur WhatsApp/);
    // ⚠️ Et surtout : aucun « 0 » nulle part, qui serait lu comme une prévision.
    expect(lignes.map((l) => l.texte).join(' ')).not.toMatch(/\b0\b/);
  });

  /**
   * 🔴 UN `null` SANS MOTIF SE FAISAIT ATTRIBUER LE MAUVAIS, ET C'EST CE QUE CES DEUX CAS SÉPARENT.
   * Cette table n'avait qu'une seule raison de ne pas savoir (« la joignabilité n'est mémorisée que sur
   * WhatsApp ») et l'écrivait à CHAQUE `null`. Depuis que l'audience peut être une sélection de contacts,
   * il y en a une seconde, et un comptage qui échoue est une troisième : donner la première aux deux
   * autres enverrait chercher un problème de configuration là où il y a eu un hoquet réseau. Sans ces
   * cas, une implémentation qui rendrait toujours la même phrase passerait.
   */
  it('une audience choisie ligne a ligne dit que ce n est PAS un probleme de canal', () => {
    const lignes = repartitionPrevue(
      CHAINE,
      { retenus: 12, connusInjoignables: null, sansAdresse: null, motifNonPrevisible: 'selection' },
      brut,
    );
    expect(lignes[1]?.texte).toMatch(/sélection de contacts/);
    expect(lignes[1]?.texte).not.toMatch(/mémorisée que sur WhatsApp/);
    // ⚠️ ET LA LIGNE E-MAIL AVEC : dire « choisissez le champ » à quelqu'un qui l'a déjà choisi l'envoie
    // corriger un réglage parfaitement correct.
    expect(lignes[2]?.texte).toMatch(/décrite par des filtres/);
    expect(lignes[2]?.texte).not.toMatch(/Choisissez le champ/);
  });

  it('sans motif, le silence est un ECHEC DE LECTURE, pas une explication empruntee', () => {
    const lignes = repartitionPrevue(CHAINE, { retenus: 1000, connusInjoignables: null, sansAdresse: 12 }, brut);
    expect(lignes[1]?.texte).toMatch(/n'a pas pu être lu/);
    expect(lignes[1]?.texte).not.toMatch(/mémorisée que sur WhatsApp/);
    expect(lignes[1]?.texte).not.toMatch(/sélection de contacts/);
  });

  // ⚠️ Sans champ d'adresse choisi, l'écran demande le choix au lieu d'inventer un compte.
  it('sans champ d adresse choisi, l etage e-mail demande le choix', () => {
    const lignes = repartitionPrevue(CHAINE, { ...MESURES, sansAdresse: null }, brut);
    expect(lignes[2]?.nombre).toBeNull();
    expect(lignes[2]?.texte).toMatch(/champ qui porte l'adresse/);
  });

  /**
   * ⚠️ LES DEUX COMPTES VIENNENT DE DEUX REQUÊTES, DONC DE DEUX INSTANTS. Un import entre les deux peut
   * rendre le second plus grand que le premier ; « -40 partiront en WhatsApp » serait lu comme un bug de
   * l'écran plutôt que comme la course qu'il est.
   */
  it('un compte incoherent ne produit jamais un nombre negatif', () => {
    const lignes = repartitionPrevue(CHAINE, { retenus: 20, connusInjoignables: 60, sansAdresse: 0 }, brut);
    expect(lignes[0]?.nombre).toBe(0);
  });

  // ⚠️ La chaîne arrive d'un état d'écran : rien ne garantit son ordre, et une ligne « rang 2 » affichée
  // en premier ferait lire la bascule comme l'envoi initial.
  it('les lignes sortent dans l ordre des rangs, meme si la chaine arrive a l envers', () => {
    const alEnvers: EtageAssistant[] = [{ rang: 2, canal: 'rcs' }, { rang: 1, canal: 'whatsapp' }];
    const lignes = repartitionPrevue(alEnvers, MESURES, brut);
    expect(lignes.map((l) => l.rang)).toEqual([1, 2]);
    expect(lignes[0]?.texte).toContain('partiront');
  });
});

describe('champEmailSuggere', () => {
  it('propose le champ dont la CLE ressemble a une adresse', () => {
    expect(champEmailSuggere([{ key: 'ville', label: 'Ville' }, { key: 'email', label: 'Courriel' }])).toBe('email');
  });

  // ⚠️ La clé d'un champ créé depuis l'écran est dérivée du libellé, mais pas toujours : un import CSV
  // pose des clés brutes. Le LIBELLÉ est donc la seconde chance, jamais la première.
  it('retombe sur le LIBELLE quand la cle ne dit rien', () => {
    expect(champEmailSuggere([{ key: 'champ_12', label: 'E-mail pro' }])).toBe('champ_12');
  });

  /**
   * 🔴 RIEN PLUTÔT QU'UN CHAMP AU HASARD. Il n'existe AUCUNE convention de clé dans ce produit :
   * `contacts` n'a pas de colonne `email`, et un espace nommait le sien « mail » quand un autre le
   * nommait « email » (cas du 2026-08-25). Prendre le premier champ venu enverrait des e-mails à des
   * valeurs de « ville », et l'écran aurait l'air d'avoir choisi pour l'opérateur.
   */
  it('ne devine rien quand aucun champ ne ressemble a une adresse', () => {
    expect(champEmailSuggere([{ key: 'ville', label: 'Ville' }, { key: 'age', label: 'Âge' }])).toBeNull();
    expect(champEmailSuggere([])).toBeNull();
  });
});

describe('champEmailEffectif', () => {
  const CHAMPS = [{ key: 'ville', label: 'Ville' }, { key: 'email', label: 'Courriel' }];

  it('rend le champ CHOISI, meme si un autre ressemble davantage a une adresse', () => {
    expect(champEmailEffectif('ville', CHAMPS)).toBe('ville');
  });

  it('rend la suggestion quand rien n a ete choisi', () => {
    expect(champEmailEffectif(undefined, CHAMPS)).toBe('email');
  });

  /**
   * 🔴 UNE CHAÎNE VIDE EST UN CHOIX, PAS UNE ABSENCE. C'est l'option « Choisir... » du sélecteur : la
   * faire retomber sur la suggestion rendrait le champ impossible à RETIRER, et l'écran afficherait un
   * champ que l'opérateur venait de décocher.
   */
  it('une chaine vide retire le champ au lieu de re-suggerer', () => {
    expect(champEmailEffectif('', CHAMPS)).toBeNull();
  });

  it('sans champ plausible, rend null', () => {
    expect(champEmailEffectif(undefined, [{ key: 'ville', label: 'Ville' }])).toBeNull();
  });
});
