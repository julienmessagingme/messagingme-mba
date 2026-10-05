import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TAILLE_VISUEL_PUB_MAX, TYPES_VISUEL_PUB } from '../src/meta/pubs-creation';
import {
  TAILLE_VISUEL_MAX, TYPES_VISUEL, AGE_MAX, AGE_MIN_BAS, AGE_MIN_HAUT, enPauseChezMeta, lienGestionnaireMeta,
  BOUTONS_PUB as BOUTONS_ECRAN, BOUTON_PUB_DEFAUT as BOUTON_DEFAUT_ECRAN, boutonConnu, libelleBouton,
  archivable, estArchivee, phasePub,
} from '../web/lib/api-pubs';
import { ISSUES_NON_PRISES_EN_CHARGE } from '../src/pubs/entonnoir';
import {
  DUREE_VIDEO_PUB_MAX_S, TAILLE_VIDEO_PUB_MAX, TYPES_VIDEO_PUB, dureeTropLongue as dureeTropLongueServeur,
  dureeDeLaTete as dureeDeLaTeteServeur,
} from '../src/pubs/video';
import {
  DUREE_VIDEO_MAX_S, TAILLE_VIDEO_MAX, TYPES_VIDEO, dureeTropLongue as dureeTropLongueEcran,
  dureeDeLaTete as dureeDeLaTeteEcran,
} from '../web/lib/pub-video';
import {
  AGE_MAX_ADVANTAGE, AGE_MIN_ADVANTAGE_BAS, AGE_MIN_ADVANTAGE_HAUT,
  BOUTONS_PUB as BOUTONS_SERVEUR, BOUTON_PUB_DEFAUT as BOUTON_DEFAUT_SERVEUR,
} from '../src/meta/pubs-payloads';

/**
 * LES BORNES DU VISUEL D'UNE PUBLICITÉ, DES DEUX CÔTÉS.
 *
 * L'écran refuse AVANT de téléverser (attendre cinq mégaoctets pour se faire dire non est une mauvaise
 * expérience, et la limite de corps de la route couperait de toute façon), le serveur refuse en dernier
 * ressort. Deux chiffres qui divergent donnent le pire des deux : un écran qui promet ce que le serveur
 * refuse, avec un 400 que personne ne relie à la promesse. Même patron que les autres tests de parité du
 * dépôt.
 *
 * 🔴 C'EST L'ÉCART QUI PORTE L'INVARIANT, PAS CHAQUE CONSTANTE. Prise seule, chacune est plausible : cinq
 * mégaoctets ici, six là, personne ne sursaute en relisant l'un des deux fichiers. Ce genre d'invariant
 * n'est visible dans aucun des deux, et ne tient donc que dans un test.
 */
describe('parité des bornes du visuel publicitaire', () => {
  it('l’écran et le serveur annoncent le MÊME poids maximum', () => {
    expect(TAILLE_VISUEL_MAX).toBe(TAILLE_VISUEL_PUB_MAX);
  });

  it('l’écran et le serveur acceptent les MÊMES types', () => {
    expect([...TYPES_VISUEL]).toEqual([...TYPES_VISUEL_PUB]);
  });

  it('🔴 ni SVG ni GIF, des deux côtés : ce fichier part chez un tiers sous l’identité du client', () => {
    // Un SVG est un document exécutable. Le laisser entrer par le côté où la garde est la plus faible
    // suffirait : c'est le serveur qui décide, et l'écran ne doit pas lui promettre autre chose.
    for (const liste of [[...TYPES_VISUEL], [...TYPES_VISUEL_PUB]]) {
      expect(liste).not.toContain('image/svg+xml');
      expect(liste).not.toContain('image/gif');
    }
  });
});

/**
 * LES BORNES DE LA VIDÉO ET DE L'ÂGE, DES DEUX CÔTÉS (migration 0187).
 *
 * 🔴 Même invariant que le visuel : l'écran refuse AVANT d'envoyer cent mégaoctets, le serveur refuse en dernier
 * ressort. Un écran qui promettrait 120 Mo ferait envoyer une vidéo que le serveur jette à la fin.
 */
