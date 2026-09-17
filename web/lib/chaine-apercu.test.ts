import { describe, it, expect } from 'vitest';
import { MAX_TEXTE_POST } from './api-chaine';
import {
  LIBELLE_BOUTON_DISCUTER, corpsDuPost, imageAffichable, liensAProposer, libelleLien, morceauxApercu,
  phraseAcceptable, pretAPublier,
  resteAAfficher,
  type BrouillonChaine,
} from './chaine-apercu';

/**
 * L'aperçu d'un post de chaîne.
 *
 * Ce que ces tests protègent, et qui ne se voit pas à la lecture :
 *
 *  1. 🔴 UN POST PUBLIÉ CIRCULE POUR TOUJOURS. L'aperçu est la dernière chose que le client voit avant que
 *     le message parte à toute une audience, sans retour arrière. S'il montre autre chose que ce qui part,
 *     l'erreur ne se découvre qu'une fois diffusée.
 *  2. Pas d'adresse, PAS de bouton. Un bouton dessiné dans l'aperçu alors qu'aucun lien `wa.me` ne part
 *     promettrait une conversation que le post ne peut pas ouvrir.
 *  3. Le front ne FABRIQUE aucune adresse : il affiche celle que le serveur lui donne. Ces tests ne
 *     construisent donc jamais d'URL `wa.me`, ils en reçoivent une.
 */

const brouillon = (p: Partial<BrouillonChaine> = {}): BrouillonChaine => ({
  texte: 'Nouvelle collection disponible',
  imageUrl: '',
  linkId: '',
  ...p,
});

// Une adresse telle que le SERVEUR la rend (composée par `lienWaMe`), jamais fabriquée ici.
// La PHRASE seule depuis le 2026-09-07 : le jeton n est plus dans le texte envoye.
const WA_ME = 'https://wa.me/33525680250?text=Je%20veux%20la%20newsletter';

describe('morceauxApercu : qui écrit quoi, et dans quel ordre', () => {
  it('sans adresse : le texte seul, et AUCUN bouton', () => {
    // C'est le cas d'un tenant sans numéro WhatsApp connecté (le serveur rend `waMeUrl: null`) et celui
    // d'une publication volontairement sans scénario. Les deux montrent un post nu.
    expect(morceauxApercu('Coucou', null)).toEqual([{ kind: 'texte', contenu: 'Coucou' }]);
  });

  it('avec adresse : le texte, PUIS le lien, PUIS le bouton, dans cet ordre', () => {
    // L'ordre est celui du serveur : `texteDuPost = `${text}\n\n${url}``. Un aperçu qui mettrait le lien
    // avant le texte montrerait un post que personne ne recevra.
    expect(morceauxApercu('Coucou', WA_ME)).toEqual([
      { kind: 'texte', contenu: 'Coucou' },
      { kind: 'lien', contenu: WA_ME },
      { kind: 'bouton', contenu: LIBELLE_BOUTON_DISCUTER },
    ]);
  });

  it('texte vide mais lien présent : le bouton reste, le morceau de texte disparaît', () => {
    expect(morceauxApercu('   ', WA_ME).map((m) => m.kind)).toEqual(['lien', 'bouton']);
  });

  it('une adresse VIDE ne vaut pas une adresse : toujours pas de bouton', () => {
    // Le serveur rend `null`, mais une lecture défensive au bord du réseau peut poser une chaîne vide.
    // Dessiner un bouton dessus promettrait une conversation impossible.
    expect(morceauxApercu('Coucou', '')).toEqual([{ kind: 'texte', contenu: 'Coucou' }]);
  });

  it('le libellé du bouton n’est jamais dérivé du texte du post ni de l’adresse', () => {
    // 🔴 Mesuré : WhatsApp dessine ce bouton lui-même et son libellé n'est pas modifiable. Le paramètre
    // `text=` de l'adresse est le message que l'abonné ENVOIE, pas le libellé. Un aperçu qui afficherait
    // le contenu de `text=` sur le bouton ferait croire à un libellé réglable.
    const bouton = morceauxApercu('Un texte bien à part', WA_ME).find((m) => m.kind === 'bouton');
    expect(bouton!.contenu).toBe(LIBELLE_BOUTON_DISCUTER);
    expect(bouton!.contenu).not.toContain('newsletter');
  });
});

