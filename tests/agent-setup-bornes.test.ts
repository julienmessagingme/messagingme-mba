import { describe, it, expect } from 'vitest';
import {
  assainirProposition, differences, propositionSchema, SCHEMA_PROPOSITION, type EtatCourant,
} from '../src/agent/setup/proposition';
import { ficheVide } from '../src/agent/fiche';

/** Un agent qui a DÉJÀ des règles d'arrêt : c'est le seul état où un effacement se voit. */
const COURANT_AVEC_SORTIES: EtatCourant = {
  mentionIaFrequence: 'session', inactiviteMinutes: 30, outils: [],
  fiche: { ...ficheVide(), sorties: [{ code: 'rdv', label: 'Rendez-vous pris' }] },
};

/**
 * L'ASSAINISSEMENT : ramener la réponse du modèle dans les bornes plutôt que perdre le tour (2026-09-17).
 *
 * 🔴 CE QUI S'EST PASSÉ. Julien, au 9e point sur 10 de l'entretien de construction : « l'assistant a rendu
 * une proposition hors format ». Ce tour-là est le PREMIER du temps 2, celui où le mandat demande enfin
 * d'écrire tous les champs : c'est donc le premier où les bornes s'exercent, et n'importe laquelle d'entre
 * elles faisait perdre le tour ENTIER, message du client compris (la route n'écrit l'entretien qu'APRÈS une
 * réponse valide du modèle).
 *
 * 🔴 CE QUE CES TESTS GARDENT, ET CE QU'ILS NE GARDENT PAS. Ils exigent que l'HYGIÈNE (une longueur, un
 * slug, un doublon) cesse d'être fatale. Ils exigent AUSSI, dans le même souffle, que la FRONTIÈRE DE
 * SÉCURITÉ ne bouge pas d'un pouce : un handler hors catalogue reste refusé, une clé de sécurité reste
 * écartée. Les deux moitiés vont ensemble, et un correctif qui n'aurait que la première serait le vrai
 * défaut.
 */