describe('parité des bornes de la vidéo et de l’âge', () => {
  it('le même poids, la même durée, les mêmes types', () => {
    expect(TAILLE_VIDEO_MAX).toBe(TAILLE_VIDEO_PUB_MAX);
    expect(DUREE_VIDEO_MAX_S).toBe(DUREE_VIDEO_PUB_MAX_S);
    expect([...TYPES_VIDEO]).toEqual([...TYPES_VIDEO_PUB]);
  });

  it('🔴 la même règle d’arrondi de la durée, sur les cas qui la départagent', () => {
    for (const d of [59.9, 60, 60.03, 60.49, 60.5, 60.51, 61, 90]) {
      expect(dureeTropLongueEcran(d), `${d} s`).toBe(dureeTropLongueServeur(d));
    }
  });

  it('les mêmes bornes d’âge qu’Advantage+ impose', () => {
    expect([AGE_MIN_BAS, AGE_MIN_HAUT, AGE_MAX]).toEqual([AGE_MIN_ADVANTAGE_BAS, AGE_MIN_ADVANTAGE_HAUT, AGE_MAX_ADVANTAGE]);
  });
});

/**
 * LES BOUTONS D'UNE PUBLICITÉ, DES DEUX CÔTÉS.
 *
 * 🔴 La liste FERMÉE vit au serveur (`BOUTONS_PUB`, écrite comme une hypothèse que l'essai réel tranche) ; l'écran en
 * porte une copie avec les libellés. Un type que l'écran propose et que le serveur refuse ferait un 400 sur un choix
 * offert ; un type que le serveur accepte et que l'écran ne propose pas serait un choix mort.
 */
describe('parité des boutons de la publicité', () => {
  it('🔴 les MÊMES types, dans le MÊME ordre, et le même défaut', () => {
    expect(BOUTONS_ECRAN.map((b) => b.type)).toEqual([...BOUTONS_SERVEUR]);
    expect(BOUTON_DEFAUT_ECRAN).toBe(BOUTON_DEFAUT_SERVEUR);
  });

  it('chaque type a un libellé dans les deux langues, et les libellés retenus le 2026-09-28', () => {
    for (const b of BOUTONS_ECRAN) {
      expect(b.fr.trim(), b.type).not.toBe('');
      expect(b.en.trim(), b.type).not.toBe('');
    }
    expect(libelleBouton('WHATSAPP_MESSAGE').fr).toBe('Envoyer un message WhatsApp');
    expect(libelleBouton('GET_QUOTE').fr).toBe('Obtenir un devis');
    expect(libelleBouton('APPLY_NOW').fr).toBe('Postuler');
  });

  it('⚠️ un bouton inconnu (brouillon ancien, API d’avant ce lot) se lit comme le défaut', () => {
    for (const v of [undefined, null, '', 'CALL_NOW', 'get_quote']) expect(boutonConnu(v), String(v)).toBe('WHATSAPP_MESSAGE');
    expect(boutonConnu('BOOK_NOW')).toBe('BOOK_NOW');
  });

  it('🔴 le formulaire retient la durée du conteneur par `dureeRetenue` (un `mvhd` à 0 laisse répondre le décodeur)', () => {
    // La règle est testée sur la fonction (`web/lib/pub-video.test.ts`) ; ici, qu'elle est BIEN celle du formulaire :
    // un `dureeConteneur ?? ...` en ligne ferait refuser un MP4 fragmenté sans qu'aucun test de la fonction ne tombe.
    const form = readFileSync(join(process.cwd(), 'web/components/PubFormulaire.tsx'), 'utf8');
    expect(form).toContain('duree: dureeRetenue(dureeConteneur, parLeDecodeur.duree)');
    expect(form).not.toMatch(/dureeConteneur \?\?/);
  });

  it('🔴 l’APERÇU montre le libellé du bouton choisi, pas un texte en dur', () => {
    const apercu = readFileSync(join(process.cwd(), 'web/components/PubApercu.tsx'), 'utf8');
    expect(apercu).toContain('libelleBouton(bouton)');
    expect(apercu).not.toContain("t('Envoyer un message', 'Send message')");
    const form = readFileSync(join(process.cwd(), 'web/components/PubFormulaire.tsx'), 'utf8');
    expect(form).toContain('bouton={bouton}');
  });
});

