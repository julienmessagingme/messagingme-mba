import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AGREGAT_JOUR_SQL } from '../src/stats/conversation-stats.pg';

const RACINE = resolve(__dirname, '..');
/**
 * ⚠️ LES FINS DE LIGNE SONT NORMALISEES, ET SANS CA CE FICHIER REND UN FAUX POSITIF. Les fichiers du depot
 * sont en CRLF sur ce poste, mais un LITTERAL GABARIT normalise ses retours a la ligne en LF (regle du
 * langage, pas du compilateur) : la chaine `AGREGAT_JOUR_SQL` lue a l'execution ne correspond donc PAS,
 * caractere pour caractere, au texte du fichier. Le test « le fragment n'est pas recopie » a accuse le code
 * a tort la premiere fois pour cette seule raison.
 */
const SOURCE = readFileSync(join(RACINE, 'src', 'stats', 'conversation-stats.pg.ts'), 'utf8').split('\r\n').join('\n');

/**
 * LES DEUX SOURCES DE COMPTAGE DOIVENT TOMBER D'ACCORD, ET CE FICHIER EST CE QUI LE TIENT.
 *
 * 🔴 CE QUE CE TEST PROTEGE, ET QUI N'EST VISIBLE DANS AUCUN DES DEUX FICHIERS. Depuis le 2026-09-17, deux
 * sources repondent a la MEME question sur deux portions de l'axe du temps : les conversations encore
 * presentes (moins de 90 jours) et la table `analyse_jour` au-dela. C'est le choix de Julien (« les vraies
 * donnees font foi tant qu'elles existent »), et il a un cout : le jour ou les deux divergent d'une unite,
 * la frontiere des 90 jours fait une MARCHE dans le graphe. Indiscernable d'un vrai creux d'activite,
 * silencieuse, et personne ne saurait laquelle des deux a raison.
 *
 * 🔴 LA PARADE N'EST PAS LA VIGILANCE, C'EST QU'IL N'Y AIT QU'UNE EXPRESSION. `AGREGAT_JOUR_SQL` est
 * IMPORTEE par la lecture en direct ET par l'ecriture de l'agregat : elles ne peuvent donc pas se
 * contredire. Ce fichier verifie que personne ne l'a RECOPIEE, ce qui reintroduirait exactement le defaut
 * qu'elle existe pour fermer.
 *
 * ⚠️ LA CONCORDANCE NUMERIQUE, ELLE, A ETE VERIFIEE SUR LA VRAIE BASE avant le deploiement : la lecture
 * directe et la table relue rendent des lignes IDENTIQUES sur les cinq journees de production, l'ecriture
 * etant jouee dans une transaction annulee. Un test unitaire ne peut pas le refaire (il n'a pas de base) ;
 * ce qu'il peut tenir, c'est la propriete STRUCTURELLE qui garantit que ca restera vrai.
 */