describe('assainirProposition', () => {
  /** La proposition du temps 2, telle qu'un modèle PARFAITEMENT coopératif l'écrit : elle respecte chaque
   *  consigne du mandat (codes en minuscules et tirets bas, commençant et finissant par une lettre). */
  const temps2 = () => ({
    message: 'Voici ce que je propose pour votre agent.',
    fiche: {
      nom: 'Léa',
      ton: 'Vouvoiement, phrases courtes, avec des emoji.',
      sorties: [
        { code: 'essai_routier_programme', label: 'Essai routier programmé' },
        // 36 caractères : conforme à TOUT ce qu'on avait écrit au modèle, et refusé par une regex qui
        // plafonne à 32 sans que ce nombre figure nulle part ailleurs qu'en elle.
        { code: 'coordonnees_transmises_au_conseiller', label: 'Coordonnées transmises au conseiller' },
      ],
    },
  });

  it('🔴 une proposition conforme à TOUT ce qu’on a écrit au modèle n’est plus refusée', () => {
    // La preuve inverse, dans le même test : sans l'assainissement, ce même objet rend `success: false`,
    // donc un 422 et un tour perdu. C'est le défaut signalé, reproduit.
    expect(propositionSchema.safeParse(temps2()).success).toBe(false);

    const r = propositionSchema.safeParse(assainirProposition(temps2()));
    expect(r.success).toBe(true);
    // Le code est RAMENÉ, pas jeté : la règle d'arrêt survit, avec le code exact que le formulaire aurait
    // produit pour la même saisie.
    expect(r.success && r.data.fiche!.sorties).toEqual([
      { code: 'essai_routier_programme', label: 'Essai routier programmé' },
      { code: 'coordonnees_transmises_au_consei', label: 'Coordonnées transmises au conseiller' },
    ]);
  });

  it('🔴 la FRONTIÈRE DE SÉCURITÉ ne bouge pas : un handler hors catalogue reste REFUSÉ', () => {
    // L'assainissement touche à l'hygiène, JAMAIS à une énumération fermée. Un modèle orienté par un
    // contenu tiers hostile ne gagne rien à ce correctif.
    const brut = { message: 'Voici.', outils: [{ handler: 'rm_rf', description: 'Efface tout.' }] };
    expect(propositionSchema.safeParse(assainirProposition(brut)).success).toBe(false);
  });

  it('🔴 les clés de sécurité restent ÉCARTÉES, l’assainissement n’en ajoute aucune', () => {
    const r = propositionSchema.safeParse(assainirProposition({
      message: 'Voici.', mentionIa: 'Vous parlez à un humain.', maxTours: 999, status: 'active',
    }));
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty('mentionIa');
    expect(r.data).not.toHaveProperty('maxTours');
    expect(r.data).not.toHaveProperty('status');
  });

  it('un champ que le modèle n’a pas écrit reste ABSENT après assainissement', () => {
    // Sinon une proposition qui ne parle pas d'outils deviendrait une proposition qui en propose zéro.
    const a = assainirProposition({ message: 'Voici.' }) as Record<string, unknown>;
    expect('outils' in a).toBe(false);
    expect('fiche' in a).toBe(false);
    // ⚠️ DANS LA FICHE AUSSI, et pas seulement à la racine : la fiche est le seul objet imbriqué que
    // l'assainissement reconstruit, donc le seul où l'oubli serait invisible.
    const f = (assainirProposition({ message: 'Voici.', fiche: { ton: 'Vouvoiement.' } }) as any).fiche;
    expect('sorties' in f).toBe(false);
    expect(f).toEqual({ ton: 'Vouvoiement.' });
  });

  it('n’altère JAMAIS l’objet qu’on lui donne', () => {
    // Le journal du refus doit pouvoir décrire ce que le modèle a VRAIMENT écrit.
    const brut = temps2();
    assainirProposition(brut);
    expect(brut.fiche.sorties[1]!.code).toBe('coordonnees_transmises_au_conseiller');
  });

  it('🔴 deux codes qui se REJOIGNENT une fois tronqués ne font pas tomber le tour', () => {
    // Le `refine` d'unicité aurait refusé toute la proposition. On garde le premier, exactement comme le
    // fait déjà la LECTURE du catalogue (`agent-store.pg.ts`, qui écarte un doublon en silence).
    const r = propositionSchema.safeParse(assainirProposition({
      message: 'Voici.',
      fiche: {
        sorties: [
          { code: 'demande_transmise_au_service_client_a', label: 'Vers le service client' },
          { code: 'demande_transmise_au_service_client_b', label: 'Vers le service client bis' },
        ],
      },
    }));
    expect(r.success).toBe(true);
    expect(r.success && r.data.fiche!.sorties).toHaveLength(1);
  });

  /**
   * 🔴 RELEVÉ EN REVUE SUR LE CORRECTIF LUI-MÊME (2026-09-17), et c'est le seul endroit où l'assainissement
   * pouvait être DESTRUCTEUR. `fiche.sorties` est le seul champ que le patch REMPLACE au lieu de fusionner :
   * une liste dont plus rien ne survit, rendue comme liste VIDE, produisait un diff « avant = les trois
   * règles d'arrêt de l'agent, après = rien ». Une proposition d'effacement fabriquée à partir de bruit,
   * qu'il ne restait qu'à valider d'un clic. Avant le correctif, ce cas rendait 422.
   */
  it('🔴 des sorties toutes inexploitables ne proposent RIEN, surtout pas un effacement', () => {
    const r = propositionSchema.safeParse(assainirProposition({
      message: 'Voici.',
      fiche: { sorties: ['rdv', 'devis'] }, // des chaînes au lieu d'objets : rien n'en survit
    }));
    expect(r.success).toBe(true);
    // Pas `sorties: []`, qui EST une proposition de retrait : la clé disparaît.
    expect(r.success && 'sorties' in r.data.fiche!).toBe(false);
    expect(differences(COURANT_AVEC_SORTIES, r.success ? r.data : { message: '' })).toEqual([]);
  });

  it('⚠️ mais un tableau VIDE reste une proposition de retrait délibérée', () => {
    // La preuve inverse : sans elle, la garde ci-dessus retirerait au modèle un geste parfaitement légitime.
    const r = propositionSchema.safeParse(assainirProposition({ message: 'Voici.', fiche: { sorties: [] } }));
    expect(r.success).toBe(true);
    expect(r.success && r.data.fiche!.sorties).toEqual([]);
    expect(differences(COURANT_AVEC_SORTIES, r.success ? r.data : { message: '' })).toHaveLength(1);
  });

  it('une bascule SANS moment part seule, elle n’emporte pas les autres', () => {
    // Le `moment` est la clé d'appariement : une bascule qui n'en a pas n'est rattachable à rien.
    const r = propositionSchema.safeParse(assainirProposition({
      message: 'Voici.',
      bascules: [{ moment: '', action: 'outil_api' }, { moment: 'le client veut un essai', action: 'outil_api' }],
    }));
    expect(r.success).toBe(true);
    expect(r.success && r.data.bascules).toHaveLength(1);
  });

  it('un texte trop long est COUPÉ, pas refusé', () => {
    const r = propositionSchema.safeParse(assainirProposition({
      message: 'x'.repeat(9000),
      fiche: { ton: 'y'.repeat(4000) },
    }));
    expect(r.success).toBe(true);
    expect(r.success && r.data.message.length).toBe(4000);
    expect(r.success && r.data.fiche!.ton!.length).toBe(1000);
  });

  it('ce qui n’est pas un objet reste refusé par le schéma', () => {
    // L'assainissement ne FABRIQUE rien : le `safeParse` derrière lui n'est pas décoratif.
    for (const brut of [null, 42, 'texte', ['x']]) {
      expect(propositionSchema.safeParse(assainirProposition(brut)).success).toBe(false);
    }
  });
});