/**
 * LA DURÉE LUE DANS LE FICHIER, DES DEUX CÔTÉS.
 *
 * 🔴 L'écran porte une COPIE EXACTE du parseur `mvhd` du serveur (la console ne peut pas importer `src/`). Les deux
 * tournent ici sur les mêmes têtes de fichier : une correction faite d'un seul côté les ferait diverger, et l'écran
 * laisserait partir une vidéo que le serveur refuserait (ou l'inverse).
 */
describe('parité du parseur de durée (`mvhd`)', () => {
  const boite = (nom: string, contenu: Uint8Array = new Uint8Array(0), etendue = false): Uint8Array => {
    const entete = etendue ? 16 : 8;
    const out = new Uint8Array(entete + contenu.byteLength);
    const v = new DataView(out.buffer);
    if (etendue) { v.setUint32(0, 1); v.setUint32(12, out.byteLength); } else v.setUint32(0, out.byteLength);
    for (let i = 0; i < 4; i += 1) out[4 + i] = nom.charCodeAt(i);
    out.set(contenu, entete);
    return out;
  };
  const concat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let i = 0;
    for (const p of parts) { out.set(p, i); i += p.byteLength; }
    return out;
  };
  const mvhd = (version: 0 | 1, echelle: number, haut: number, bas: number): Uint8Array => {
    const corps = new Uint8Array(version === 1 ? 108 : 96);
    const v = new DataView(corps.buffer);
    v.setUint8(0, version);
    if (version === 1) { v.setUint32(20, echelle); v.setUint32(24, haut); v.setUint32(28, bas); } else { v.setUint32(12, echelle); v.setUint32(16, bas); }
    return boite('mvhd', corps);
  };
  const FTYP = boite('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]));
  const complet = concat(FTYP, boite('moov', mvhd(0, 1000, 0, 45_000)));

  const CAS: Record<string, Uint8Array> = {
    'v0 au début': complet,
    'v1 au début': concat(FTYP, boite('moov', mvhd(1, 600, 0, 600 * 75))),
    'v1 sur plus de 32 bits': concat(FTYP, boite('moov', mvhd(1, 1_000_000, 1, 5))),
    'moov à taille étendue': concat(FTYP, boite('moov', mvhd(0, 1000, 0, 30_000), true)),
    'free avant moov': concat(FTYP, boite('free', new Uint8Array(16)), boite('moov', mvhd(0, 90_000, 0, 90_000 * 30))),
    'moov derrière mdat (tête sans durée)': concat(FTYP, boite('mdat', new Uint8Array(64)), boite('moov', mvhd(0, 1000, 0, 5000))),
    'durée inconnue v0': concat(FTYP, boite('moov', mvhd(0, 1000, 0, 0xffffffff))),
    'durée inconnue v1': concat(FTYP, boite('moov', mvhd(1, 1000, 0xffffffff, 0xffffffff))),
    'échelle nulle': concat(FTYP, boite('moov', mvhd(0, 0, 0, 1000))),
    'tronquée dans mvhd': complet.slice(0, complet.length - 80),
    'boîte incohérente': concat(FTYP, new Uint8Array([0, 0, 0, 4, 0x66, 0x72, 0x65, 0x65])),
    'taille zéro hors moov': concat(FTYP, new Uint8Array([0, 0, 0, 0, 0x6d, 0x64, 0x61, 0x74])),
    'moov sans mvhd en tête': concat(FTYP, boite('moov', boite('trak', new Uint8Array(40)))),
    vide: new Uint8Array(0),
  };

  for (const [nom, tete] of Object.entries(CAS)) {
    it(`même verdict : ${nom}`, () => {
      expect(dureeDeLaTeteEcran(tete)).toBe(dureeDeLaTeteServeur(tete));
    });
  }

  it('garde de la garde : les cas départagent vraiment (des durées ET des `null`)', () => {
    const verdicts = Object.values(CAS).map((t) => dureeDeLaTeteServeur(t));
    expect(verdicts.filter((d) => d === null).length).toBeGreaterThan(3);
    expect(new Set(verdicts.filter((d) => d !== null)).size).toBeGreaterThan(3);
  });
});