describe('imageAffichable : la même exigence que le serveur, dite plus tôt', () => {
  it('accepte une https publique et rend l’adresse nettoyée', () => {
    expect(imageAffichable('  https://cdn.exemple.test/photo.jpg  ')).toBe('https://cdn.exemple.test/photo.jpg');
  });

  it('refuse http : le serveur exige https et répondrait 400', () => {
    expect(imageAffichable('http://cdn.exemple.test/photo.jpg')).toBeNull();
  });

  it('refuse localhost et une IP littérale : le serveur les refuse aussi', () => {
    expect(imageAffichable('https://localhost/photo.jpg')).toBeNull();
    expect(imageAffichable('https://127.0.0.1/photo.jpg')).toBeNull();
    expect(imageAffichable('https://169.254.169.254/latest/meta-data')).toBeNull();
  });

  it('refuse ce qui n’est pas une adresse, et le champ vide', () => {
    expect(imageAffichable('photo.jpg')).toBeNull();
    expect(imageAffichable('')).toBeNull();
    expect(imageAffichable('   ')).toBeNull();
  });

  it('refuse au-delà de 2000 caractères, la borne du serveur', () => {
    expect(imageAffichable(`https://ex.test/${'a'.repeat(2000)}`)).toBeNull();
  });
});

describe('pretAPublier : ce qui autorise le bouton Publier', () => {
  it('un texte suffit : un post sans bouton est une publication valable', () => {
    expect(pretAPublier(brouillon())).toBe(true);
  });

  it('un texte vide ou blanc ne publie pas', () => {
    expect(pretAPublier(brouillon({ texte: '' }))).toBe(false);
    expect(pretAPublier(brouillon({ texte: '   ' }))).toBe(false);
  });

  it('la borne du texte est celle du serveur, pas une de plus', () => {
    expect(pretAPublier(brouillon({ texte: 'a'.repeat(MAX_TEXTE_POST) }))).toBe(true);
    expect(pretAPublier(brouillon({ texte: 'a'.repeat(MAX_TEXTE_POST + 1) }))).toBe(false);
  });

  it('🔴 une image SAISIE mais invalide bloque la publication', () => {
    // Ni publier en l'ignorant (l'image ne partirait pas, et l'écran laisserait croire le contraire), ni
    // partir avec (le serveur répondrait 400 après coup).
    expect(pretAPublier(brouillon({ imageUrl: 'http://pas-https.test/a.jpg' }))).toBe(false);
  });

  it('un champ image vide ne bloque rien', () => {
    expect(pretAPublier(brouillon({ imageUrl: '   ' }))).toBe(true);
  });
});

describe('phraseAcceptable : la borne du serveur, 300 et pas 60', () => {
  it('accepte jusqu’à 300 caractères, la valeur de lienSchema.phrase', () => {
    // Le plan portait 60 en affirmant que c'était « la même valeur que le serveur ». Un front qui refuse à
    // 61 ce que le serveur accepte à 300 refuse en son nom propre tout en prétendant citer le serveur.
    expect(phraseAcceptable('a'.repeat(300))).toBe(true);
    expect(phraseAcceptable('a'.repeat(301))).toBe(false);
  });

  it('refuse le vide et le blanc', () => {
    expect(phraseAcceptable('')).toBe(false);
    expect(phraseAcceptable('   ')).toBe(false);
  });
});

describe('resteAAfficher : le compteur ne sort qu’en approche', () => {
  it('reste muet loin de la borne : un compteur permanent sur 4096 caractères est du bruit', () => {
    expect(resteAAfficher(10, MAX_TEXTE_POST)).toBeNull();
  });

  it('parle en approche, et compte juste', () => {
    expect(resteAAfficher(MAX_TEXTE_POST - 5, MAX_TEXTE_POST)).toBe(5);
  });

  it('rend un nombre négatif au-delà : l’écran doit pouvoir dire de combien on dépasse', () => {
    expect(resteAAfficher(MAX_TEXTE_POST + 3, MAX_TEXTE_POST)).toBe(-3);
  });

  it('sur un champ court, le seuil reste utilisable (plancher de 20)', () => {
    expect(resteAAfficher(5, 60)).toBeNull();
    expect(resteAAfficher(45, 60)).toBe(15);
  });
});