/**
 * 🔴 L'ADRESSE DU SITE EST ÉCRITE PAR LE MODÈLE ET AFFICHÉE AU CLIENT (2026-09-18).
 *
 * Elle finit dans un bandeau de la console, et le modèle qui l'écrit lit du contenu tiers. Un
 * `javascript:` ou un `data:` y mettrait une charge active. Le motif est donc une garde d'AFFICHAGE autant
 * qu'une validation, et il se teste dans les deux sens.
 *
 * ⚠️ LE CAS QUI A FAILLI PASSER : le motif était construit par `new RegExp` dans un littéral de gabarit, où
 * `\s` n'est pas une séquence d'échappement connue. Le backslash disparaissait, et la classe devenait « tout
 * sauf la LETTRE s ». `http://exemple.fr/pages` était refusé, `https://ganprevoyance.fr` passait. Aucune
 * erreur, juste un motif qui disait autre chose que ce qu'on lisait.
 */
describe('proposition : l’adresse du site', () => {
  const url = (u: string) => propositionSchema.safeParse({ message: 'x', connaissanceUrl: u }).success;

  it('accepte les adresses que les clients donnent VRAIMENT', () => {
    for (const u of [
      'https://ganprevoyance.fr',
      // 🔴 Celle-ci est le cas de la regex cassée : le « s » de « pages » la faisait échouer.
      'http://exemple.fr/pages',
      'https://site.fr/a/b?c=1',
      'https://WWW.SITE.FR',
    ]) expect(url(u), u).toBe(true);
  });

  it('🔴 refuse tout ce qui n’est pas http(s), et le reste', () => {
    for (const u of [
      'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'ftp://x.fr',
      'pas une url', '', 'https://x.fr/ a',
    ]) expect(url(u), u).toBe(false);
  });

  it('⚠️ elle ne produit AUCUNE ligne de diff', () => {
    // « Enregistrer » écrit des champs ; lui faire aspirer cinquante pages d'un site tiers ferait valider au
    // client un crawl dont il n'a rien vu. L'adresse est mémorisée, et l'onglet la propose.
    expect(differences(COURANT_AVEC_SORTIES, propositionSchema.parse({
      message: 'x', connaissanceUrl: 'https://ganprevoyance.fr',
    }))).toEqual([]);
  });
});