/**
 * LE LIBELLÉ DU BOUTON D'UNE PUBLICITÉ QUI DÉPENSE.
 *
 * 🔴 `null` VEUT DIRE « PAS ENCORE RELU CHEZ META », ET IL NE DOIT PAS DIRE « EN PAUSE ». Le statut
 * n'arrive qu'au balayage suivant, jusqu'à quinze minutes après la publication : pendant cette fenêtre,
 * une publicité qui paie des impressions affichait « Relancer », c'est-à-dire exactement l'inverse de son
 * état. C'est la même famille que le reste de cet écran, où « non disponible » n'est jamais « 0 ».
 */
describe('à l’arrêt chez Meta, ou seulement pas encore relue', () => {
  it('🔴 un statut JAMAIS LU ne vaut pas « en pause »', () => {
    expect(enPauseChezMeta(null)).toBe(false);
  });

  it('« ACTIVE » diffuse, donc le geste offert est la mise en pause', () => {
    expect(enPauseChezMeta('ACTIVE')).toBe(false);
  });

  it('les trois formes de pause de Meta sont bien des pauses', () => {
    for (const s of ['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED']) expect(enPauseChezMeta(s)).toBe(true);
  });

  it('🔴 LA DÉCISION VIT DANS LA FONCTION, PAS DANS UN `if` DU COMPOSANT', () => {
    // Sans ce sens-là, la comparaison peut revenir se poser en ligne dans l'écran, et ce fichier
    // continuerait de tester une fonction que plus personne n'appelle.
    const source = readFileSync(join(process.cwd(), 'web/components/PubsListe.tsx'), 'utf8');
    expect(source).toContain('enPauseChezMeta(pub.statutMeta)');
    expect(source).not.toContain("statutMeta !== 'ACTIVE'");
  });
});

/**
 * CHAQUE ISSUE QUE LE SERVEUR COMPTE « NON PRISE EN CHARGE » EST NOMMÉE À L'ÉCRAN, DANS LES DEUX LANGUES.
 *
 * 🔴 CE TEST LIT LE FICHIER DE L'ÉCRAN, ET IL A ÉTÉ ÉCRIT PARCE QU'IL NE LE LISAIT PAS. Sa version
 * précédente comparait `ISSUES_NON_PRISES_EN_CHARGE` à une copie de la même liste : elle affirmait « les
 * trois issues que l'écran énumère » sans ouvrir l'écran une seule fois. Quand une QUATRIÈME issue est
 * arrivée (`sans_scenario`), elle est restée verte pendant que la légende continuait d'en annoncer trois.
 *
 * ⚠️ IL PINCE UNE ORTHOGRAPHE, ET C'EST ASSUMÉ. Ce qu'il protège n'est pas un comportement (le calcul vit
 * côté serveur) mais une PROMESSE : le client lit ce chiffre pour décider s'il y a quelque chose à
 * RÉPARER. Une cause comptée et non nommée l'envoie chercher le défaut parmi celles qui sont écrites,
 * c'est-à-dire au mauvais endroit. `sans_scenario` est précisément la seule des quatre qui se répare.
 */
