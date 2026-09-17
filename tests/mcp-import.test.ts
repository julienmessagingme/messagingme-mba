import { describe, it, expect } from 'vitest';
import { normaliserNom, nomUnique } from '../src/agent/mcp/nommer';
import { empreinteAnnonce, outilDepuisAnnonce, planifierImport, reporterClouage, type OutilExistantMcp } from '../src/agent/mcp/import';
import type { ParamOutil } from '../src/agent/llm/tool-schema';
import type { OutilAnnonce } from '../src/mcp/client';

/**
 * L'IMPORT D'UN CATALOGUE MCP : ce qui change, et ce qui tombe avec.
 *
 * 🔴 CE MODULE EST PUR, ET C'EST DÉLIBÉRÉ. Il COMPARE et rend un PLAN ; l'écriture est ailleurs. C'est le
 * même patron que l'aperçu de publication chez Meta, pour la même raison : écraser n'est acceptable que si
 * l'on montre QUOI avant de le faire.
 */

const annonce = (name: string, schema: unknown, reste: Record<string, unknown> = {}): OutilAnnonce =>
  ({ name, inputSchema: schema as Record<string, unknown>, ...reste });

const SCHEMA_A = { type: 'object', properties: { q: { type: 'string' } } };
const SCHEMA_B = { type: 'object', properties: { q: { type: 'string' }, page: { type: 'integer' } } };

const existant = (over: Partial<OutilExistantMcp> & { nomDistant: string }): OutilExistantMcp => ({
  id: `id-${over.nomDistant}`,
  name: `notion_${over.nomDistant}`,
  mcpAnnonce: annonce(over.nomDistant, SCHEMA_A),
  mcpIndisponibleLe: null,
  params: [],
  consommateursActifs: 2,
  ...over,
});

describe('nommer un outil importe', () => {
  it('prefixe par le serveur : deux serveurs qui exposent `search` ne se marchent plus dessus', () => {
    // 🔴 `agent_tools.name` est unique par ESPACE depuis 0127. Sans prefixe, le deuxieme serveur branche
    // echouerait a l import sur une contrainte d unicite, ce qui est illisible pour le client. Et le
    // modele VOIT d ou vient l outil, ce qui l aide a choisir quand il en a quinze.
    const pris = new Set<string>();
    expect(nomUnique(`${normaliserNom('Notion')}_${normaliserNom('search')}`, pris)).toBe('notion_search');
    pris.add('notion_search');
    expect(nomUnique(`${normaliserNom('Jira')}_${normaliserNom('search')}`, pris)).toBe('jira_search');
  });

  it('normalise ce que MCP autorise et que notre charset refuse', () => {
    // `agent_tools.name` impose ^[a-z0-9_]{1,64}$ ; la spec MCP n impose RIEN sur le nom d un outil.
    expect(normaliserNom('searchPages.v2')).toBe('searchpages_v2');
    expect(normaliserNom('get-weather')).toBe('get_weather');
    expect(normaliserNom('___')).toBe('param');
  });

  it('🔴 le suffixe de desambiguation ne fait JAMAIS deborder la borne de 64', () => {
    // Une base figee deborderait a la dixieme collision. Le meme piege que dans l aplatisseur, et la meme
    // raison de partager UNE fonction plutot que d en ecrire deux.
    // ⚠️ `nomUnique` NE MODIFIE PAS `pris`, c'est son contrat : l'appelant seul sait si sa ligne a fini
    // par etre ecrite. Il faut donc l inscrire ici, sinon les quinze appels rendent le meme nom.
    const pris = new Set<string>();
    const noms: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      const n = nomUnique('z'.repeat(70), pris);
      expect(n.length).toBeLessThanOrEqual(64);
      noms.push(n);
      pris.add(n);
    }
    expect(new Set(noms).size).toBe(15);
  });
});

