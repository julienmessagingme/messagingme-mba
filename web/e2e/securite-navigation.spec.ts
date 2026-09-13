import { test, expect, type Page } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement } from './aide/largeur';

/**
 * LE CENTRE DE SÉCURITÉ & COMPLIANCE : son menu et sa porte d'entrée.
 *
 * 🔴 LE CAS QUI COMPTE EST LA CORRESPONDANCE. Une boîte de la page d'accueil qui ne correspond à aucun
 * sous-menu (ou l'inverse) est le défaut qui arrive vraiment sur ce genre d'écran : on annonce un chantier,
 * puis on livre la page d'accueil avant le contenu, et l'utilisateur clique dans le vide.
 *
 * ⚠️ LES DEUX JOURNAUX ONT DÉMÉNAGÉ, PAS CHANGÉ. Un test vérifie qu'ils ne sont plus dans Paramètres, et un
 * autre qu'ils sont bien ici : sans le second, « déplacer » et « supprimer » se ressembleraient.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

/** Les PATCH captés par le faux serveur : c'est ce qui prouve qu'un choix est bien ENVOYÉ, pas seulement affiché. */
type Ecriture = { chemin: string; corps: unknown };

async function monter(page: Page, opts: { requetes?: Array<{ id: string; label: string }>; branche?: string | null; ecritures?: Ecriture[]; mentionIa?: string | null; agentsIa?: Array<{ id: string; label: string; status: string; mentionIa: string }> } = {}): Promise<void> {
  const requetes = opts.requetes ?? [{ id: 'rq-1', label: 'Desabonner dans le CRM' }];
  let branche = opts.branche ?? null;
  let mentionIa = opts.mentionIa === undefined ? null : opts.mentionIa;
  const agentsIa = opts.agentsIa ?? [
    { id: 'ag-1', label: 'Conseiller sejours', status: 'active', mentionIa: 'Vous echangez avec un assistant automatique.' },
  ];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = new URL(route.request().url()).pathname.replace('/api/backend', '');
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    // ⚠️ AVANT le `endsWith('/settings')` : `/settings/poussee-optout` ne finit pas par `/settings`, mais
    // l'ordre reste explicite pour que l'ajout d'un `includes` un jour ne les confonde pas.
    // La fiche d un agent, pour le cas qui verifie que le selecteur a bien quitte cet ecran.
    if (chemin.endsWith('/agents')) return json({ agents: [{ id: 'ag-1', label: 'Conseiller sejours', status: 'active', sorties: [] }] });
    if (chemin.includes('/agents/ag-1')) {
      return json({
        agent: {
          id: 'ag-1', label: 'Conseiller sejours', status: 'active',
          mentionIa: 'Vous echangez avec un assistant automatique.', modele: 'm',
          maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000, inactiviteMinutes: 30,
          contactInconnu: 'lecture_seule',
          contenu: { nom: '', objectif: '', ton: '', personnalite: '', reglesTransfert: '', sorties: [] },
          ficheVersion: 1,
        },
      });
    }
    if (chemin.endsWith('/settings/mention-ia')) {
      if (route.request().method() === 'PATCH') {
        const corps = route.request().postDataJSON() as { frequence: string };
        opts.ecritures?.push({ chemin, corps });
        mentionIa = corps.frequence;
        return json({ frequence: mentionIa });
      }
      return json({ frequence: mentionIa ?? 'session', reglee: mentionIa !== null, agents: agentsIa });
    }
    if (chemin.endsWith('/settings/poussee-optout')) {
      if (route.request().method() === 'PATCH') {
        const corps = route.request().postDataJSON() as { requestId: string | null };
        opts.ecritures?.push({ chemin, corps });
        branche = corps.requestId;
        return json({ requestId: branche });
      }
      return json({ requestId: branche, requetes });
    }
    if (chemin.endsWith('/contacts/refus-possibles')) {
      return json({ scannes: 42, refus: [
        { messageId: 'm1', conversationId: 'cv1', contactId: 'ct9', waId: '33600000009', profileName: 'Bob', body: 'arrêtez de me contacter', recuLe: '2026-09-12T09:00:00.000Z' },
      ] });
    }
    if (chemin.endsWith('/contacts/desabonnes')) {
      return json({ contacts: [
        { id: 'ct1', profileName: 'Alice', phoneE164: '+33600000001', desabonneLe: '2026-09-12T10:00:00.000Z', source: 'scenario' },
        // ⚠️ Une ligne SANS date : c'est le cas des désabonnements d'avant la migration 0138, et l'écran
        // doit le DIRE plutôt que d'inventer une date.
        { id: 'ct2', profileName: null, phoneE164: '+33600000002', desabonneLe: null, source: 'crm' },
      ] });
    }
    if (chemin.endsWith('/audit')) return json({ entries: [], total: 0 });
    if (chemin.endsWith('/erreurs-livraison')) return json({ erreurs: [], total: 0 });
    if (chemin.endsWith('/unread-count')) return json({ count: 0 });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (chemin.endsWith('/settings')) {
      return json({
        mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false,
        controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {},
      });
    }
    return json({});
  });
}