describe('ce que l’écran annonce sur les prospects non pris en charge', () => {
  /** Le fragment que la légende doit porter pour chaque issue, en français et en anglais. */
  const NOMMEES: Record<string, { fr: string; en: string }> = {
    reprise_refusee: { fr: 'reprise refusée', en: 'handover refused' },
    desabonne: { fr: 'désabonnés', en: 'unsubscribed' },
    bloque: { fr: 'bloqués', en: 'blocked' },
    sans_scenario: { fr: 'sans scénario', en: 'no scenario' },
  };

  /**
   * La LÉGENDE seule, pas le fichier entier : un mot présent ailleurs dans le composant ferait passer le
   * test sans que le client lise quoi que ce soit.
   */
  const legende = (): string => {
    const source = readFileSync(join(process.cwd(), 'web/components/PubsListe.tsx'), 'utf8');
    const bloc = /data-testid=\{`pub-non-pris-\$\{id\}`\}>([\s\S]*?)<\/p>/.exec(source);
    expect(bloc, 'la légende des prospects non pris en charge est introuvable dans l’écran').not.toBeNull();
    return bloc?.[1] ?? '';
  };

  it('🔴 la table de ce test couvre EXACTEMENT les issues du serveur', () => {
    // Le sens qui compte est celui-ci : une CINQUIÈME issue ajoutée au serveur fait tomber ce test tant
    // que personne ne l'a nommée à l'écran. Sans lui, la boucle ci-dessous ne vérifierait que les issues
    // que quelqu'un a pensé à écrire ici.
    expect(Object.keys(NOMMEES).sort()).toEqual([...ISSUES_NON_PRISES_EN_CHARGE].sort());
  });

  for (const [issue, mots] of Object.entries(NOMMEES)) {
    it(`l’écran nomme « ${issue} », en français et en anglais`, () => {
      const texte = legende();
      expect(texte).toContain(mots.fr);
      expect(texte).toContain(mots.en);
    });
  }

});

/**
 * LA LISTE NE PEUT PAS ÉCRIRE DANS L'EMPLACEMENT D'ERREUR DE LA COQUILLE.
 *
 * 🔴 C'EST UNE SÉPARATION, PAS UNE DISCIPLINE, ET C'EST TOUT L'INTÉRÊT. Le partage d'un emplacement unique
 * a produit TROIS défauts de suite, chacun corrigé par une règle un peu plus fine que la précédente :
 * effacer à l'entrée laissait un bandeau périmé, effacer au succès emportait l'erreur des autres, et une
 * étiquette de source y remédiait sauf si la liste échouait entre-temps. Une discipline partagée sur une
 * ressource unique se défait toujours par un cas qu'on n'a pas énuméré.
 *
 * ⚠️ CE TEST LIT LE CORPS DE `chargerPubs` et exige qu'il n'y nomme AUCUN `setErreur`. Le comportement,
 * lui, est tenu par un cas Playwright qui éprouve l'ordre complet ; celui-ci ferme la porte en amont, pour
 * que la question ne se repose pas au prochain écrivain.
 */
describe('les deux emplacements d’erreur de l’écran des publicités', () => {
  const corpsDeChargerPubs = (): string => {
    const source = readFileSync(join(process.cwd(), 'web/app/publicites/page.tsx'), 'utf8');
    // Par bornes, pas par expression régulière : les échappements d'une regex écrite pour reconnaître du
    // code sont une source d'erreur à eux seuls, et ce qu'on cherche ici est un simple découpage.
    const debut = source.indexOf('const chargerPubs = useCallback');
    const fin = source.indexOf('\n  }, [', debut);
    expect(debut, 'le début de `chargerPubs` est introuvable').toBeGreaterThan(-1);
    expect(fin, 'la fin de `chargerPubs` est introuvable').toBeGreaterThan(debut);
    return source.slice(debut, fin);
  };

  it('🔴 `chargerPubs` n’écrit QUE dans l’emplacement de la liste', () => {
    const corps = corpsDeChargerPubs();
    expect(corps).toContain('setErreurListe(');
    expect(corps).not.toContain('setErreur(');
  });

  it('et l’écran REND bien les deux, sans quoi l’un serait écrit et jamais lu', () => {
    const source = readFileSync(join(process.cwd(), 'web/app/publicites/page.tsx'), 'utf8');
    expect(source).toContain("data-testid=\"pubs-erreur\"");
    expect(source).toContain("data-testid=\"pubs-liste-erreur\"");
  });
});