describe('l empreinte d une annonce', () => {
  it('🔴 NE change PAS quand le serveur reordonne ses cles', () => {
    // Sans cette propriete, chaque rafraichissement ferait tomber tous les consentements du client pour
    // une difference qui n existe pas. La serialisation d un objet JSON n a pas d ordre garanti.
    const a = empreinteAnnonce(annonce('search', { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } }));
    const b = empreinteAnnonce(annonce('search', { properties: { b: { type: 'string' }, a: { type: 'string' } }, type: 'object' }));
    expect(a).toBe(b);
  });

  it('🔴 CHANGE quand la description change, parce qu elle part dans le prompt du modele', () => {
    // La description d un outil distant est du texte ecrit par un TIERS qui arrive dans le contexte du
    // modele. La traiter comme cosmetique laisserait un serveur reecrire ce que l agent croit devoir faire.
    const a = empreinteAnnonce(annonce('search', SCHEMA_A, { description: 'cherche' }));
    const b = empreinteAnnonce(annonce('search', SCHEMA_A, { description: 'cherche et SUPPRIME' }));
    expect(a).not.toBe(b);
  });

  it('CHANGE quand le schema change', () => {
    expect(empreinteAnnonce(annonce('search', SCHEMA_A))).not.toBe(empreinteAnnonce(annonce('search', SCHEMA_B)));
  });
});

describe('planifier un import', () => {
  it('un outil inconnu est NOUVEAU', () => {
    expect(planifierImport([annonce('search', SCHEMA_A)], [], { tronque: false }))
      .toEqual([{ type: 'nouveau', nom: 'search' }]);
  });

  it('un outil inchange ne touche a aucun consentement', () => {
    expect(planifierImport([annonce('search', SCHEMA_A)], [existant({ nomDistant: 'search' })], { tronque: false }))
      .toEqual([{ type: 'inchange', nom: 'search' }]);
  });

  it('🔴 un schema CHANGE fait tomber le consentement : ce n est plus l outil qui a ete autorise', () => {
    // Lecture stricte de 0127, ou le consentement porte sur un outil PRECIS. C est la seule qui empeche un
    // serveur distant d elargir en silence ce qu un outil autorise sait faire.
    expect(planifierImport([annonce('search', SCHEMA_B)], [existant({ nomDistant: 'search' })], { tronque: false }))
      .toEqual([{ type: 'schema_change', nom: 'search', consentementsTombes: 2 }]);
  });

  it('un outil DISPARU est signale, avec ce qu il emporte', () => {
    expect(planifierImport([], [existant({ nomDistant: 'search' })], { tronque: false }))
      .toEqual([{ type: 'disparu', nom: 'search', consentementsTombes: 2 }]);
  });

  it('un outil DEJA marque indisponible ne se re-signale pas a chaque rafraichissement', () => {
    const dejaParti = existant({ nomDistant: 'search', mcpIndisponibleLe: new Date('2026-09-01') });
    expect(planifierImport([], [dejaParti], { tronque: false })).toEqual([]);
  });

  it('🔴 sur un catalogue TRONQUE, AUCUNE disparition n est annoncee', () => {
    // 🔴 LE MEME DANGER QUE LA LISTE PARTIELLE, PAR L AUTRE PORTE. `tronque` veut dire que la liste EST
    // partielle, legitimement (le serveur annonce plus d outils que nos bornes). Marquer « disparu » ce qui
    // n y figure pas ferait tomber le consentement de tout ce qui vivait au dela de la borne : une seule
    // case a cocher de trop chez le client, et la moitie de ses outils se debranchent.
    const plan = planifierImport(
      [annonce('search', SCHEMA_A)],
      [existant({ nomDistant: 'search' }), existant({ nomDistant: 'autre' })],
      { tronque: true },
    );
    expect(plan.some((c) => c.type === 'disparu')).toBe(false);
    expect(plan).toEqual([{ type: 'inchange', nom: 'search' }]);
  });

  it('⚠️ mais un catalogue tronque signale quand meme ce qui a CHANGE', () => {
    // Ne rien faire du tout serait l autre exces : un schema qui a bouge doit faire tomber son consentement,
    // que la liste soit complete ou non. Ce qu on suspend, c est la SUPPRESSION, pas la mise a jour.
    const plan = planifierImport([annonce('search', SCHEMA_B)], [existant({ nomDistant: 'search' })], { tronque: true });
    expect(plan).toEqual([{ type: 'schema_change', nom: 'search', consentementsTombes: 2 }]);
  });

  it('un outil sans consommateur ne fait tomber personne', () => {
    expect(planifierImport([], [existant({ nomDistant: 'search', consommateursActifs: 0 })], { tronque: false }))
      .toEqual([{ type: 'disparu', nom: 'search', consentementsTombes: 0 }]);
  });

  it('une annonce illisible cote existant est traitee comme un CHANGEMENT, pas comme un inchange', () => {
    // Un `mcpAnnonce` a null (ligne ecrite avant ce lot, ou reprise manuelle) ne permet pas d affirmer que
    // rien n a bouge. Le dire « inchange » laisserait un consentement couvrir un outil qu on n a pas compare.
    const sansAnnonce = existant({ nomDistant: 'search', mcpAnnonce: null });
    expect(planifierImport([annonce('search', SCHEMA_A)], [sansAnnonce], { tronque: false }))
      .toEqual([{ type: 'schema_change', nom: 'search', consentementsTombes: 2 }]);
  });
});