describe('corpsDuPost', () => {
  const URL = 'https://wa.me/33525680250?text=Je%20veux%20le%20guide';

  it('🔴 retire l’adresse wa.me que le serveur a collée au corps', () => {
    // Le texte STOCKE d un post vaut corps + deux sauts de ligne + adresse. La liste des publications le
    // donnait ENTIER au formateur, alors que l apercu ne met en forme que le corps : ce n etait donc pas
    // « le meme rendu », c etait un autre traitement sur une autre entree.
    expect(corpsDuPost('Notre *promo*' + '\n\n' + URL, URL)).toBe('Notre *promo*');
  });

  it('🔴 preuve inverse : la MEME chaine ailleurs qu en fin de texte n est PAS retiree', () => {
    // Sans ce sens-la, une implementation qui ferait un remplacement global passerait le test precedent en
    // mutilant le corps d un client qui cite son propre lien.
    const texte = 'Voir ' + URL + ' pour la suite';
    expect(corpsDuPost(texte + '\n\n' + URL, URL)).toBe(texte);
  });

  it('🔴 retire aussi l’adresse des posts d’AVANT la bascule du jeton', () => {
    // Leur texte pre-rempli portait le jeton, donc leur adresse encodee n est PLUS celle que le serveur
    // recompose aujourd hui a partir de la phrase seule. Une comparaison exacte ne les reconnaissait pas :
    // ces posts affichaient leur adresse entiere dans la liste. Ils circulent pour toujours.
    const ancienne = 'https://wa.me/33525680250?text=Je%20veux%20le%20guide%20(cm-a7k2m9p3)';
    expect(corpsDuPost('Notre offre\n\n' + ancienne, URL)).toBe('Notre offre');
  });

  it('🔴 preuve inverse : une adresse wa.me au MILIEU du texte n est pas touchee', () => {
    // La regle est ancree en fin de texte. Un client qui cite sa propre adresse ne doit rien perdre.
    const texte = 'Ecris-moi sur https://wa.me/33123456789 quand tu veux';
    expect(corpsDuPost(texte, null)).toBe(texte);
  });

  it('adresse inconnue (lien supprimé, post sans bouton) : le texte est rendu tel quel', () => {
    expect(corpsDuPost('Un post nu', null)).toBe('Un post nu');
    expect(corpsDuPost('Un post nu', '')).toBe('Un post nu');
  });

  it('un post sans texte reste vide', () => {
    expect(corpsDuPost('', URL)).toBe('');
  });
});

/**
 * LE DEROULANT DU BOUTON « DISCUTER » : trois liens, et le scenario nomme.
 *
 * 🔴 CE QUE CES TESTS PROTEGENT VRAIMENT, ET QUI NE SE VOIT PAS EN LISANT LE COMPOSANT. Un lien de chaine
 * ne se supprime JAMAIS (sa phrase est sa cle de routage depuis la migration 0116, et les publications
 * deja parties la portent). La liste ne peut donc que grandir, et « garder les 3 derniers » ne peut vouloir
 * dire que « n'en montrer que 3 ». Un test qui verifierait une SUPPRESSION passerait au vert en cassant
 * tous les boutons en circulation.
 */