/**
 * 🔴 TOUTE BORNE QUE ZOD APPLIQUE EST ANNONCÉE AU MODÈLE. C'est l'invariant que le défaut du 2026-09-17 a
 * violé, et il se MESURE : ce jour-là, 31 bornes sur 31 étaient appliquées sans qu'aucune ne figure dans le
 * schéma envoyé au modèle. Le test de miroir voisin ne pouvait pas le voir : il compare des NOMS DE CLÉS et
 * leur caractère requis, jamais leurs bornes.
 *
 * ⚠️ IL LIT LES INTERNES DE ZOD, donc il pourrait devenir MUET à la prochaine version majeure : un
 * extracteur qui ne trouve plus rien passerait à vide, et c'est la pire façon d'échouer. D'où le compte
 * plancher : sous ce seuil, c'est l'extracteur qui est cassé, et le test le DIT au lieu de se taire.
 */
describe('bornes : ce que Zod refuse, le modèle en a été prévenu', () => {
  const CLE_JSON: Record<string, string> = {
    max_length_string: 'maxLength',
    min_length_string: 'minLength',
    max_length_array: 'maxItems',
    min_length_array: 'minItems',
  };

  /** Ce que le schéma ANNONCÉ au modèle déclare, chemin par chemin. */
  function annonces(n: any, chemin: string, out: Map<string, Set<string>>): Map<string, Set<string>> {
    if (!n || typeof n !== 'object') return out;
    out.set(chemin, new Set(
      ['maxLength', 'minLength', 'pattern', 'maxItems', 'minItems', 'enum'].filter((k) => k in n),
    ));
    if (n.properties) for (const [k, v] of Object.entries(n.properties)) annonces(v, chemin ? `${chemin}.${k}` : k, out);
    if (n.items) annonces(n.items, `${chemin}[]`, out);
    return out;
  }

  /** Ce que Zod APPLIQUE vraiment, chemin par chemin. */
  function bornes(s: any, chemin: string, out: Array<[string, string]>): Array<[string, string]> {
    const d = s?._zod?.def;
    if (!d) return out;
    if (d.type === 'optional' || d.type === 'nullable' || d.type === 'default') return bornes(d.innerType, chemin, out);
    if (d.type === 'object') {
      for (const [k, v] of Object.entries(d.shape)) bornes(v, chemin ? `${chemin}.${k}` : k, out);
      return out;
    }
    for (const c of d.checks ?? []) {
      const cd = c?._zod?.def ?? c;
      if (cd.check === 'max_length') out.push([chemin, CLE_JSON[`max_length_${d.type}`]!]);
      if (cd.check === 'min_length' && cd.minimum > 0) out.push([chemin, CLE_JSON[`min_length_${d.type}`]!]);
      if (cd.format === 'regex') out.push([chemin, 'pattern']);
    }
    if (d.type === 'array') return bornes(d.element, `${chemin}[]`, out);
    return out;
  }

  it('🔴 chaque borne appliquée par Zod figure dans le schéma envoyé au modèle', () => {
    const promis = annonces(SCHEMA_PROPOSITION, '', new Map());
    const appliquees = bornes(propositionSchema, '', []);

    expect(appliquees.length, 'l’extracteur ne lit plus les bornes de Zod : c’est LUI qu’il faut réparer')
      .toBeGreaterThanOrEqual(25);

    const muettes = appliquees.filter(([chemin, cle]) => {
      const declare = promis.get(chemin);
      // Une ÉNUMÉRATION est une borne plus stricte que la longueur ou le motif qu'elle rend inatteignables :
      // annoncer `enum` suffit donc à prévenir le modèle.
      return !declare || !(declare.has(cle) || declare.has('enum'));
    });
    expect(muettes, `bornes jamais annoncées au modèle : ${muettes.map(([c, k]) => `${c}/${k}`).join(', ')}`)
      .toEqual([]);
  });
});