describe('🔴 le clouage SURVIT a un rafraichissement', () => {
  /**
   * 🔴 LE DEFAUT QUE CES CAS FERMENT, ET IL ETAIT LE PLUS GRAVE DU LOT. Une annonce distante ne porte
   * aucune notion de source : tout en revient en `modele`. Un outil dont le schema changeait etait donc
   * reecrit avec ses parametres remis « remplis par le modele », c est-a-dire influencables par le contact.
   * Et comme le consentement tombe au meme moment, le client le redonne depuis `AI Agent > Outils`, qui
   * n est PAS l ecran de clouage : il reactive un outil dont l identifiant est redevenu libre sans que
   * rien ne le lui dise.
   *
   * ⚠️ Aggrave par l empreinte, qui couvre TOUTE l annonce : un simple changement de `description` chez le
   * fournisseur suffisait a declencher la remise a zero.
   */
  const cloue: ParamOutil = { name: 'client_id', type: 'string', source: 'champ', cle: 'email', cheminMcp: 'client.id' };

  it('un parametre CLOUE a un champ le reste', () => {
    const neufs: ParamOutil[] = [{ name: 'client_id', type: 'string', source: 'modele', cheminMcp: 'client.id' }];
    expect(reporterClouage(neufs, [cloue])[0]).toMatchObject({ source: 'champ', cle: 'email' });
  });

  it("l appariement se fait sur le CHEMIN distant, pas sur notre nom local", () => {
    // Notre nom est une etiquette locale, qui peut etre recalculee ; le chemin est la donnee de protocole.
    const neufs: ParamOutil[] = [{ name: 'autre_nom', type: 'string', source: 'modele', cheminMcp: 'client.id' }];
    expect(reporterClouage(neufs, [cloue])[0]).toMatchObject({ source: 'champ', cle: 'email' });
  });

  it('un parametre que le client n a PAS cloue reste libre', () => {
    const neufs: ParamOutil[] = [{ name: 'q', type: 'string', source: 'modele', cheminMcp: 'q' }];
    const avant: ParamOutil[] = [{ name: 'q', type: 'string', source: 'modele', cheminMcp: 'q' }];
    expect(reporterClouage(neufs, avant)[0]!.source).toBe('modele');
  });

  it('un parametre NOUVEAU n herite de rien', () => {
    const neufs: ParamOutil[] = [{ name: 'page', type: 'integer', source: 'modele', cheminMcp: 'page' }];
    expect(reporterClouage(neufs, [cloue])[0]!.source).toBe('modele');
  });

  it('⚠️ le clouage est reporte MEME si le type a change', () => {
    // Entre les deux erreurs possibles, une seule se rattrape : un parametre cloue qui devrait etre libre
    // produit un appel que le client corrige en le voyant ; un parametre LIBERE qui devrait etre cloue
    // produit une fuite que personne ne voit.
    const neufs: ParamOutil[] = [{ name: 'client_id', type: 'integer', source: 'modele', cheminMcp: 'client.id' }];
    expect(reporterClouage(neufs, [cloue])[0]).toMatchObject({ source: 'champ', cle: 'email', type: 'integer' });
  });

  it('🔴 et `outilDepuisAnnonce` le fait AUSSI : c est par la que passe le rafraichissement', () => {
    // Le test qui compte : la fonction pure ci-dessus est juste, mais c est `outilDepuisAnnonce` que la
    // route appelle. Une garde qu on peut debrancher sans qu aucun test ne tombe n est pas une garde.
    const o = outilDepuisAnnonce(
      annonce('search', { type: 'object', properties: { client: { type: 'object', properties: { id: { type: 'string' } } } } }),
      'Notion', new Set(), [cloue],
    );
    expect(o.params.find((p) => p.cheminMcp === 'client.id')).toMatchObject({ source: 'champ', cle: 'email' });
  });
});