/**
 * LE LIEN VERS LE GESTIONNAIRE DE META, ET CE QU'IL RATTRAPE.
 *
 * 🔴 IL EST LA CONTREPARTIE D'UN CHOIX FAIT AILLEURS. `lireCampagnes` ne garde qu'UN motif de refus quand
 * Meta en rend plusieurs, et sa justification écrite invoquait « le lien vers le Gestionnaire, à côté ».
 * Ce lien n'existait pas : la justification était donc fausse, et une publicité refusée montrait une
 * phrase tronquée sans aucune suite possible. Relevé par une relecture à froid.
 */
describe('le lien vers le Gestionnaire de Meta', () => {
  it('porte le compte et la campagne', () => {
    const lien = lienGestionnaireMeta('123456', 'camp-9') ?? '';
    expect(lien).toContain('act=123456');
    expect(lien).toContain('selected_campaign_ids=camp-9');
  });

  it('🔴 le préfixe `act_` n’est jamais doublé : le Gestionnaire attend le NOMBRE', () => {
    // La base garde la forme nue, mais le dépôt se défend des deux depuis `sansPrefixeAct`. Un
    // `act=act_123` ouvre un compte introuvable, ce qui est pire que pas de lien du tout.
    expect(lienGestionnaireMeta('act_123456', 'camp-9')).toBe(lienGestionnaireMeta('123456', 'camp-9'));
  });

  it('sans compte connecté, il n’y a pas de lien plutôt qu’un lien cassé', () => {
    expect(lienGestionnaireMeta(null, 'camp-9')).toBeNull();
    expect(lienGestionnaireMeta('', 'camp-9')).toBeNull();
  });

  it('🔴 L’ÉCRAN LE POSE VRAIMENT, et pas seulement cette fonction', () => {
    // Le défaut d'origine était exactement celui-là : la fonction aurait pu exister sans que personne
    // l'appelle, et la justification de `lireCampagnes` serait restée fausse.
    const source = readFileSync(join(process.cwd(), 'web/components/PubsListe.tsx'), 'utf8');
    expect(source).toContain('lienGestionnaireMeta(comptePubId, p.campagneId)');
  });
});

/**
 * L'AGENT DE META ÉTEINT APRÈS COUP, SUR UNE PUBLICITÉ QUI LUI CONFIE SES PROSPECTS.
 *
 * 🔴 C'EST LE SEUL ÉTAT OÙ L'ENTONNOIR MENT SANS POUVOIR LE SAVOIR. `agent_meta` est délibérément hors des
 * « non pris en charge », au motif que quelqu'un répond. Si l'agent de Meta s'éteint après la création, ce
 * motif devient faux : plus personne ne répond, aucune automation ne prend le relais, et ces prospects
 * continuent d'être comptés comme servis. Seul un bandeau à l'écran peut le dire.
 */
