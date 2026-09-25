import { test, expect, type Page } from '@playwright/test';
import { mockMba, TENANT } from './support/mba';
import { repondreAutomatiquement } from './aide/confirmation';

/**
 * L'onglet OUTILS du paramétrage MBA, refait le 2026-09-21 (spec 2026-09-21-outils-maison-mba, § 9, d'après le
 * croquis de Julien) : une liste des outils de l'agent de Meta et d'eux seuls, un gros bouton « Ajouter un
 * outil », un état chez Meta par ligne, et enregistrer envoie chez Meta.
 *
 * ⚠️ LES CAS DE L'ANCIEN FICHIER SONT CONSERVÉS OU REMPLACÉS NOMMÉMENT (plan, Task 9). Un seul est retiré :
 * « un outil MCP mort est lisible ». Un outil MCP ne peut plus être exposé à l'agent de Meta (Meta n'appelle
 * que du HTTP), la liste ne peut donc plus en porter ; il est remplacé par « une cible manquante s'affiche en
 * rouge ».
 */
const OUTIL = {
  id: 'o1',
  name: 'suivi_commande',
  title: 'Suivi de commande',
  description: 'Appelle cet outil dès que le client demande où en est sa commande.',
  nePasUtiliser: 'Jamais pour annuler.',
  type: 'connecteur',
  cible: { type: 'connecteur', requeteId: 'REQ1', libelle: 'Suivi' },
  cibleManquante: null,
  aussiUtilisePar: ['Assistant'],
  actif: true,
  publiable: true,
  risque: 'write',
};
const REQ = (id: string, label: string, variables: unknown[] = []) => ({
  id, tenantId: TENANT, sourceId: 's1', label, methode: 'POST', chemin: '/subscriber/add-tag', parametres: [], entetes: [],
  corps: { mode: 'aucun' }, variables, outputPaths: [], valeursTest: {}, outils: 0, updatedAt: '2026-09-21T00:00:00Z',
});
const CONSIGNE = 'Appelle cet outil dès que le client demande une étiquette. Ne passe pas la main.';

interface Monture {
  outils?: unknown[] | (() => unknown[]);
  gestes?: unknown[] | (() => unknown[]);
  requetes?: unknown[];
  tags?: unknown[];
  fields?: unknown[];
  retenirPublication?: Promise<void>;
  /** La publication chez Meta échoue (502), comme quand Meta refuse. Une fonction décide appel par appel. */
  publicationEchoue?: boolean | (() => boolean);
  /** Le DELETE d'un outil attend cette promesse : de quoi voir l'écran pendant une suppression. */
  retenirSuppression?: Promise<void>;
  /** La création d'un outil attend cette promesse : de quoi voir l'écran pendant un enregistrement. */
  retenirCreation?: Promise<void>;
  /** La création d'un outil est refusée (409), comme sur un nom déjà pris. */
  creationRefusee?: boolean;
  /** La lecture du plan chez Meta échoue (500) quand cette fonction le dit. */
  apercuEchoue?: () => boolean;
  /** Les blocs des scénarios publiés (`GET /mba-outils/blocs`). */
  blocs?: unknown[];
  /** L'API déployée est ENCORE l'ancienne : elle ignore `workflowId` et rend les blocs de tous les scénarios. */
  blocsAncienneRoute?: boolean;
  /** La liste des scénarios (`GET /workflows`). */
  workflows?: unknown[];
  /** Ces lectures échouent (500) : une lecture ratée n'est pas une liste vide. */
  listeEchoue?: boolean;
  requetesEchouent?: boolean;
  fieldsEchouent?: boolean;
}

async function monterOutils(page: Page, m: Monture = {}) {
  const ecrits: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
  const ordre: string[] = [];
  let publications = 0;
  const blocsDemandes: Array<string | null> = [];
  await mockMba(page, {
    custom: async (route, method, url, body) => {
      const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/mba-publication')) {
        if (method === 'GET') {
          if (m.apercuEchoue?.()) { await json({ error: 'Meta indisponible' }, 500); return true; }
          await json({ gestes: typeof m.gestes === 'function' ? m.gestes() : (m.gestes ?? []), phoneNumberId: 'PN1' });
          return true;
        }
        publications += 1;
        ordre.push('publication');
        if (m.retenirPublication) await m.retenirPublication;
        const echoue = typeof m.publicationEchoue === 'function' ? m.publicationEchoue() : m.publicationEchoue;
        if (echoue) { await json({ error: 'Meta a refusé la publication.' }, 502); return true; }
        await json({ faits: [] });
        return true;
      }
      // AVANT la liste des outils : son adresse contient aussi `/mba-outils`.
      if (url.includes(`/tenants/${TENANT}/mba-outils/blocs`)) {
        // Comme le serveur : les blocs du SEUL scénario demandé, et 400 sans scénario.
        const wf = new URL(url).searchParams.get('workflowId');
        blocsDemandes.push(wf);
        if (m.blocsAncienneRoute) { await json({ blocs: m.blocs ?? [] }); return true; }
        if (!wf) { await json({ error: 'choisissez d’abord un scénario' }, 400); return true; }
        await json({ blocs: (m.blocs ?? []).filter((b) => (b as { workflowId?: string }).workflowId === wf) });
        return true;
      }
      if (url.includes(`/tenants/${TENANT}/workflows`)) { await json({ workflows: m.workflows ?? [] }); return true; }
      if (url.includes(`/tenants/${TENANT}/mba-outils`)) {
        if (method === 'GET') {
          if (m.listeEchoue) { await json({ error: 'base indisponible' }, 500); return true; }
          await json({ outils: typeof m.outils === 'function' ? m.outils() : (m.outils ?? []), phoneNumberId: 'PN1' });
          return true;
        }
        ecrits.push({ method, url, body });
        ordre.push(method);
        if (method === 'POST') {
          if (m.retenirCreation) await m.retenirCreation;
          if (m.creationRefusee) { await json({ error: 'Ce nom est déjà pris dans l’espace.' }, 409); return true; }
          await json({ id: 'nouveau' }, 201);
          return true;
        }
        if (method === 'DELETE') {
          if (m.retenirSuppression) await m.retenirSuppression;
          await route.fulfill({ status: 204, body: '' });
          return true;
        }
        await json({ id: 'o1', actif: true });
        return true;
      }
      if (url.includes(`/tenants/${TENANT}/agent-requetes`)) {
        if (m.requetesEchouent) { await json({ error: 'base indisponible' }, 500); return true; }
        await json({ requetes: m.requetes ?? [], champs: [], catalogue: {} });
        return true;
      }
      if (url.includes(`/tenants/${TENANT}/tags`)) { await json({ tags: m.tags ?? [] }); return true; }
      if (url.includes(`/tenants/${TENANT}/user-fields`)) {
        if (m.fieldsEchouent) { await json({ error: 'base indisponible' }, 500); return true; }
        await json({ fields: m.fields ?? [] });
        return true;
      }
      return false;
    },
  });
  return { ecrits, ordre, publications: () => publications, blocsDemandes };
}