describe('🔴 le clouage survit a un ALLER-RETOUR par un schema irreprensentable', () => {
  /**
   * 🔴 LA PORTE DE DERRIERE DE L IDOR, trouvee par la revue a froid du 2026-09-17. `reporterClouage`
   * ferme bien la porte principale (un schema qui change ne remet pas tout en « rempli par le modele »),
   * mais il ne peut reporter que ce qui est ENCORE EN BASE. Or un schema irreprensentable rendait
   * `feuilles: []`, donc `params: []`, et `appliquer` ecrit `params = '[]'::jsonb`. Le clouage etait
   * EFFACE. Le serveur distant n avait plus qu a revenir a son schema d avant pour que tout reparte en
   * `modele`, pendant que le consentement tombe et que le client le redonne depuis un ECRAN QUI N EST PAS
   * celui du clouage.
   */
  const cloue: ParamOutil = {
    name: 'client_id', type: 'string', source: 'champ', cle: 'reference', cheminMcp: 'client.id',
  };
  const schemaBon = { type: 'object', properties: { client: { type: 'object', properties: { id: { type: 'string' } } } } };
  // Un TABLEAU : l aplatisseur n a pas de jeu de feuilles fixe a en tirer, donc il refuse.
  const schemaTordu = { type: 'object', properties: { client: { type: 'array' } } };

  it('le passage par le schema tordu GARDE les parametres au lieu de les effacer', () => {
    const o = outilDepuisAnnonce(annonce('search', schemaTordu), 'Notion', new Set(), [cloue]);
    expect(o.nonActivable).not.toBeNull();
    expect(o.params, 'le clouage est conserve, pas remis a zero').toEqual([cloue]);
  });

  it('🔴 et au RETOUR du bon schema, le clouage est toujours la', () => {
    // La chaine complete, telle que la production l enchaine : bon -> tordu -> bon. Sans le correctif, le
    // troisieme appel recoit un tableau VIDE et rend tout en « rempli par le modele », garde ouverte.
    const apresTordu = outilDepuisAnnonce(annonce('search', schemaTordu), 'Notion', new Set(), [cloue]);
    const apresRetour = outilDepuisAnnonce(annonce('search', schemaBon), 'Notion', new Set(), apresTordu.params);
    expect(apresRetour.nonActivable).toBeNull();
    expect(apresRetour.params.find((p) => p.cheminMcp === 'client.id'))
      .toMatchObject({ source: 'champ', cle: 'reference' });
  });

  it('⚠️ mais un outil NEUF non activable n invente aucun parametre', () => {
    // La preuve inverse : sans elle, « garder les anciens » passerait aussi en rendant n importe quoi.
    const neuf = outilDepuisAnnonce(annonce('search', schemaTordu), 'Notion', new Set());
    expect(neuf.params).toEqual([]);
  });
});

describe('un schema que le serveur n a pas su declarer', () => {
  /**
   * 🔴 LE TEST QUI COMPTE EST CELUI DU CABLAGE. `aplatirSchema` refusait deja ces entrees, et six cas le
   * verifiaient ; mais le client leur substituait un objet vide AVANT, si bien que ce refus n etait atteint
   * par aucun chemin reel. Ici on part de l annonce telle que `lister()` la rend, et on regarde ce que
   * `outilDepuisAnnonce` ECRIT : zero parametre ET une raison, jamais zero parametre tout court.
   */
  it('ressort NON ACTIVABLE avec sa raison, jamais activable et sans parametre', () => {
    const absent = outilDepuisAnnonce({ name: 'sans', inputSchema: undefined }, 'Notion', new Set());
    expect(absent.params).toEqual([]);
    expect(absent.nonActivable).toContain('n’a pas déclaré');

    const illisible = outilDepuisAnnonce({ name: 'chaine', inputSchema: 'promis' }, 'Notion', new Set());
    expect(illisible.params).toEqual([]);
    expect(illisible.nonActivable).toContain('illisible');
  });

  it('et les DEUX raisons sont distinctes : une omission ne se lit pas comme une reponse mal formee', () => {
    const absent = outilDepuisAnnonce({ name: 'a', inputSchema: undefined }, 'S', new Set());
    const illisible = outilDepuisAnnonce({ name: 'b', inputSchema: 42 }, 'S', new Set());
    expect(absent.nonActivable).not.toEqual(illisible.nonActivable);
  });
});