test.describe('Centre de sécurité & compliance', () => {
  test('l entree est au BAS du menu, et elle deplie ses sous-menus', async ({ page }) => {
    await monter(page);
    await page.goto('/securite');
    await expect(page.getByTestId('securite-accueil')).toBeVisible();
    /**
     * 🔴 DANS LA BARRE DU BAS, ET LA PRÉCISION COMPTE : les mêmes libellés existent aussi dans les boîtes de
     * la page. Chercher au hasard dans la page passerait même si le menu restait replié, c'est-à-dire dans
     * le cas exact que ce test existe pour attraper.
     */
    const bas = page.getByTestId('nav-bas');
    await expect(bas.getByRole('link', { name: 'Audit trails' })).toBeVisible();
    await expect(bas.getByRole('link', { name: 'Journal des erreurs' })).toBeVisible();
  });

  test('la page d accueil porte le message d accueil demande', async ({ page }) => {
    await monter(page);
    await page.goto('/securite');
    await expect(page.getByRole('heading', { level: 1 }))
      .toHaveText(/Bienvenue au centre de sécurité & compliance de Engage Me/);
  });

  /**
   * 🔴 UNE BOÎTE PAR SOUS-MENU, ET RÉCIPROQUEMENT. Retirer un sous-menu de la nav sans retirer sa boîte
   * (ou l'inverse) doit faire rougir ce cas : c'est le seul qui attrape « une boîte qui mène nulle part ».
   */
  test('🔴 chaque boite correspond a un sous-menu, et chaque sous-menu a une boite', async ({ page }) => {
    await monter(page);
    await page.goto('/securite');
    const boites = await page.getByTestId(/^securite-boite-/).all();
    const cles = await Promise.all(boites.map(async (b) => (await b.getAttribute('data-testid'))!.replace('securite-boite-', '')));
    expect(cles.length).toBeGreaterThan(0);
    for (const cle of cles) {
      // Le sous-menu de cette clé existe dans la barre, et il mène à la même adresse que la boîte.
      const boite = page.getByTestId(`securite-boite-${cle}`);
      const href = await boite.getAttribute('href');
      expect(href, `la boîte « ${cle} » ne mène nulle part`).toBeTruthy();
      await expect(page.locator(`a[href="${href}"]`)).toHaveCount(2); // la boîte + l'entrée de menu
    }
  });

  test('🔴 les deux journaux sont ICI, et ils repondent', async ({ page }) => {
    await monter(page);
    await page.goto('/securite/audit');
    await expect(page.getByTestId('audit-journal')).toBeVisible();
    await page.goto('/securite/erreurs');
    await expect(page.getByTestId('erreurs-livraison')).toBeVisible();
  });

  /**
   * ⚠️ ET ILS NE SONT PLUS DANS PARAMÈTRES. Sans ce cas, on aurait pu les COPIER au lieu de les déplacer,
   * et deux journaux côte à côte finissent par se contredire le jour où l'un filtre autrement que l'autre.
   */
  test('⚠️ ils ne sont plus dans Parametres, qui repond toujours', async ({ page }) => {
    await monter(page);
    await page.goto('/parametres');
    await expect(page.getByTestId('param-auto-retry-toggle')).toBeVisible();
    await expect(page.getByTestId('audit-journal')).toHaveCount(0);
    await expect(page.getByTestId('erreurs-livraison')).toHaveCount(0);
  });

  /**
   * 🔴 LA DATE MANQUANTE SE DIT, ELLE NE S'INVENTE PAS. Elle n'est enregistrée que depuis la migration
   * 0138 : afficher la derniere modification de la fiche a la place aurait ete plus joli et FAUX, ce qui
   * est le pire resultat possible sur un ecran de conformite.
   */
  test('🔴 le consentement liste les desabonnes, et dit quand la date manque', async ({ page }) => {
    await monter(page);
    await page.goto('/securite/consentement');
    await expect(page.getByTestId('securite-consentement')).toBeVisible();
    await expect(page.getByTestId('desabonne-ligne')).toHaveCount(2);
    await expect(page.getByTestId('desabonnes-compte')).toContainText('2');
    await expect(page.getByTestId('desabonne-date').nth(1)).toContainText(/date inconnue/i);
  });

  /**
   * 🔴 LA RÈGLE ÉLARGIE REMONTE, ELLE NE DÉSABONNE PAS. L'écran doit le DIRE : sans cette phrase, une ligne
   * dans cette section se lirait comme un désabonnement déjà appliqué.
   */
  test('🔴 les refus possibles remontent SANS avoir desabonne personne', async ({ page }) => {
    await monter(page);
    await page.goto('/securite/consentement');
    await expect(page.getByTestId('refus-possibles')).toContainText(/Personne n.a été désabonné/);
    await expect(page.getByTestId('refus-possible-ligne')).toHaveCount(1);
    await expect(page.getByTestId('refus-possible-ligne')).toContainText('arrêtez de me contacter');
  });

  /**
   * 🔴 CE QUI REND UN REFUS OPPOSABLE AILLEURS QUE CHEZ NOUS. Le cas vérifie que le choix PART vers le
   * serveur : un sélecteur qui change d'apparence sans rien envoyer donnerait à un client la certitude que
   * son CRM est prévenu, alors qu'il ne le serait jamais.
   */
  test('🔴 brancher un connecteur sur le consentement ENVOIE le choix', async ({ page }) => {
    const ecritures: Ecriture[] = [];
    await monter(page, { ecritures });
    await page.goto('/securite/consentement');
    await expect(page.getByTestId('poussee-optout')).toBeVisible();
    await page.getByTestId('poussee-optout-choix').selectOption('rq-1');
    await expect(page.getByTestId('poussee-optout-ok')).toBeVisible();
    expect(ecritures).toEqual([{ chemin: '/tenants/t-e2e/settings/poussee-optout', corps: { requestId: 'rq-1' } }]);

    // ⚠️ LE TÉMOIN DANS L'AUTRE SENS : débrancher doit envoyer `null`, pas une chaîne vide. Sans ce cas, un
    // « aucun » qui n'envoie rien laisserait le connecteur branché sans que l'écran le dise.
    await page.getByTestId('poussee-optout-choix').selectOption('');
    expect(ecritures[1]).toEqual({ chemin: '/tenants/t-e2e/settings/poussee-optout', corps: { requestId: null } });
  });

  /**
   * ⚠️ AUCUN CONNECTEUR DÉCLARÉ : on le DIT et on emmène là où on en déclare un. Un sélecteur vide se
   * lirait « ça ne marche pas », alors qu'il n'y a simplement rien à brancher pour l'instant.
   */
  test('⚠️ sans aucun appel declare, l ecran dit ou aller le declarer', async ({ page }) => {
    await monter(page, { requetes: [] });
    await page.goto('/securite/consentement');
    await expect(page.getByTestId('poussee-optout-vide')).toContainText(/Connecteurs API/);
    await expect(page.getByTestId('poussee-optout-choix')).toHaveCount(0);
  });

  /**
   * 🔴 UNE POLITIQUE POUR L'ESPACE, ET ELLE PART VERS LE SERVEUR. Un bouton radio qui change d'apparence
   * sans rien envoyer donnerait à un client la certitude d'avoir tranché une question légale qu'il n'aurait
   * pas tranchée.
   */
  test('🔴 le sous-menu IA regle la politique de l espace, et l ENVOIE', async ({ page }) => {
    const ecritures: Ecriture[] = [];
    await monter(page, { ecritures });
    await page.goto('/securite/ia');
    await expect(page.getByTestId('securite-ia')).toBeVisible();
    // ⚠️ Rien n'a ete regle : l'ecran doit le DIRE, au lieu de faire passer le defaut pour un choix.
    await expect(page.getByTestId('mention-ia-defaut')).toBeVisible();

    await page.getByTestId('mention-ia-jamais').locator('input').check();
    await expect(page.getByTestId('mention-ia-ok')).toBeVisible();
    expect(ecritures).toEqual([{ chemin: '/tenants/t-e2e/settings/mention-ia', corps: { frequence: 'jamais' } }]);
    // ...et la mention « defaut applique » disparait, parce que quelqu un a desormais choisi.
    await expect(page.getByTestId('mention-ia-defaut')).toHaveCount(0);
  });

  /**
   * 🔴 LES DEUX CHOSES QUE CET ECRAN DOIT DIRE ET QU'UN INTERRUPTEUR SEUL NE DIRAIT PAS : la PHRASE que
   * chaque agent prononce, et le fait que l'agent de Meta n'est PAS gouverne par ce reglage. Sans la
   * seconde, un client lirait « mes IA se declarent » et ce serait faux pour l une d elles.
   */
  test('🔴 il montre la phrase de chaque agent, et EXCLUT le Meta Business Agent', async ({ page }) => {
    await monter(page);
    await page.goto('/securite/ia');
    await expect(page.getByTestId('mention-ia-agent')).toHaveCount(1);
    await expect(page.getByTestId('mention-ia-agent')).toContainText('assistant automatique');
    await expect(page.getByTestId('mention-ia-mba')).toContainText(/Meta Business Agent/);
  });

  /**
   * ⚠️ LE REGLAGE A QUITTE LA FICHE D'AGENT, ET L'ECRAN LE DIT AU LIEU DE LE FAIRE DISPARAITRE. Un reglage
   * qui s'evapore se lit « la fonctionnalite a ete supprimee », et le client la cherche la ou elle n est
   * plus, ou pire, croit que ses agents n annoncent plus rien.
   */
  test('⚠️ la fiche d agent renvoie vers Securite > IA au lieu de porter le selecteur', async ({ page }) => {
    await monter(page);
    // ⚠️ PAS DE `if` DANS CE TEST : une condition autour d une assertion la rend facultative, donc le test
    // passerait aussi le jour ou le bloc disparaitrait pour de bon. On force l ecran a rendre la fiche.
    await page.goto('/agents?id=ag-1&tab=identite');
    await expect(page.getByTestId('agent-mention-frequence-renvoi')).toContainText(/Sécurité > IA/);
    // Et le selecteur d avant n est plus la : sans ce cas, on aurait pu AJOUTER le renvoi sans RETIRER le
    // reglage, donc laisser deux verites cote a cote, dont une qui n ecrit plus rien.
    await expect(page.getByTestId('agent-mention-frequence')).toHaveCount(0);
  });

  test('rien ne deborde en 13 pouces', async ({ page }) => {
    await monter(page);
    await page.setViewportSize(TREIZE_POUCES);
    await page.goto('/securite');
    await expect(page.getByTestId('securite-accueil')).toBeVisible();
    await pasDeDebordement(page);
  });
});