describe('le bandeau de l’agent de Meta éteint', () => {
  const source = (): string => readFileSync(join(process.cwd(), 'web/components/PubsListe.tsx'), 'utf8');

  it('🔴 l’écran reçoit l’état de l’agent, et pose le bandeau sur les pubs qui en dépendent', () => {
    expect(source()).toContain("p.destination === 'agent_meta' && repondeurOuvert === false");
  });

  it('🔴 la page passe l’ÉTAT LU à la LISTE, pas un littéral', () => {
    /**
     * ⚠️ L'ASSERTION EST ANCRÉE SUR LE BLOC DE PROPS DE `PubsListe`, et c'est tout l'intérêt. Sa version
     * précédente cherchait `repondeurOuvert={repondeurOuvert}` N'IMPORTE OÙ dans le fichier : le
     * `<PubFormulaire>` en portait une occurrence, donc remplacer celle de la LISTE par un littéral
     * laissait les 18 tests verts. Une relecture à froid l'a montré en posant la mutation.
     */
    const page = readFileSync(join(process.cwd(), 'web/app/publicites/page.tsx'), 'utf8');
    expect(page).toContain('comptePubId={etat.connexion.comptePubId} repondeurOuvert={repondeurOuvert}');
  });

  it('🔴 `null` NE VAUT PAS « éteint » : le bandeau exige un FAUX lu', () => {
    // Le défaut corrigé : `!repondeurOuvert` sortait aussi sur `null`, donc l'avertissement paraissait
    // sur le chemin nominal avant que le réglage soit lu, et restait à demeure si la lecture échouait.
    // ⚠️ LES DEUX FICHIERS, pas seulement la liste : le défaut a vécu dans le FORMULAIRE la dernière
    // fois, et cette assertion ne regardait que l'écran de liste, donc pas là où il était.
    const form = readFileSync(join(process.cwd(), 'web/components/PubFormulaire.tsx'), 'utf8');
    for (const fichier of [source(), form]) expect(fichier).not.toContain('!repondeurOuvert');
    const page = readFileSync(join(process.cwd(), 'web/app/publicites/page.tsx'), 'utf8');
    // ⚠️ ANCRÉES SUR LE SYMBOLE, pas sur un fragment qui traîne. `useState<boolean | null>(null)` seul
    // serait satisfait par le premier AUTRE tri-état ajouté à cet écran, et la garde redeviendrait
    // décorative sans que personne ne la touche : c'est exactement ce qui venait d'arriver à sa voisine.
    expect(page).toContain('const [repondeurOuvert, setRepondeurOuvert] = useState<boolean | null>(null)');
    expect(page).toContain('.catch(() => setRepondeurOuvert(null))');
  });

  it('🔴 LE FORMULAIRE SE FERME SUR L’INCONNU, ET NE L’ANNONCE PAS COMME UNE PANNE', () => {
    /**
     * Deux décisions distinctes, et une seule était tenue. Se FERMER sur `null` est le bon sens d'erreur :
     * proposer « l'agent de Meta répond » sans l'avoir lu ferait créer une publicité sans répondeur. Mais
     * DIRE « l'agent de Meta n'est pas ouvert sur ce numéro » est un énoncé sur la configuration Meta du
     * client, alors que nous avons seulement échoué à lire NOTRE réglage.
     */
    const form = readFileSync(join(process.cwd(), 'web/components/PubFormulaire.tsx'), 'utf8');
    expect(form).toContain("repondeurOuvert === true && <option value=\"agent_meta\"");
    expect(form).toContain('repondeurOuvert === false && (');
    expect(form).toContain('repondeurOuvert === null && (');
    /**
     * Et la page passe l'ÉTAT À SES DEUX CONSOMMATEURS, jamais une expression qui l'écrase.
     *
     * ⚠️ LA RÈGLE EST ÉNONCÉE SUR LA FORME, PAS SUR UNE VALEUR FAUTIVE PRÉCISE. Interdire le seul
     * `=== true` laisserait passer `!== false`, `?? false`, `Boolean(...)` : autant de façons d'ôter au
     * consommateur le moyen de distinguer « éteint » de « pas encore lu ». On exige donc que CHAQUE
     * occurrence transmette la variable nue.
     */
    const page = readFileSync(join(process.cwd(), 'web/app/publicites/page.tsx'), 'utf8');
    const passages = [...page.matchAll(/repondeurOuvert=\{([^}]*)\}/g)].map((m) => m[1] ?? '');
    // ÉGALITÉ STRICTE, pas « au moins deux » : un troisième consommateur doit faire TOMBER ce test,
    // pour qu'on aille regarder ce qu'il fait de l'état, au lieu de passer inaperçu.
    // ⚠️ CE COMPTE NE TRAVERSE PAS UN SPREAD : un `{...{ repondeurOuvert }}` n'est pas vu, comme le
    // contrôle des propriétés en trop du compilateur. C'est la limite connue de cette garde, et ce
    // qui la rend insuffisante à elle seule : le comportement, lui, est tenu par les cas Playwright.
    expect(passages).toHaveLength(2);
    // `trim`, parce qu'une espace ou un retour à la ligne dans le JSX ne change rien : une garde qui
    // tombe sur une remise en forme envoie chercher un écrasement de `null` qui n'existe pas.
    for (const p of passages) expect(p.trim()).toBe('repondeurOuvert');
    /**
     * 🔴 ET L'ÉCRASEMENT PEUT REMONTER AU SETTER, ce que les passages ne voient pas : remettre
     * `r.mbaEnabled === true` à la lecture laisse les deux passages nus et refait le défaut une ligne
     * plus haut. C'est exactement le déplacement qui a produit ce lot, dans l'autre sens.
     *
     * ⚠️ LOT 5 : la lecture passe par `repondeurAutomatique` (`web/lib/repondeur.ts`, l'agent de Meta OU l'agent IA
     * répondeur), et c'est elle qui garde le tri-état : `null` sans `mbaEnabled` lisible, tenu par
     * `web/lib/repondeur.test.ts`. Le setter la reçoit nue.
     */
    expect(page).toContain('.then((r) => setRepondeurOuvert(repondeurAutomatique(r)))');
  });
});