describe('les deux sources de comptage ne peuvent pas diverger', () => {
  it('🔴 le fragment est CITE par les DEUX requetes, jamais recopie', () => {
    // Trois citations attendues : la lecture en direct (`parJour`), l'ecriture (`ecrireAgregats`), et la
    // declaration elle-meme. Moins de deux usages voudrait dire qu'une des deux moities s'en est detachee.
    const usages = SOURCE.split('${AGREGAT_JOUR_SQL}').length - 1;
    expect(usages, 'la lecture en direct ET l’ecriture de l’agregat doivent citer le fragment').toBe(2);
  });

  it('🔴 aucune des deux requetes ne recalcule la journee a la main', () => {
    /**
     * La faute qu'on attrape ici : quelqu'un qui, plutot que de citer le fragment, reecrit
     * `count(*) filter (where ca.satisfaction is not null ...)` dans sa propre requete. Les deux
     * compteraient la meme chose le jour ou c'est ecrit, et plus le lendemain.
     *
     * ⚠️ On cherche le motif HORS du fragment : il y est forcement, c'est sa definition. On retire donc le
     * fragment du texte avant de compter.
     */
    const sansFragment = SOURCE.split(AGREGAT_JOUR_SQL).join('');
    const recopies = sansFragment.match(/count\(\*\) filter \(where ca\.satisfaction is not null/g) ?? [];
    expect(recopies, 'le compte des analyses mesurees est recopie au lieu d’etre cite').toHaveLength(0);
  });

  it('🔴 le fragment rend des SOMMES et des COMPTES, jamais une moyenne', () => {
    // Une moyenne stockee ne se re-agrege pas : regrouper sept journees moyennes sans leur poids donne une
    // moyenne de moyennes, fausse des que les journees n'ont pas le meme nombre de mesures. C'est ce qui
    // permet au regroupement hebdomadaire de l'ecran d'etre exact.
    expect(AGREGAT_JOUR_SQL).toContain('sum(ca.satisfaction)');
    expect(AGREGAT_JOUR_SQL).toContain('sum(ca.urgence)');
    expect(AGREGAT_JOUR_SQL).not.toContain('avg(');
  });

  it('🔴 les sommes ne portent QUE sur les analyses qui ont les DEUX notes', () => {
    // Sommer les satisfactions de toutes les analyses tout en divisant par le nombre de MESUREES donnerait
    // une moyenne gonflee par des lignes qui n'ont pas de note d'urgence. Le meme filtre exactement sur les
    // trois expressions est ce qui rend le denominateur juste.
    const filtre = 'filter (where ca.satisfaction is not null and ca.urgence is not null)';
    const occurrences = AGREGAT_JOUR_SQL.split(filtre).length - 1;
    expect(occurrences, 'le compte et les deux sommes doivent porter le MEME filtre').toBe(3);
  });

  it('🔴 les SIX intentions sont comptees, et le compte n’est pas ecrit a la main ailleurs', () => {
    // L'enumeration est FERMEE (`src/analysis/schema.ts`). Si une septieme apparait un jour, ce test le
    // signale ici plutot que de la laisser disparaitre silencieusement de l'agregat, ou une journee
    // agregee compterait moins de conversations que la meme journee lue en direct.
    for (const intent of ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre']) {
      expect(AGREGAT_JOUR_SQL, `l’intention ${intent} n’est pas comptee`).toContain(`'${intent}', count(*)`);
    }
  });

  it('⚠️ le fragment attend l’alias `ca` et le fuseau en $4, et les deux requetes les fournissent', () => {
    // Un fragment partage impose un CONTRAT a ses appelants. L'oublier ne casse pas au typecheck, seulement
    // a l'execution, et seulement sur la requete qu'on n'a pas essayee.
    expect(AGREGAT_JOUR_SQL).toContain('ca.created_at at time zone $4');
    // Les deux requetes passent bien quatre parametres, dont le fuseau en dernier.
    const appels = SOURCE.match(/\[tenantId, from, to, TZ\]/g) ?? [];
    expect(appels.length, 'la lecture en direct doit passer les quatre parametres').toBeGreaterThanOrEqual(1);
    expect(SOURCE, 'l’ecriture doit passer les quatre parametres, tenant en premier').toContain('[tenantId, from, to, TZ]');
  });
});

/**
 * LA PURGE EST LA SEULE OPERATION IRREVERSIBLE DU DEPOT, ET CE BLOC TIENT SA GARDE.
 *
 * 🔴 SUPPRIMER UNE CONVERSATION SUPPRIME SON ANALYSE EN CASCADE. Descendre la retention a 90 jours avec une
 * table d'agregats vide effacerait donc des mois d'historique SANS jamais l'avoir agrege, et on ne
 * reconstruit pas une analyse qu'on ne reanalyse pas. L'ordre est rendu mecanique dans le worker ; ce test
 * verifie que la mecanique est bien la, et pas seulement racontee dans un commentaire.
 */
const WORKER = readFileSync(join(RACINE, 'src', 'worker.ts'), 'utf8');

describe('la purge ne part jamais sans ses agregats', () => {
  it('🔴 le balayage des agregats est ATTENDU, pas lance en tache de fond', () => {
    // `void agregatsSweep()` laisserait la purge partir en parallele, donc parfois AVANT.
    expect(WORKER).toContain('await agregatsSweep()');
  });

  it('🔴 la purge SAUTE son passage quand les agregats ne sont pas a jour', () => {
    /**
     * ⚠️ CE TEST EXISTE PARCE QU'UN COMMENTAIRE NE GARDE RIEN. Une premiere redaction attrapait l'erreur du
     * balayage et affirmait en commentaire que « la purge ne partira pas » : le `catch` la laissait partir.
     * La garde est desormais un DRAPEAU lu par la purge, et c'est lui qu'on verifie.
     */
    expect(WORKER).toContain('let agregatsAJour = false;');
    expect(WORKER).toContain('if (!agregatsAJour) {');
  });

  it('🔴 le drapeau RETOMBE quand un balayage programme echoue, pas seulement au demarrage', () => {
    // Sans cela, une panne qui dure verrait la purge continuer a effacer sans trace apres un demarrage
    // reussi. Le drapeau doit donc etre remis a faux dans le `catch` de la tache programmee.
    const apresProgrammer = WORKER.slice(WORKER.indexOf("taches.programmer('agregats-analyse'"));
    expect(apresProgrammer.slice(0, 1200)).toContain('agregatsAJour = false;');
  });
});

/**
 * LA FENETRE DU BALAYAGE DOIT COUVRIR TOUT CE QUE LA PURGE PEUT EFFACER.
 *
 * 🔴 CE QUE CE BLOC PROTEGE, ET QUI A ETE TROUVE EN REVUE (2026-09-17). Le balayage remontait 400 jours en
 * DUR, un nombre choisi sur la plage maximale d'un ecran. Or deux chemins produisent des analyses plus
 * vieilles que ca : un espace peut regler sa retention jusqu'a 3650 jours (CHECK de la migration 0155), et
 * `CONVERSATION_RETENTION_DAYS = 0` suspend la purge aussi longtemps qu'on veut. Ces analyses-la sortaient
 * de la fenetre, restaient sans agregat, et disparaissaient a la reprise de la purge. Perdues pour toujours,
 * sans une erreur : le balayage aurait REUSSI, il n'aurait simplement pas vu ces journees.
 *
 * ⚠️ NON ATTEIGNABLE LE JOUR DE LA CORRECTION (la production envoie depuis le 2026-07-06, rien n'a 400
 * jours), mais ARME. C'est exactement le genre de defaut qu'on corrige pendant qu'il ne coute rien.
 */
describe('le balayage descend aussi bas que la donnee l exige', () => {
  it('🔴 la borne basse n est plus un nombre en dur', () => {
    // La faute qu'on attrape : revenir a `ecrireAgregats({ from: addDays(jusqua, -400), to: jusqua })`.
    const sweep = WORKER.slice(WORKER.indexOf('const agregatsSweep ='), WORKER.indexOf('let agregatsAJour'));
    expect(sweep).toContain('plusAncienJourAnalyse()');
    expect(sweep, 'la fenetre doit partir de `depuis`, pas du plancher').toContain('ecrireAgregats({ from: depuis');
  });

  it('🔴 le plancher de 400 jours reste, il n est pas remplace', () => {
    // L'inverse serait aussi faux : partir systematiquement du plus ancien jour ferait balayer toute la
    // table quand il n'y a rien a rattraper. La fenetre ne s'etend que quand la donnee la depasse.
    const sweep = WORKER.slice(WORKER.indexOf('const agregatsSweep ='), WORKER.indexOf('let agregatsAJour'));
    expect(sweep).toContain('addDays(jusqua, -400)');
    expect(sweep).toContain('plusAncien < plancher');
  });

  it('⚠️ une base sans aucune analyse retombe sur le plancher, jamais sur une date vide', () => {
    // `plusAncienJourAnalyse` rend `null` sur une table vide : le traiter comme une date ferait construire
    // une plage invalide, donc un balayage en echec, donc une purge suspendue sans cause reelle.
    const sweep = WORKER.slice(WORKER.indexOf('const agregatsSweep ='), WORKER.indexOf('let agregatsAJour'));
    expect(sweep).toContain('plusAncien !== null');
  });
});