describe('liensAProposer', () => {
  const L = (id: string, jour: string, workflowId = 'w1') => ({ id, createdAt: `2026-03-${jour}T10:00:00Z`, workflowId, phrase: `p-${id}` });
  const CINQ = [L('a', '01'), L('b', '02'), L('c', '03'), L('d', '04'), L('e', '05')];

  it('🔴 n’en propose que TROIS, les plus recents', () => {
    expect(liensAProposer(CINQ, '', false).map((l) => l.id)).toEqual(['e', 'd', 'c']);
  });

  it('🔴 TRIE lui-meme, il ne suppose pas la liste ordonnee', () => {
    // La route rend les liens dans l'ordre qui l'arrange. « Les 3 derniers » d'une liste non triee ne veut
    // rien dire, et le defaut serait invisible : trois liens s'afficheraient, simplement pas les bons.
    const melange = [CINQ[2]!, CINQ[0]!, CINQ[4]!, CINQ[1]!, CINQ[3]!];
    expect(liensAProposer(melange, '', false).map((l) => l.id)).toEqual(['e', 'd', 'c']);
  });

  it('🔴 le lien DEJA CHOISI reste propose, meme s’il est vieux', () => {
    // Sans lui : on deplie tout, on choisit un lien de mars, on replie, et le `<select>` retombe sur
    // « Aucun bouton » alors que le brouillon porte toujours ce lien. Un `<select>` dont la valeur n'est
    // dans aucune `<option>` n'affiche rien et ne previent pas : l'ecran mentirait sur ce qui va partir.
    expect(liensAProposer(CINQ, 'a', false).map((l) => l.id)).toEqual(['e', 'd', 'c', 'a']);
  });

  it('un lien choisi qui est DEJA dans les trois ne s’y ajoute pas deux fois', () => {
    expect(liensAProposer(CINQ, 'd', false).map((l) => l.id)).toEqual(['e', 'd', 'c']);
  });

  it('un identifiant choisi INTROUVABLE ne fait pas tomber la liste', () => {
    // Cas reel : un brouillon garde en memoire pointe un lien qu'une autre session a fait disparaitre de
    // la reponse. Le bon comportement est de rendre les trois recents, pas de jeter.
    expect(liensAProposer(CINQ, 'jamais-vu', false).map((l) => l.id)).toEqual(['e', 'd', 'c']);
  });

  it('deplie, il rend TOUT, toujours trie', () => {
    expect(liensAProposer(CINQ, '', true).map((l) => l.id)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('moins de trois liens : il les rend tous, sans inventer de place vide', () => {
    expect(liensAProposer([CINQ[0]!, CINQ[1]!], '', false).map((l) => l.id)).toEqual(['b', 'a']);
    expect(liensAProposer([], '', false)).toEqual([]);
  });

  it('deux liens crees la MEME seconde gardent un ordre stable', () => {
    // Sans le depart par identifiant, l'ordre depend de l'implementation du tri et peut changer d'un rendu
    // a l'autre : le deroulant se reordonnerait sous le curseur.
    const jumeaux = [L('z', '09'), L('y', '09')];
    expect(liensAProposer(jumeaux, '', false).map((l) => l.id)).toEqual(['y', 'z']);
    expect(liensAProposer([...jumeaux].reverse(), '', false).map((l) => l.id)).toEqual(['y', 'z']);
  });

  it('⚠️ il ne SUPPRIME rien : la liste d’entree est rendue intacte', () => {
    // La garde qui compte. Supprimer un lien tuerait le bouton des publications deja diffusees.
    const avant = CINQ.map((l) => l.id);
    liensAProposer(CINQ, '', false);
    expect(CINQ.map((l) => l.id)).toEqual(avant);
  });
});

describe('libelleLien', () => {
  const SCENARIOS = [{ id: 'w1', name: 'Bienvenue' }, { id: 'w2', name: 'Relance J+3' }];

  it('🔴 nomme le SCENARIO, parce que c’est le defaut signale', () => {
    // Julien, 2026-09-17 : « on ne sait plus a quel scenario chaque bouton a ete associe ». Le deroulant
    // n'affichait que la phrase. Raccourcir la liste sans nommer la destination aurait laisse le probleme
    // entier sur une liste plus courte.
    expect(libelleLien({ phrase: 'Je veux le guide', workflowId: 'w2' }, SCENARIOS)).toBe('Je veux le guide → Relance J+3');
  });

  it('🔴 scenario introuvable : la phrase SEULE, jamais « undefined » ni un identifiant', () => {
    // Le cas arrive pour de vrai : un scenario supprime laisse son lien vivant, puisque le lien ne se
    // supprime pas.
    expect(libelleLien({ phrase: 'Je veux le guide', workflowId: 'parti' }, SCENARIOS)).toBe('Je veux le guide');
    expect(libelleLien({ phrase: 'Je veux le guide', workflowId: 'w1' }, [])).toBe('Je veux le guide');
  });
});