describe('la phase d’une publicité, lue sur ses dates', () => {
  const maintenant = Date.parse('2026-09-28T18:00:00Z');
  const pub = (etat: 'publiee' | 'prete', debut: string | null, fin: string | null) => ({ etat, debut, fin });

  it('🔴 publiée, début à venir : programmée (Meta dit pourtant ACTIVE)', () => {
    expect(phasePub(pub('publiee', '2026-09-29T00:00:00Z', '2026-10-05T00:00:00Z'), maintenant)).toBe('programmee');
  });

  it('⚠️ PRÊTE avec un début à venir n’est programmée nulle part : rien ne partira sans publier', () => {
    expect(phasePub(pub('prete', '2026-09-29T00:00:00Z', '2026-10-05T00:00:00Z'), maintenant)).toBe('en_cours');
  });

  it('début passé : en cours ; fin passée : achevée, quel que soit le début', () => {
    expect(phasePub(pub('publiee', '2026-09-27T00:00:00Z', '2026-10-05T00:00:00Z'), maintenant)).toBe('en_cours');
    expect(phasePub(pub('publiee', '2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z'), maintenant)).toBe('achevee');
  });

  it('une date absente ne classe jamais', () => {
    expect(phasePub(pub('publiee', null, null), maintenant)).toBe('en_cours');
  });
});

describe('l’archivage vu de l’écran', () => {
  it('🔴 le bouton suit la garde du serveur : jamais sur ce qui peut diffuser', () => {
    expect(archivable({ etat: 'publiee', statutMeta: 'ACTIVE' })).toBe(false);
    // `null` = pas encore relue chez Meta : le serveur refuse aussi, elle peut diffuser.
    expect(archivable({ etat: 'publiee', statutMeta: null })).toBe(false);
    expect(archivable({ etat: 'publiee', statutMeta: 'PAUSED' })).toBe(true);
    expect(archivable({ etat: 'echec_creation', statutMeta: null })).toBe(true);
    expect(archivable({ etat: 'prete', statutMeta: null })).toBe(true);
  });

  it('🔴 un champ ABSENT (API pas encore déployée) ne range rien', () => {
    expect(estArchivee({} as { archiveeLe: string | null })).toBe(false);
    expect(estArchivee({ archiveeLe: null })).toBe(false);
    expect(estArchivee({ archiveeLe: '2026-09-28T18:00:00.000Z' })).toBe(true);
  });
});