test.describe('MBA Paramètres : onglet Outils', () => {
  test('🔴 l’onglet Outils mène à la liste des outils de l’agent de Meta, avec « Ajouter un outil »', async ({ page }) => {
    await monterOutils(page, { outils: [OUTIL] });
    await page.goto('/mba/parametres');
    await page.getByTestId('mba-tab-outils').click();

    await expect(page.getByTestId('mba-outils')).toBeVisible();
    await expect(page.getByTestId('mba-outils-ajouter')).toBeVisible();
    await expect(page.getByTestId('mba-outil-suivi_commande')).toBeVisible();
    await expect(page.getByTestId('mba-outil-type-o1')).toHaveText('Connecteur API');
    await expect(page.getByTestId('mba-outil-partage-o1')).toContainText('Assistant');
  });

  test('l’onglet s’ouvre aussi par l’adresse, et une liste vide invite à ajouter', async ({ page }) => {
    await monterOutils(page, { outils: [] });
    await page.goto('/mba/parametres?tab=outils');
    await expect(page.getByTestId('mba-outils-vide')).toBeVisible();
  });

  test('🔴 une cible manquante s’affiche en rouge (remplace « un outil MCP mort est lisible »)', async ({ page }) => {
    await monterOutils(page, { outils: [{ ...OUTIL, cibleManquante: 'l’appel de cet outil a été supprimé dans Connecteurs API' }] });
    await page.goto('/mba/parametres?tab=outils');
    await expect(page.getByTestId('mba-outil-manque-o1')).toContainText('supprimé');
  });

  test('🔴 l’état par ligne : « Chez Meta », « À envoyer » sur CE nom, tout « À envoyer » si le connecteur doit repartir', async ({ page }) => {
    const B = { ...OUTIL, id: 'o2', name: 'autre' };
    let gestes: unknown[] = [];
    await monterOutils(page, { outils: [OUTIL, B], gestes: () => gestes });
    await page.goto('/mba/parametres?tab=outils');
    await expect(page.getByTestId('mba-outil-etat-o1')).toContainText('Chez Meta');

    gestes = [{ type: 'outil_modifier', nom: 'autre' }];
    await page.reload();
    await expect(page.getByTestId('mba-outil-etat-o1')).toContainText('Chez Meta');
    await expect(page.getByTestId('mba-outil-envoyer-o2')).toBeVisible();

    gestes = [{ type: 'connecteur_modifier', nom: 'EngageMe' }];
    await page.reload();
    await expect(page.getByTestId('mba-outil-envoyer-o1')).toBeVisible();
    await expect(page.getByTestId('mba-outil-envoyer-o2')).toBeVisible();
  });

  test('🔴 « Ajouter » propose les types ; le connecteur est grisé, avec le lien, quand aucun appel n’existe', async ({ page }) => {
    await monterOutils(page, { outils: [], requetes: [], fields: [{ key: 'ville', label: 'Ville', type: 'text' }] });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await expect(page.getByTestId('mba-type-tag')).toBeEnabled();
    await expect(page.getByTestId('mba-type-champ')).toBeEnabled();
    await expect(page.getByTestId('mba-type-connecteur')).toBeDisabled();
    await expect(page.getByTestId('mba-type-connecteur-lien')).toHaveAttribute('href', '/connecteurs');
  });

  test('🔴 Ajouter > Connecteur API : l’appel d’abord, Enregistrer crée PUIS publie', async ({ page }) => {
    const m = await monterOutils(page, {
      outils: [], requetes: [REQ('REQ1', 'Poser une étiquette')],
      gestes: [{ type: 'outil_creer', nom: 'poser_une_etiquette' }],
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await page.getByTestId('mba-type-connecteur').click();
    await page.getByTestId('mba-cible-appel-REQ1').click();
    await expect(page.getByTestId('mba-form-titre')).toHaveValue('Poser une étiquette');
    await expect(page.getByTestId('mba-form-nom')).toHaveValue('poser_une_etiquette');
    // La consigne pré-remplie garde un trou à compléter : tant qu'il est là, rien ne part.
    await expect(page.getByTestId('mba-form-enregistrer')).toBeDisabled();
    await page.getByTestId('mba-form-quand').fill(CONSIGNE);
    await page.getByTestId('mba-form-enregistrer').click();

    await expect.poll(() => m.publications()).toBe(1);
    expect(m.ordre).toEqual(['POST', 'publication']);
    expect(m.ecrits[0]!.body).toMatchObject({
      name: 'poser_une_etiquette', title: 'Poser une étiquette', description: CONSIGNE,
      cible: { type: 'connecteur', requeteId: 'REQ1' },
    });
  });

  /**
   * 🔴 ENVOYER UN BLOC (lot 3), en DEUX TEMPS (Julien, essai réel du 2026-09-22 : « si y a 200 scénarios tu vas
   * jamais réussir à tout afficher ») : le scénario dans une liste, puis les blocs de CE scénario seulement.
   * Le bloc part SEUL, donc un bloc qui attend une réponse ne se choisit pas. Il reste VISIBLE, grisé, avec sa
   * raison qui renvoie vers « Lancer un scénario » : caché, on croirait qu'il a disparu.
   */
  test('🔴 Ajouter > Envoyer un bloc : le scénario d’abord, puis ses seuls blocs, le bloc à boutons grisé', async ({ page }) => {
    const WF = '11111111-1111-4111-8111-111111111111';
    const AUTRE = '33333333-3333-4333-8333-333333333333';
    const CODE_A = `nod_abc_${'A'.repeat(26)}`;
    const CODE_B = `nod_abc_${'B'.repeat(26)}`;
    const CODE_C = `nod_abc_${'C'.repeat(26)}`;
    const m = await monterOutils(page, {
      outils: [], gestes: [{ type: 'outil_creer', nom: 'brochure' }],
      workflows: [
        { id: WF, name: 'Accueil', nodeCount: 3 },
        { id: AUTRE, name: 'Relance', nodeCount: 2 },
        { id: '22222222-2222-4222-8222-222222222222', name: 'Brouillon jamais publié', nodeCount: 0 },
      ],
      blocs: [
        { workflowId: WF, scenario: 'Accueil', code: CODE_A, nom: 'Brochure', type: 'quick_message', envoyable: true, raison: null },
        { workflowId: WF, scenario: 'Accueil', code: CODE_B, nom: 'Oui ou non ?', type: 'quick_message', envoyable: false,
          raison: 'ce bloc attend une réponse du client : utilisez « Lancer un scénario »' },
        { workflowId: AUTRE, scenario: 'Relance', code: CODE_C, nom: 'Petit rappel', type: 'quick_message', envoyable: true, raison: null },
      ],
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await page.getByTestId('mba-type-bloc').click();
    // Une LISTE de scénarios publiés, et aucun bloc tant qu'aucun n'est choisi (aucune lecture de blocs non plus).
    await expect(page.getByTestId('mba-cible-bloc-scenario').locator('option')).toHaveText(['Choisir un scénario', 'Accueil', 'Relance']);
    await expect(page.getByTestId('mba-cible-bloc-liste')).toHaveCount(0);
    expect(m.blocsDemandes).toEqual([]);
    await page.getByTestId('mba-cible-bloc-scenario').selectOption(WF);
    await expect(page.getByTestId(`mba-cible-bloc-${CODE_B}`)).toBeDisabled();
    await expect(page.getByTestId(`mba-cible-bloc-raison-${CODE_B}`)).toContainText('Lancer un scénario');
    // Les blocs d'un AUTRE scénario n'apparaissent pas : la liste est bornée à celui qu'on a choisi.
    await expect(page.getByTestId(`mba-cible-bloc-${CODE_C}`)).toHaveCount(0);
    expect(m.blocsDemandes).toEqual([WF]);
    // Choisir un scénario ne remplit pas le titre : seul le BLOC a un nom qui convient.
    await expect(page.getByTestId('mba-form-titre')).toHaveValue('');
    await page.getByTestId(`mba-cible-bloc-${CODE_A}`).check();
    await expect(page.getByTestId('mba-form-titre')).toHaveValue('Brochure');
    await page.getByTestId('mba-form-quand').fill(CONSIGNE);
    await page.getByTestId('mba-form-enregistrer').click();
    await expect.poll(() => m.publications()).toBe(1);
    expect(m.ecrits[0]!.body).toMatchObject({ name: 'brochure', cible: { type: 'bloc', workflowId: WF, code: CODE_A } });
  });

  /**
   * 🔴 LA FENÊTRE ENTRE LE PUSH ET LE DÉPLOIEMENT (CLAUDE.md, § Déploiement) : Vercel publie cet écran avant l'API
   * qui borne la liste au scénario, et l'ancienne route rend les blocs de TOUS les scénarios. L'écran les filtre.
   */
  test('🔴 contre l’ANCIENNE route, qui rend tous les blocs, l’écran ne montre que ceux du scénario choisi', async ({ page }) => {
    const WF = '11111111-1111-4111-8111-111111111111';
    const AUTRE = '33333333-3333-4333-8333-333333333333';
    const CODE_A = `nod_abc_${'A'.repeat(26)}`;
    const CODE_C = `nod_abc_${'C'.repeat(26)}`;
    await monterOutils(page, {
      outils: [], blocsAncienneRoute: true,
      workflows: [{ id: WF, name: 'Accueil', nodeCount: 3 }, { id: AUTRE, name: 'Relance', nodeCount: 2 }],
      blocs: [
        { workflowId: WF, scenario: 'Accueil', code: CODE_A, nom: 'Brochure', type: 'quick_message', envoyable: true, raison: null },
        { workflowId: AUTRE, scenario: 'Relance', code: CODE_C, nom: 'Petit rappel', type: 'quick_message', envoyable: true, raison: null },
      ],
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await page.getByTestId('mba-type-bloc').click();
    await page.getByTestId('mba-cible-bloc-scenario').selectOption(WF);
    await expect(page.getByTestId(`mba-cible-bloc-${CODE_A}`)).toBeVisible();
    await expect(page.getByTestId(`mba-cible-bloc-${CODE_C}`)).toHaveCount(0);
  });

  test('changer de scénario vide le bloc choisi : on ne peut pas enregistrer un bloc d’un autre scénario', async ({ page }) => {
    const WF = '11111111-1111-4111-8111-111111111111';
    const AUTRE = '33333333-3333-4333-8333-333333333333';
    const CODE_A = `nod_abc_${'A'.repeat(26)}`;
    const CODE_C = `nod_abc_${'C'.repeat(26)}`;
    const m = await monterOutils(page, {
      outils: [], gestes: [{ type: 'outil_creer', nom: 'rappel' }],
      workflows: [{ id: WF, name: 'Accueil', nodeCount: 3 }, { id: AUTRE, name: 'Relance', nodeCount: 2 }],
      blocs: [
        { workflowId: WF, scenario: 'Accueil', code: CODE_A, nom: 'Brochure', type: 'quick_message', envoyable: true, raison: null },
        { workflowId: AUTRE, scenario: 'Relance', code: CODE_C, nom: 'Petit rappel', type: 'quick_message', envoyable: true, raison: null },
      ],
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await page.getByTestId('mba-type-bloc').click();
    await page.getByTestId('mba-cible-bloc-scenario').selectOption(WF);
    await page.getByTestId(`mba-cible-bloc-${CODE_A}`).check();
    await page.getByTestId('mba-cible-bloc-scenario').selectOption(AUTRE);
    await expect(page.getByTestId(`mba-cible-bloc-${CODE_A}`)).toHaveCount(0);
    await expect(page.getByTestId(`mba-cible-bloc-${CODE_C}`)).not.toBeChecked();
    await page.getByTestId(`mba-cible-bloc-${CODE_C}`).check();
    await page.getByTestId('mba-form-titre').fill('Rappel');
    await page.getByTestId('mba-form-quand').fill(CONSIGNE);
    await page.getByTestId('mba-form-enregistrer').click();
    await expect.poll(() => m.publications()).toBe(1);
    expect(m.ecrits[0]!.body).toMatchObject({ cible: { type: 'bloc', workflowId: AUTRE, code: CODE_C } });
  });

  test('🔴 Ajouter > Lancer un scénario : seul un scénario publié est proposé', async ({ page }) => {
    const PUBLIE = '11111111-1111-4111-8111-111111111111';
    const m = await monterOutils(page, {
      outils: [], gestes: [{ type: 'outil_creer', nom: 'accueil' }],
      workflows: [
        { id: PUBLIE, name: 'Accueil', nodeCount: 3 },
        { id: '22222222-2222-4222-8222-222222222222', name: 'Brouillon jamais publié', nodeCount: 0 },
      ],
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await page.getByTestId('mba-type-scenario').click();
    const options = page.getByTestId('mba-cible-scenario').locator('option');
    await expect(options).toHaveText(['Choisir un scénario', 'Accueil']);
    await page.getByTestId('mba-cible-scenario').selectOption(PUBLIE);
    await expect(page.getByTestId('mba-form-titre')).toHaveValue('Accueil');
    await page.getByTestId('mba-form-quand').fill(CONSIGNE);
    await page.getByTestId('mba-form-enregistrer').click();
    await expect.poll(() => m.publications()).toBe(1);
    expect(m.ecrits[0]!.body).toMatchObject({ name: 'accueil', cible: { type: 'scenario', workflowId: PUBLIE } });
  });

  test('🔴 le dessin d’un type est le MEME au choix et dans la liste des outils deployes', async ({ page }) => {
    /**
     * Demande de Julien du 2026-09-24 : « des petites icônes en face de chaque type d'outil qu'on peut
     * rajouter, et qu'on les retrouve dans la liste des outils qui ont été déployés ».
     *
     * 🔴 « LES RETROUVER » EST LA MOITIÉ QUI SE CASSE, ET C'EST ELLE QU'ON TIENT ICI. Deux écrans qui
     * dessinent chacun leur icône se mettent d'accord le premier jour et divergent au premier ajout de type.
     * Le test compare donc le MARQUAGE des deux SVG, pas leur présence : une paire d'icônes différentes pour
     * le même type passerait un `toBeVisible` des deux côtés sans broncher.
     *
     * ⚠️ Un type `inconnu` n'a AUCUN dessin, et c'est vérifié plus bas : un dessin par défaut affirmerait une
     * nature que personne n'a lue.
     */
    const WF = '11111111-1111-4111-8111-111111111111';
    await monterOutils(page, {
      outils: [
        { ...OUTIL, id: 'o9', name: 'brochure', title: 'Envoyer la brochure', type: 'bloc', risque: 'irreversible',
          cible: { type: 'bloc', workflowId: WF, code: `nod_abc_${'A'.repeat(26)}`, scenario: 'Accueil', bloc: 'Brochure' } },
        { ...OUTIL, id: 'o8', name: 'mystere', title: 'Outil d’une version plus neuve', type: 'inconnu',
          cible: { type: 'inconnu' }, cibleManquante: null, aussiUtilisePar: [] },
      ],
    });
    await page.goto('/mba/parametres?tab=outils');

    const dansLaListe = page.getByTestId('mba-outil-type-o9').locator('svg');
    await expect(dansLaListe).toHaveCount(1);
    const marquageListe = await dansLaListe.evaluate((el) => el.innerHTML);

    // Le type `inconnu` reste nu : il n'y a rien à dessiner pour ce qu'on n'a pas su lire.
    await expect(page.getByTestId('mba-outil-type-o8').locator('svg')).toHaveCount(0);

    await page.getByTestId('mba-outils-ajouter').click();
    const auChoix = page.getByTestId('mba-type-bloc').locator('svg');
    await expect(auChoix).toHaveCount(1);
    const marquageChoix = await auChoix.evaluate((el) => el.innerHTML);

    expect(marquageChoix, 'le dessin du type « bloc » diffère entre le choix et la liste').toBe(marquageListe);
    // Et les cinq types proposés en portent chacun un : un type sans dessin ne se voit pas en relisant du code.
    for (const type of ['tag', 'champ', 'bloc', 'scenario', 'connecteur']) {
      await expect(page.getByTestId(`mba-type-${type}`).locator('svg'), `le type « ${type} » n’a pas de dessin`).toHaveCount(1);
    }
  });

  test('la ligne d’un bloc dit son scénario, et que le message PART chez le client', async ({ page }) => {
    const WF = '11111111-1111-4111-8111-111111111111';
    await monterOutils(page, {
      outils: [{
        ...OUTIL, id: 'o9', name: 'brochure', title: 'Envoyer la brochure', type: 'bloc', risque: 'irreversible',
        cible: { type: 'bloc', workflowId: WF, code: `nod_abc_${'A'.repeat(26)}`, scenario: 'Accueil', bloc: 'Brochure' },
      }],
    });
    await page.goto('/mba/parametres?tab=outils');
    await expect(page.getByTestId('mba-outil-cible-o9')).toHaveText('Bloc « Brochure » du scénario Accueil');
    /**
     * 🔴 LE MOT, PAS SEULEMENT LA PRÉSENCE DE L'ÉTIQUETTE (2026-09-24). Elle disait « irréversible » pour un
     * bloc comme pour un appel `DELETE`, deux choses différentes sous un même mot, et Julien l'a relevé :
     * pour un envoi, « irréversible » est vrai et inutile, tout message envoyé l'est. Un `toBeVisible` seul
     * laissait les deux branches interchangeables.
     */
    await expect(page.getByTestId('mba-outil-irreversible-o9')).toHaveText('part chez le client');
    await expect(page.getByTestId('mba-outil-irreversible-o9')).not.toContainText('irréversible');
  });

  test('🔴 choisir un appel montre ce qu’Engage Me remplit et ce que l’agent de Meta demandera', async ({ page }) => {
    await monterOutils(page, {
      requetes: [REQ('REQ2', 'Poser', [
        { nom: 'user', type: 'string', origine: { type: 'champ', cle: 'user_ns' } },
        { nom: 'tag', type: 'string', origine: { type: 'modele' } },
      ])],
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await page.getByTestId('mba-type-connecteur').click();
    await page.getByTestId('mba-cible-appel-REQ2').click();
    await expect(page.getByTestId('mba-cible-valeurs-remplies')).toContainText('user');
    await expect(page.getByTestId('mba-cible-valeurs-remplies')).not.toContainText('tag');
    await expect(page.getByTestId('mba-cible-valeurs-demandees')).toContainText('tag');
  });

  test('🔴 « Modifier » ouvre le formulaire pré-rempli ; Enregistrer envoie le PATCH PUIS publie, sans changer d’appel', async ({ page }) => {
    const m = await monterOutils(page, {
      outils: [OUTIL], requetes: [REQ('REQ1', 'Suivi')], gestes: [{ type: 'outil_modifier', nom: 'suivi_commande' }],
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outil-modifier-o1').click();
    await expect(page.getByTestId('mba-form-titre')).toHaveValue('Suivi de commande');
    await expect(page.getByTestId('mba-form-nom')).toHaveValue('suivi_commande');
    await expect(page.getByTestId('mba-form-pasquand')).toHaveValue('Jamais pour annuler.');
    await expect(page.getByTestId('mba-cible-appel-fixe')).toBeVisible();
    await page.getByTestId('mba-form-quand').fill('Appelle cet outil dès que le client demande sa commande.');
    await page.getByTestId('mba-form-enregistrer').click();

    await expect.poll(() => m.publications()).toBe(1);
    expect(m.ordre).toEqual(['PATCH', 'publication']);
    expect(m.ecrits[0]!.url).toContain('/mba-outils/o1');
    expect(m.ecrits[0]!.body).toEqual({
      name: 'suivi_commande', title: 'Suivi de commande',
      description: 'Appelle cet outil dès que le client demande sa commande.', nePasUtiliser: 'Jamais pour annuler.',
    });
  });

  test('🔴 « À envoyer » : pendant l’envoi l’attente se voit, et un second clic n’envoie rien', async ({ page }) => {
    let libere: () => void = () => {};
    const retenir = new Promise<void>((r) => { libere = r; });
    const m = await monterOutils(page, {
      outils: [OUTIL], gestes: [{ type: 'outil_modifier', nom: 'suivi_commande' }], retenirPublication: retenir,
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outil-envoyer-o1').click();
    await expect(page.getByTestId('mba-outils-attente')).toBeVisible();
    await expect(page.getByTestId('mba-outil-envoyer-o1')).toBeDisabled();

    // Le second clic, celui qui a créé des doublons chez Meta le 2026-09-18.
    await page.getByTestId('mba-outil-envoyer-o1').click({ force: true });
    await page.waitForTimeout(300);
    expect(m.publications()).toBe(1);

    libere();
    await expect(page.getByTestId('mba-outils-attente')).toHaveCount(0);
    expect(m.publications()).toBe(1);
  });

  test('🔴 « Enregistrer » est désactivé pendant un envoi vers Meta, et revient à sa fin', async ({ page }) => {
    let libere: () => void = () => {};
    const retenir = new Promise<void>((r) => { libere = r; });
    await monterOutils(page, {
      outils: [OUTIL], requetes: [REQ('REQ1', 'Suivi')], gestes: [{ type: 'outil_modifier', nom: 'suivi_commande' }],
      retenirPublication: retenir,
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outil-modifier-o1').click();
    await expect(page.getByTestId('mba-form-enregistrer')).toBeEnabled();

    await page.getByTestId('mba-outil-envoyer-o1').click();
    await expect(page.getByTestId('mba-outils-attente')).toBeVisible();
    await expect(page.getByTestId('mba-form-enregistrer')).toBeDisabled();

    libere();
    await expect(page.getByTestId('mba-form-enregistrer')).toBeEnabled();
  });

  test('🔴 créer un tag : le nom se calcule depuis le titre, et la cible part telle quelle', async ({ page }) => {
    const m = await monterOutils(page, { outils: [], tags: [{ tag: 'vip', count: 3 }], gestes: [{ type: 'outil_creer', nom: 'marquer_vip' }] });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await page.getByTestId('mba-type-tag').click();
    await expect(page.getByTestId('mba-cible-tag-note')).toContainText('n’est pas rejoué ensuite');
    await page.getByTestId('mba-cible-tag').fill('vip');
    await page.getByTestId('mba-form-titre').fill('Marquer VIP');
    await expect(page.getByTestId('mba-form-nom')).toHaveValue('marquer_vip');
    await expect(page.getByTestId('mba-form-enregistrer')).toBeDisabled();
    await page.getByTestId('mba-form-quand').fill(CONSIGNE);
    await page.getByTestId('mba-form-enregistrer').click();

    await expect.poll(() => m.publications()).toBe(1);
    expect(m.ecrits[0]!.body).toMatchObject({ name: 'marquer_vip', title: 'Marquer VIP', cible: { type: 'tag', tag: 'vip' } });
  });

  test('créer une information : le champ du mini-CRM, et les valeurs permises une par ligne', async ({ page }) => {
    const m = await monterOutils(page, {
      outils: [], fields: [{ key: 'ville', label: 'Ville', type: 'text' }], gestes: [{ type: 'outil_creer', nom: 'noter_ville' }],
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await page.getByTestId('mba-type-champ').click();
    await page.getByTestId('mba-cible-champ').selectOption('ville');
    await page.getByTestId('mba-cible-valeurs').fill('Paris\n\nLyon');
    await page.getByTestId('mba-form-titre').fill('Noter la ville');
    await page.getByTestId('mba-form-quand').fill('Appelle cet outil dès que le client te donne sa ville.');
    await page.getByTestId('mba-form-enregistrer').click();

    await expect.poll(() => m.ecrits.length).toBe(1);
    expect(m.ecrits[0]!.body).toMatchObject({ cible: { type: 'champ', champ: 'ville', valeurs: ['Paris', 'Lyon'] } });
  });

  test('🔴 supprimer : une confirmation, un DELETE, puis la publication SANS seconde confirmation pour cet outil', async ({ page }) => {
    const dialogues = await repondreAutomatiquement(page, () => true);
    const m = await monterOutils(page, {
      outils: [OUTIL],
      gestes: [{ type: 'outil_supprimer', nom: 'suivi_commande' }, { type: 'connecteur_supprimer', nom: 'EngageMe' }],
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outil-supprimer-o1').click();

    await expect.poll(() => m.publications()).toBe(1);
    expect(m.ordre).toEqual(['DELETE', 'publication']);
    expect(dialogues).toHaveLength(1);
    expect(dialogues[0]).toContain('Suivi de commande');
  });

  test('🔴 un effacement IMPRÉVU chez Meta se fait confirmer, en le nommant', async ({ page }) => {
    const dialogues = await repondreAutomatiquement(page, () => true);
    const m = await monterOutils(page, {
      outils: [OUTIL],
      gestes: [{ type: 'outil_supprimer', nom: 'suivi_commande' }, { type: 'outil_supprimer', nom: 'main_levee' }],
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outil-supprimer-o1').click();

    await expect.poll(() => m.publications()).toBe(1);
    expect(dialogues).toHaveLength(2);
    expect(dialogues[1]).toContain('main_levee');
    expect(dialogues[1]).not.toContain('suivi_commande');
  });

  test('🔴 un outil désactivé le dit, et « Réactiver » le rallume puis publie (plan, écart 4)', async ({ page }) => {
    const m = await monterOutils(page, { outils: [{ ...OUTIL, actif: false }], gestes: [{ type: 'outil_creer', nom: 'suivi_commande' }] });
    await page.goto('/mba/parametres?tab=outils');
    await expect(page.getByTestId('mba-outil-etat-o1')).toContainText('Désactivé');
    await expect(page.getByTestId('mba-outil-envoyer-o1')).toHaveCount(0);
    await page.getByTestId('mba-outil-reactiver-o1').click();

    await expect.poll(() => m.publications()).toBe(1);
    expect(m.ordre).toEqual(['PUT', 'publication']);
    expect(m.ecrits[0]!.url).toContain('/mba-outils/o1/actif');
    expect(m.ecrits[0]!.body).toEqual({ valeur: true });
  });

  test('🔴 un outil désactivé que Meta liste ENCORE propose de l’en retirer, sans confirmation', async ({ page }) => {
    const m = await monterOutils(page, { outils: [{ ...OUTIL, actif: false }], gestes: [{ type: 'outil_supprimer', nom: 'suivi_commande' }] });
    const dialogues = await repondreAutomatiquement(page, () => true);
    await page.goto('/mba/parametres?tab=outils');
    await expect(page.getByTestId('mba-outil-etat-o1')).toContainText('Désactivé');
    await expect(page.getByTestId('mba-outil-reactiver-o1')).toBeVisible();
    await page.getByTestId('mba-outil-retirer-o1').click();

    await expect.poll(() => m.publications()).toBe(1);
    // L'effacement de CET outil est ce que le bouton demande : aucune confirmation.
    expect(dialogues).toEqual([]);
  });

  test('🔴 un outil qui ne part jamais chez Meta n’y est jamais « ✓ »', async ({ page }) => {
    await monterOutils(page, {
      outils: [{ ...OUTIL, publiable: false, cible: { type: 'connecteur', requeteId: 'REQ9', libelle: null },
        cibleManquante: 'l’appel de cet outil a été supprimé dans Connecteurs API' }],
      gestes: [],
    });
    await page.goto('/mba/parametres?tab=outils');
    await expect(page.getByTestId('mba-outil-etat-o1')).toContainText('Pas chez Meta');
    // La coche est devenue une icône (passe 2) : on vérifie l'absence de l'ÉTAT « chez Meta », pas d'un glyphe.
    await expect(page.getByTestId('mba-outil-chez-meta-o1')).toHaveCount(0);
  });

  test('🔴 un envoi raté après un enregistrement dit que l’outil EST enregistré', async ({ page }) => {
    await monterOutils(page, {
      outils: [], tags: [{ tag: 'vip', count: 3 }], gestes: [{ type: 'outil_creer', nom: 'marquer_vip' }], publicationEchoue: true,
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await page.getByTestId('mba-type-tag').click();
    await page.getByTestId('mba-cible-tag').fill('vip');
    await page.getByTestId('mba-form-titre').fill('Marquer VIP');
    await page.getByTestId('mba-form-quand').fill(CONSIGNE);
    await page.getByTestId('mba-form-enregistrer').click();
    await expect(page.getByTestId('mba-outils-erreur')).toContainText('L’outil est enregistré');
    await expect(page.getByTestId('mba-outils-erreur')).toContainText('À envoyer');
  });

  test('🔴 « Enregistrer une information » est grisé, avec le lien, quand le mini-CRM n’a aucun champ', async ({ page }) => {
    await monterOutils(page, { outils: [], fields: [] });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await expect(page.getByTestId('mba-type-champ')).toBeDisabled();
    await expect(page.getByTestId('mba-type-champ-lien')).toHaveAttribute('href', '/fields');
  });

  test('🔴 une lecture ratée n’est pas « aucun » : elle le dit et propose de relire', async ({ page }) => {
    await monterOutils(page, { outils: [], requetesEchouent: true, fieldsEchouent: true });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await expect(page.getByTestId('mba-type-connecteur')).toBeDisabled();
    await expect(page.getByTestId('mba-type-connecteur-lien')).toHaveCount(0);
    await expect(page.getByTestId('mba-type-connecteur-relire')).toBeVisible();
    await expect(page.getByTestId('mba-type-champ-relire')).toBeVisible();
  });

  test('🔴 la liste qui ne se lit pas ne dit JAMAIS « Aucun outil »', async ({ page }) => {
    await monterOutils(page, { listeEchoue: true });
    await page.goto('/mba/parametres?tab=outils');
    await expect(page.getByTestId('mba-outils-lecture-ratee')).toBeVisible();
    await expect(page.getByTestId('mba-outils-vide')).toHaveCount(0);
    await expect(page.getByTestId('mba-outils-relire')).toBeVisible();
  });

  /**
   * 🔴 CE QUE META LISTE SANS OUTIL ICI N'EST PAS « SUPPRIMÉ ICI » (relecture du 2026-09-22). `main_levee` a été
   * ajouté À LA MAIN chez Meta : le bandeau le montre, mais son bouton ne l'efface pas sans le NOMMER dans une
   * confirmation. La version précédente l'effaçait sans rien demander, et Meta ne rend jamais un outil effacé.
   */
  test('🔴 un outil ajouté à la main chez Meta n’est jamais effacé sans confirmation qui le nomme', async ({ page }) => {
    const m = await monterOutils(page, { outils: [OUTIL], gestes: [{ type: 'outil_supprimer', nom: 'main_levee' }] });
    const dialogues = await repondreAutomatiquement(page, () => false);
    await page.goto('/mba/parametres?tab=outils');
    await expect(page.getByTestId('mba-outils-retraits')).toContainText('sans outil ici');
    await expect(page.getByTestId('mba-outils-retraits')).toContainText('main_levee');
    await expect(page.getByTestId('mba-outils-retraits')).not.toContainText('Supprimés ici');
    await page.getByTestId('mba-outils-retraits-envoyer').click();
    await expect.poll(() => dialogues.length).toBe(1);
    expect(dialogues[0]).toContain('main_levee');
    // Refusée : rien ne part.
    expect(m.publications()).toBe(0);
  });

  /**
   * 🔴 LE SCÉNARIO QUE LA RELECTURE A TROUVÉ : supprimer un outil, REFUSER la confirmation qui nomme `main_levee`,
   * puis suivre le message vers le bandeau. Le bouton ne doit laisser partir sans question QUE l'outil supprimé
   * ici ; `main_levee` est redemandé.
   */
  test('🔴 après un refus, le bandeau ne laisse partir sans question que ce qui a été supprimé ici', async ({ page }) => {
    let supprime = false;
    const m = await monterOutils(page, {
      outils: () => (supprime ? [] : [OUTIL]),
      gestes: () => (supprime
        ? [{ type: 'outil_supprimer', nom: 'suivi_commande' }, { type: 'outil_supprimer', nom: 'main_levee' }]
        : [{ type: 'outil_supprimer', nom: 'main_levee' }]),
    });
    let nombre = 0;
    const dialogues = await repondreAutomatiquement(page, () => {
      nombre += 1;
      // La première (« Supprimer … ? ») est acceptée, les suivantes refusées.
      if (nombre === 1) { supprime = true; return true; }
      return false;
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outil-supprimer-o1').click();
    await expect.poll(() => dialogues.length).toBe(2);
    expect(dialogues[1]).toContain('main_levee');
    await expect(page.getByTestId('mba-outils-erreur')).toContainText('supprimé ici');
    await expect(page.getByTestId('mba-outils-retraits')).toContainText('suivi_commande');
    await page.getByTestId('mba-outils-retraits-envoyer').click();
    await expect.poll(() => dialogues.length).toBe(3);
    expect(dialogues[2]).toContain('main_levee');
    expect(dialogues[2]).not.toContain('suivi_commande');
    expect(m.publications()).toBe(0);
  });

  /**
   * 🔴 LE CHEMIN POSITIF DU BANDEAU : un outil supprimé ICI, dont l'envoi a échoué, part par « Envoyer à Meta »
   * sans autre confirmation que celle de la suppression elle-même.
   */
  test('🔴 un retrait fait ici et resté en attente part par le bandeau, sans confirmation', async ({ page }) => {
    let supprime = false;
    let essais = 0;
    const m = await monterOutils(page, {
      outils: () => (supprime ? [] : [OUTIL]),
      gestes: () => (supprime ? [{ type: 'outil_supprimer', nom: 'suivi_commande' }] : []),
      publicationEchoue: () => { essais += 1; return essais === 1; },
    });
    const dialogues = await repondreAutomatiquement(page, () => { supprime = true; return true; });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outil-supprimer-o1').click();
    await expect(page.getByTestId('mba-outils-erreur')).toContainText('supprimé ici');
    await expect(page.getByTestId('mba-outils-retraits')).toContainText('suivi_commande');
    await page.getByTestId('mba-outils-retraits-envoyer').click();
    await expect.poll(() => m.publications()).toBe(2);
    // La seule boîte est « Supprimer … ? » : le retrait fait ici n'est pas redemandé.
    expect(dialogues).toHaveLength(1);
  });

  /**
   * 🔴 LA DISPENSE NE SURVIT PAS AU RETRAIT (relecture du 2026-09-22). `suivi_commande` est supprimé ici et son
   * retrait PART ; plus tard, Meta liste de nouveau un outil de ce nom (ajouté à la main). Le bandeau doit le
   * NOMMER dans une confirmation : la dispense accordée par nom était sinon valable toute la visite.
   */
  test('🔴 un nom supprimé puis RÉAPPARU chez Meta n’est plus dispensé de confirmation', async ({ page }) => {
    const B = { ...OUTIL, id: 'o2', name: 'autre', title: 'Autre outil' };
    let supprime1 = false;
    let supprime2 = false;
    const SUIVI = { type: 'outil_supprimer', nom: 'suivi_commande' };
    const AUTRE = { type: 'outil_supprimer', nom: 'autre' };
    const m = await monterOutils(page, {
      outils: () => [...(supprime1 ? [] : [OUTIL]), ...(supprime2 ? [] : [B])],
      gestes: () => {
        if (!supprime1) return [];
        if (m.publications() === 0) return [SUIVI];
        if (!supprime2) return [];
        return [AUTRE, SUIVI];
      },
    });
    const dialogues = await repondreAutomatiquement(page, (texte) => {
      if (texte.includes('Suivi de commande')) { supprime1 = true; return true; }
      if (texte.includes('Autre outil')) { supprime2 = true; return true; }
      return false;
    });
    await page.goto('/mba/parametres?tab=outils');
    // 1. Suppression de suivi_commande : son retrait part.
    await page.getByTestId('mba-outil-supprimer-o1').click();
    await expect.poll(() => m.publications()).toBe(1);
    await expect(page.getByTestId('mba-outils-attente')).toHaveCount(0);
    // 2. Suppression d'« autre » : Meta liste de nouveau suivi_commande, la confirmation le nomme, refusée.
    await page.getByTestId('mba-outil-supprimer-o2').click();
    await expect.poll(() => dialogues.length).toBe(3);
    expect(dialogues[2]).toContain('suivi_commande');
    // 3. Le bandeau : « autre » est dispensé, suivi_commande est redemandé.
    await expect(page.getByTestId('mba-outils-retraits')).toContainText('suivi_commande');
    await page.getByTestId('mba-outils-retraits-envoyer').click();
    await expect.poll(() => dialogues.length).toBe(4);
    expect(dialogues[3]).toContain('suivi_commande');
    expect(dialogues[3]).not.toContain('autre');
    expect(m.publications()).toBe(1);
  });

  test('🔴 « Enregistrer » est bloqué pendant une suppression', async ({ page }) => {
    let liberer: () => void = () => {};
    const retenue = new Promise<void>((ok) => { liberer = ok; });
    await monterOutils(page, { outils: [OUTIL], tags: [{ tag: 'vip', count: 3 }], retenirSuppression: retenue });
    await repondreAutomatiquement(page, () => true);
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await page.getByTestId('mba-type-tag').click();
    await page.getByTestId('mba-cible-tag').fill('vip');
    await page.getByTestId('mba-form-titre').fill('Marquer VIP');
    await page.getByTestId('mba-form-quand').fill(CONSIGNE);
    await expect(page.getByTestId('mba-form-enregistrer')).toBeEnabled();
    await page.getByTestId('mba-outil-supprimer-o1').click();
    await expect(page.getByTestId('mba-form-enregistrer')).toBeDisabled();
    // Le formulaire dit ce qui se passe : une suppression, pas un envoi.
    await expect(page.getByTestId('mba-form-manque')).toContainText('suppression');
    // Rien ne part pendant la suppression : « Envoi… » ne s'affiche pas.
    await expect(page.getByTestId('mba-outils-attente')).toHaveCount(0);
    liberer();
    await expect(page.getByTestId('mba-form-enregistrer')).toBeEnabled();
  });

  test('🔴 « Supprimer » et « Modifier » sont bloqués pendant un enregistrement', async ({ page }) => {
    let liberer: () => void = () => {};
    const retenue = new Promise<void>((ok) => { liberer = ok; });
    await monterOutils(page, {
      outils: [OUTIL], tags: [{ tag: 'vip', count: 3 }], gestes: [{ type: 'outil_creer', nom: 'marquer_vip' }],
      retenirCreation: retenue,
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await page.getByTestId('mba-type-tag').click();
    await page.getByTestId('mba-cible-tag').fill('vip');
    await page.getByTestId('mba-form-titre').fill('Marquer VIP');
    await page.getByTestId('mba-form-quand').fill(CONSIGNE);
    await page.getByTestId('mba-form-enregistrer').click();
    await expect(page.getByTestId('mba-outil-supprimer-o1')).toBeDisabled();
    // Ouvrir un autre outil, ou annuler, démonterait le formulaire en cours : son erreur se perdrait avec la saisie.
    await expect(page.getByTestId('mba-outil-modifier-o1')).toBeDisabled();
    await expect(page.getByTestId('mba-form-annuler')).toBeDisabled();
    liberer();
    await expect(page.getByTestId('mba-outil-supprimer-o1')).toBeEnabled();
    await expect(page.getByTestId('mba-outil-modifier-o1')).toBeEnabled();
  });

  /**
   * 🔴 UN ENREGISTREMENT REFUSÉ LIBÈRE L'ÉCRAN (relecture du 2026-09-22). Le cas courant est un nom déjà pris
   * (409) : si l'écran restait occupé, le formulaire se dirait « suppression ou envoi en cours » et « Supprimer »
   * resterait grisé jusqu'au rechargement.
   */
  test('🔴 un enregistrement refusé libère l’écran, et dit pourquoi', async ({ page }) => {
    await monterOutils(page, {
      outils: [OUTIL], tags: [{ tag: 'vip', count: 3 }], creationRefusee: true,
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await page.getByTestId('mba-type-tag').click();
    await page.getByTestId('mba-cible-tag').fill('vip');
    await page.getByTestId('mba-form-titre').fill('Marquer VIP');
    await page.getByTestId('mba-form-quand').fill(CONSIGNE);
    await page.getByTestId('mba-form-enregistrer').click();
    await expect(page.getByTestId('mba-form-erreur')).toContainText('déjà pris');
    await expect(page.getByTestId('mba-form-enregistrer')).toBeEnabled();
    await expect(page.getByTestId('mba-outil-supprimer-o1')).toBeEnabled();
    await expect(page.getByTestId('mba-outil-modifier-o1')).toBeEnabled();
  });

  /**
   * 🔴 LA DISPENSE S'ÉTEINT À LA PUBLICATION, PAS À LA RELECTURE (relecture du 2026-09-22). Ici la relecture du
   * plan qui SUIT le retrait de `suivi_commande` échoue : la dispense doit être tombée quand même, sinon le nom,
   * réapparu chez Meta, partirait sans être nommé.
   */
  test('🔴 la dispense tombe dès la publication, même si la relecture qui suit échoue', async ({ page }) => {
    const B = { ...OUTIL, id: 'o2', name: 'autre', title: 'Autre outil' };
    let supprime1 = false;
    let supprime2 = false;
    const SUIVI = { type: 'outil_supprimer', nom: 'suivi_commande' };
    const AUTRE = { type: 'outil_supprimer', nom: 'autre' };
    const m = await monterOutils(page, {
      outils: () => [...(supprime1 ? [] : [OUTIL]), ...(supprime2 ? [] : [B])],
      gestes: () => {
        if (!supprime1) return [];
        if (m.publications() === 0) return [SUIVI];
        return [AUTRE, SUIVI];
      },
      // La relecture qui suit la première publication échoue, et seulement elle.
      apercuEchoue: () => supprime1 && m.publications() === 1 && !supprime2,
    });
    const dialogues = await repondreAutomatiquement(page, (texte) => {
      if (texte.includes('Suivi de commande')) { supprime1 = true; return true; }
      if (texte.includes('Autre outil')) { supprime2 = true; return true; }
      return false;
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outil-supprimer-o1').click();
    await expect.poll(() => m.publications()).toBe(1);
    await expect(page.getByTestId('mba-outils-attente')).toHaveCount(0);
    await page.getByTestId('mba-outil-supprimer-o2').click();
    await expect.poll(() => dialogues.length).toBe(3);
    await expect(page.getByTestId('mba-outils-retraits')).toContainText('suivi_commande');
    await page.getByTestId('mba-outils-retraits-envoyer').click();
    await expect.poll(() => dialogues.length).toBe(4);
    expect(dialogues[3]).toContain('suivi_commande');
    expect(m.publications()).toBe(1);
  });

  test('🔴 le bandeau ne s’affiche pas sur une liste qui ne s’est pas lue', async ({ page }) => {
    await monterOutils(page, { listeEchoue: true, gestes: [{ type: 'outil_supprimer', nom: 'suivi_commande' }] });
    await page.goto('/mba/parametres?tab=outils');
    await expect(page.getByTestId('mba-outils-lecture-ratee')).toBeVisible();
    await expect(page.getByTestId('mba-outils-retraits')).toHaveCount(0);
  });

  test('🔴 « Supprimer » est bloqué dès le clic, pas seulement pendant l’envoi', async ({ page }) => {
    let liberer: () => void = () => {};
    const retenue = new Promise<void>((ok) => { liberer = ok; });
    const B = { ...OUTIL, id: 'o2', name: 'autre' };
    await monterOutils(page, { outils: [OUTIL, B], retenirSuppression: retenue });
    await repondreAutomatiquement(page, () => true);
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outil-supprimer-o1').click();
    await expect(page.getByTestId('mba-outil-supprimer-o2')).toBeDisabled();
    liberer();
    await expect(page.getByTestId('mba-outil-supprimer-o2')).toBeEnabled();
  });

  test('🔴 une lecture ratée des champs n’annonce JAMAIS un champ disparu', async ({ page }) => {
    const INFO = { ...OUTIL, type: 'champ', cible: { type: 'champ', champ: 'ville', valeurs: [] }, aussiUtilisePar: [] };
    await monterOutils(page, { outils: [INFO], fieldsEchouent: true });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outil-modifier-o1').click();
    await expect(page.getByTestId('mba-cible-champ-illisible')).toBeVisible();
    await expect(page.getByTestId('mba-cible-champ-disparu')).toHaveCount(0);
    await expect(page.getByTestId('mba-cible-champ')).toHaveValue('ville');
  });

  test('🔴 une lecture ratée des appels ne dit pas « Appel supprimé »', async ({ page }) => {
    await monterOutils(page, { outils: [OUTIL], requetesEchouent: true });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outil-modifier-o1').click();
    await expect(page.getByTestId('mba-cible-appels-illisibles')).toBeVisible();
    await expect(page.getByTestId('mba-form')).not.toContainText('Appel supprimé');
  });

  test('un champ au nom interne trop long est proposé grisé, avec sa raison', async ({ page }) => {
    await monterOutils(page, {
      outils: [], fields: [{ key: 'ville', label: 'Ville', type: 'text' }, { key: 'x'.repeat(70), label: 'Très long', type: 'text' }],
    });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outils-ajouter').click();
    await page.getByTestId('mba-type-champ').click();
    // `toBeDisabled` ne lit pas l'attribut sur un `<option>` : on lit l'attribut lui-même.
    await expect(page.locator('[data-testid="mba-cible-champ"] option', { hasText: 'Très long' })).toHaveAttribute('disabled', '');
    await expect(page.locator('[data-testid="mba-cible-champ"] option', { hasText: 'Ville' })).not.toHaveAttribute('disabled', '');
  });

  test('🔴 « Supprimer » est désactivé pendant un envoi vers Meta', async ({ page }) => {
    let liberer: () => void = () => {};
    const retenue = new Promise<void>((ok) => { liberer = ok; });
    await monterOutils(page, { outils: [OUTIL], gestes: [{ type: 'outil_modifier', nom: 'suivi_commande' }], retenirPublication: retenue });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outil-envoyer-o1').click();
    await expect(page.getByTestId('mba-outils-attente')).toBeVisible();
    await expect(page.getByTestId('mba-outil-supprimer-o1')).toBeDisabled();
    liberer();
    await expect(page.getByTestId('mba-outil-supprimer-o1')).toBeEnabled();
  });

  test('🔴 un appel irréversible le dit, sur la ligne comme au choix de l’appel', async ({ page }) => {
    await monterOutils(page, {
      outils: [{ ...OUTIL, risque: 'irreversible' }], requetes: [REQ('REQ9', 'Effacer la fiche')].map((r) => ({ ...r, methode: 'DELETE' })),
    });
    await page.goto('/mba/parametres?tab=outils');
    // 🔴 L'AUTRE BRANCHE DU MÊME MOT, ET ELLE GARDE « IRRÉVERSIBLE » : `o1` est un appel de connecteur en
    // `DELETE`, qui détruit quelque chose dans le système du client. Là, le mot est exactement juste. Les
    // deux assertions ensemble empêchent d'échanger les branches sans qu'un test tombe.
    await expect(page.getByTestId('mba-outil-irreversible-o1')).toHaveText('irréversible');
    await page.getByTestId('mba-outils-ajouter').click();
    await page.getByTestId('mba-type-connecteur').click();
    await expect(page.getByTestId('mba-cible-appel-irreversible-REQ9')).toBeVisible();
    await page.getByTestId('mba-cible-appel-REQ9').click();
    await expect(page.getByTestId('mba-cible-appel-avertissement')).toContainText('sans validation humaine');
  });

  test('🔴 corriger les mots d’un outil dont le champ a disparu n’envoie PAS la cible, et le champ disparu se voit', async ({ page }) => {
    const INFO = { ...OUTIL, type: 'champ', cible: { type: 'champ', champ: 'code_postal', valeurs: [] },
      cibleManquante: 'le champ « code_postal » n’existe plus dans le mini-CRM', aussiUtilisePar: [] };
    const m = await monterOutils(page, { outils: [INFO], fields: [{ key: 'ville', label: 'Ville', type: 'text' }] });
    await page.goto('/mba/parametres?tab=outils');
    await page.getByTestId('mba-outil-modifier-o1').click();
    await expect(page.getByTestId('mba-cible-champ-disparu')).toBeVisible();
    await expect(page.getByTestId('mba-cible-champ')).toHaveValue('code_postal');
    await page.getByTestId('mba-form-titre').fill('Suivi retouché');
    await page.getByTestId('mba-form-enregistrer').click();
    await expect.poll(() => m.ecrits.length).toBe(1);
    expect(m.ecrits[0]!.method).toBe('PATCH');
    expect(m.ecrits[0]!.body).not.toHaveProperty('cible');
  });

  test('`/outils` renvoie vers l’onglet de l’agent de Meta', async ({ page }) => {
    await monterOutils(page, { outils: [OUTIL] });
    await page.goto('/outils');
    await expect(page).toHaveURL(/\/mba\/parametres\?tab=outils/);
    await expect(page.getByTestId('mba-outils')).toBeVisible();
  });
});
