import { describe, expect, it } from 'vitest';
import { decider } from '../src/campaign/bascule';
import type { Etage } from '../src/campaign/etages';

/**
 * L'ÉTAGE E-MAIL, DERNIER MAILLON DE LA CHAÎNE.
 *
 * 🔴 CE QU'IL A DE PARTICULIER : SON DESTINATAIRE PEUT NE PAS EXISTER. Les deux autres canaux partent
 * vers le numéro du destinataire, qui est par construction présent (`campaign_recipients.to_e164` est
 * `not null`). L'adresse e-mail, elle, vit dans le jsonb `fields` du contact, sous une clé que le client
 * a choisie : elle peut être absente sur une fiche et présente sur la suivante. Basculer vers un étage
 * dont on sait déjà qu'il n'a personne à qui écrire produirait un envoi vide, compté comme une
 * tentative, et rangé en échec avec un code de fournisseur qui n'expliquerait rien.
 *
 * 🔴 `contacts` N'A PAS DE COLONNE `email`, VÉRIFIÉ DANS LES MIGRATIONS (0001 crée la table sans, 0002
 * ajoute le jsonb `fields`, et aucun des `alter table contacts` suivants n'en ajoute). Il n'existe pas
 * non plus de CONVENTION de clé : le dépôt porte la trace d'un espace qui l'appelait « mail » quand un
 * autre l'appelait « email » (`src/workflow/wiring.ts`, cas du 2026-08-25). C'est donc la campagne qui
 * dit quelle clé porte l'adresse, et la résolution vaut `null` quand la fiche ne l'a pas.
 */
const CHAINE_AVEC_EMAIL: Etage[] = [
  { rang: 1, canal: 'whatsapp' },
  { rang: 2, canal: 'rcs' },
  { rang: 3, canal: 'email', emailTemplateId: 'em-1' },
];

const base = { rangCourant: 1, reessayer: true, dejaReessaye: false, emailDuContact: null };

describe('l etage e-mail', () => {
  it('un contact sans adresse e-mail est terminal AVEC SA RAISON, pas un envoi vide', () => {
    expect(decider({ ...base, rangCourant: 2, chaine: CHAINE_AVEC_EMAIL, codeErreur: 131026, emailDuContact: null }))
      .toEqual({ type: 'terminal', motif: 'pas d adresse e-mail' });
  });

  /**
   * 🔴 L'AUTRE SENS, ET SANS LUI LE TEST DU DESSUS NE PROUVE RIEN. Une implémentation qui rendrait
   * TOUJOURS « pas d'adresse e-mail » devant un étage e-mail passerait le premier cas et supprimerait
   * l'étage e-mail du produit, en silence.
   */
  it('un contact QUI A une adresse bascule bien vers l etage e-mail', () => {
    expect(decider({ ...base, rangCourant: 2, chaine: CHAINE_AVEC_EMAIL, codeErreur: 131026, emailDuContact: 'a@b.fr' }))
      .toEqual({ type: 'bascule', rang: 3 });
  });

  /**
   * 🔴 LA GARDE NE VAUT QUE POUR L'ÉTAGE E-MAIL. Une adresse absente n'a aucun sens sur un étage RCS ou
   * WhatsApp, qui partent vers le numéro : appliquer la garde à toute la chaîne rendrait terminal le
   * repli le plus courant du produit (WhatsApp puis RCS) pour tous les contacts sans e-mail, c'est-à-dire
   * la quasi-totalité.
   */
  it('sans adresse, une bascule vers un etage RCS reste une bascule', () => {
    expect(decider({ ...base, rangCourant: 1, chaine: CHAINE_AVEC_EMAIL, codeErreur: 131026, emailDuContact: null }))
      .toEqual({ type: 'bascule', rang: 2 });
  });

  /**
   * 🔴 ET ELLE NE REND PAS LA MAIN À LA POLITIQUE DE RÉESSAI. Sortir par « pas d'adresse » ne doit pas
   * relancer le canal précédent : la chaîne EST le rattrapage, et elle est épuisée. C'est la même règle
   * que « plus d'étage disponible », avec un motif plus précis.
   */
  it('sans adresse, aucun reessai du canal precedent, meme option cochee', () => {
    const g = decider({ ...base, rangCourant: 2, chaine: CHAINE_AVEC_EMAIL, codeErreur: 500, reessayer: true, emailDuContact: null });
    expect(g.type).toBe('terminal');
  });

  it('le dernier etage ne reessaie pas, meme si l option de reessai est cochee', () => {
    expect(decider({ ...base, rangCourant: 3, chaine: CHAINE_AVEC_EMAIL, codeErreur: 500, reessayer: true }))
      .toEqual({ type: 'terminal', motif: 'plus d etage disponible' });
  });

  /**
   * ⚠️ UNE ADRESSE VIDE OU BLANCHE N'EST PAS UNE ADRESSE. Le jsonb d'un contact peut porter la clé avec
   * une chaîne vide (import CSV à colonne vide, champ effacé à l'écran) : la lire comme « il a une
   * adresse » enverrait vers rien du tout, et le fournisseur SMTP refuserait l'envoi entier.
   */
  it('une adresse vide ou blanche vaut une absence d adresse', () => {
    for (const vide of ['', '   ']) {
      expect(decider({ ...base, rangCourant: 2, chaine: CHAINE_AVEC_EMAIL, codeErreur: 131026, emailDuContact: vide }))
        .toEqual({ type: 'terminal', motif: 'pas d adresse e-mail' });
    }
  });

  /**
   * ⚠️ UN ÉTAGE E-MAIL AU MILIEU N'ARRÊTE PAS LA CHAÎNE POUR AUTANT. Rien n'impose que l'e-mail soit le
   * rang 3 : la migration 0134 borne les rangs à 3, pas leurs canaux. Un contact sans adresse doit
   * continuer vers l'étage d'APRÈS quand il y en a un, sinon on lui retirerait un canal joignable au
   * motif qu'un autre ne l'est pas.
   */
  it('sans adresse, on saute l etage e-mail au lieu de clore, s il reste un etage apres', () => {
    const emailAuMilieu: Etage[] = [
      { rang: 1, canal: 'whatsapp' },
      { rang: 2, canal: 'email', emailTemplateId: 'em-1' },
      { rang: 3, canal: 'rcs' },
    ];
    expect(decider({ ...base, rangCourant: 1, chaine: emailAuMilieu, codeErreur: 131026, emailDuContact: null }))
      .toEqual({ type: 'bascule', rang: 3 });
  });
});
