import { test, expect, type Page } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement, pasDeChevauchement } from './aide/largeur';
import { TRADUCTION_STORAGE_KEY } from '../lib/traduction-lecture';

/**
 * E2E : L'INTERRUPTEUR « TRADUIRE LES MESSAGES REÇUS », ET CE QUE L'ÉCRAN DEMANDE VRAIMENT.
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT PEUT VOIR ICI, C'EST L'URL DEMANDÉE. Un écran qui afficherait
 * l'interrupteur, le mémoriserait, et n'ajouterait jamais `?traduire=` à sa requête aurait l'air
 * parfaitement fonctionnel : les bulles resteraient simplement en espagnol, et on chercherait la panne
 * du côté du serveur. Ces tests lisent donc l'URL INTERCEPTÉE, pas seulement l'écran.
 *
 * 🔴 ET LE SECOND ANGLE EST LE RECHARGEMENT ENTIER. Allumer ne suffit pas à demander `?traduire=` : il
 * faut aussi lâcher le curseur du delta, sinon on ne demande que les messages arrivés depuis le dernier
 * tour et l'historique déjà affiché reste en VO pour toujours. C'est invisible sur un fil d'un message,
 * et c'est pour ça que le cas est testé sur l'absence d'`afterAt` plutôt que sur ce qui s'affiche.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONV = {
  id: 'c1', waId: '33600000001', profileName: 'Ana', lastPreview: 'Hola',
  lastMessageAt: '2026-09-13T10:00:00Z', controlOwner: 'app_human', unread: false, signaleeMain: false,
};

/**
 * Le fil en VO, tel que le serveur le rend SANS `traduire` : aucun `affiche`, aucun drapeau.
 *
 * ⚠️ LE DERNIER PORTE UN CURSEUR, et c'est indispensable : sans lui l'écran ne poserait jamais de point
 * de reprise, chaque tour redemanderait le fil entier, et le test « allumer recharge le fil ENTIER »
 * passerait sans rien prouver.
 */
const VO = [
  { id: 'm1', direction: 'in', type: 'text', body: 'Hola, tengo un problema', buttonPayload: null, createdAt: '2026-09-13T10:00:00Z', channel: 'whatsapp' },
  { id: 'm2', direction: 'in', type: 'text', body: 'Buenos dias', buttonPayload: null, createdAt: '2026-09-13T10:00:01Z', channel: 'whatsapp' },
  { id: 'm3', direction: 'in', type: 'text', body: 'Gracias', buttonPayload: null, createdAt: '2026-09-13T10:00:02Z', channel: 'whatsapp', curseur: '2026-09-13T10:00:02.123456Z' },
];

/**
 * Le même fil demandé traduit, avec LES TROIS ÉTATS que la route sait rendre.
 *
 * m1 traduit, m2 TENTÉ ET RATÉ (il porte sa marque), m3 JAMAIS TENTÉ parce qu'au-delà du plafond (il
 * n'en porte aucune). Confondre les deux derniers ferait annoncer une panne qui n'existe pas.
 */
const TRADUIT = [
  { ...VO[0], affiche: 'Bonjour, j’ai un problème', traduit: true, traductionEchouee: false },
  { ...VO[1], affiche: 'Buenos dias', traduit: false, traductionEchouee: true },
  { ...VO[2], affiche: 'Gracias', traduit: false, traductionEchouee: false },
];

interface Options {
  /** L'espace n'a pas de crédit de modèle : la route répond 200, en VO, avec son drapeau. */
  sansCredit?: boolean;
  /** Le réglage est DÉJÀ rangé dans ce navigateur (cas du retour sur l'écran). */
  dejaActif?: boolean;
}

async function monter(page: Page, opts: Options = {}) {
  /** Toutes les URL de fil demandées, dans l'ordre. C'est la seule preuve de ce que l'écran envoie. */
  const filsDemandes: string[] = [];
  const transcriptions: unknown[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  if (opts.dejaActif) {
    await page.addInitScript((k) => window.localStorage.setItem(k, '1'), TRADUCTION_STORAGE_KEY);
  }
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const sansQuery = url.split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/messages\/[^/]+\/transcrire$/.test(sansQuery)) {
      transcriptions.push(req.postDataJSON() ?? null);
      return json({ texte: 'Hola, tengo un problema', deja: false, langue: 'es', traduction: 'Bonjour, j’ai un problème' });
    }
    if (/\/conversations\/c1\/messages$/.test(sansQuery)) {
      filsDemandes.push(url);
      const params = new URL(url).searchParams;
      const cible = params.get('traduire');
      // Un DELTA ne rend rien de neuf : le fil est calme, et les tours de 4 s ne perturbent pas le test.
      if (params.get('afterAt')) {
        return json({
          waId: CONV.waId, windowOpen: true, lastInboundAt: '2026-09-13T10:00:02Z',
          controlOwner: 'app_human', langueContact: 'es', messages: [],
          // Le serveur rend ce champ dès que `traduire` est demandé, delta vide compris : il ne dépend
          // pas des messages, mais de la présence d'une clé de modèle sur l'espace.
          ...(cible ? { traductionIndisponible: opts.sansCredit === true } : {}),
        });
      }
      return json({
        waId: CONV.waId, windowOpen: true, lastInboundAt: '2026-09-13T10:00:02Z',
        controlOwner: 'app_human', langueContact: 'es',
        // Sans crédit, la route rend le fil EN VO avec son drapeau : ce n'est pas une panne.
        messages: cible && opts.sansCredit !== true ? TRADUIT : VO,
        ...(cible ? { traductionIndisponible: opts.sansCredit === true } : {}),
      });
    }
    if (/\/conversations\/counts/.test(url)) return json({ tout: 1, aTraiter: 1, signalees: 0, archivees: 0, nonAffectees: 1, parMembre: [] });
    if (/\/conversations(\?|$)/.test(url)) return json({ conversations: [CONV] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.includes('/users')) return json({ users: [] });
    if (url.endsWith('/me')) return json({ email: SESSION.email, name: 'Jean Test', role: 'admin' });
    return json({});
  });
  // Lien profond `?c=c1` : la conversation se rouvre toute seule APRÈS un `reload()`, ce qu'un clic ne
  // ferait pas. Sans lui, le test du réglage qui survit au rechargement n'aurait plus d'écran à lire.
  await page.goto('/inbox?c=c1');
  await expect(page.getByTestId('fil-messages')).toBeVisible();
  return {
    filsDemandes,
    transcriptions,
    interrupteur: page.getByRole('switch', { name: /Traduire les messages reçus/ }),
  };
}

test.describe('Inbox : traduire les messages reçus', () => {
  test('le toggle survit au rechargement', async ({ page }) => {
    const { interrupteur } = await monter(page);
    await expect(interrupteur).not.toBeChecked();
    await interrupteur.check();
    await page.reload();
    await expect(page.getByTestId('fil-messages')).toBeVisible();
    await expect(page.getByRole('switch', { name: /Traduire les messages reçus/ })).toBeChecked();
  });

  test('🔴 allumer demande bien `?traduire=`, et éteindre ne le demande plus', async ({ page }) => {
    // C'EST LA SEULE PREUVE QUE L'ÉCRAN ENVOIE CE QU'IL AFFICHE. Un interrupteur qui se souvient de son
    // état sans jamais l'ajouter à la requête aurait l'air de marcher, et les bulles resteraient en VO.
    //
    // ⚠️ AUCUNE ASSERTION SUR UN INDICE : le fil se rafraîchit tout seul toutes les 4 secondes, donc un
    // tour peut se glisser entre le clic et la requête qu'il déclenche. On raisonne sur la PREMIÈRE
    // requête traduite et sur la DERNIÈRE de toutes, deux repères que la gigue du minuteur ne bouge pas.
    const { filsDemandes, interrupteur } = await monter(page);
    expect(filsDemandes.every((u) => !u.includes('traduire=')), 'le fil était demandé traduit alors que le réglage est éteint').toBe(true);

    await interrupteur.check();
    await expect.poll(() => filsDemandes.some((u) => u.includes('traduire='))).toBe(true);
    expect(filsDemandes.find((u) => u.includes('traduire='))).toContain('traduire=fr');

    await interrupteur.uncheck();
    await expect.poll(() => filsDemandes[filsDemandes.length - 1]!.includes('traduire=')).toBe(false);
  });

  test('🔴 allumer ET éteindre rechargent le fil ENTIER, jamais le delta', async ({ page }) => {
    // Sans la remise à zéro du curseur, la requête ne demanderait que les messages arrivés DEPUIS le
    // dernier tour : l'historique déjà affiché resterait dans sa langue d'avant pour toujours, et
    // l'opérateur verrait un fil à moitié traduit sans comprendre pourquoi.
    const { filsDemandes, interrupteur } = await monter(page);
    // Le curseur est armé : un tour ordinaire demande bien un delta. Sans ce préalable, l'assertion
    // ci-dessous passerait toute seule et ne prouverait rien.
    await expect.poll(() => filsDemandes.some((u) => u.includes('afterAt=')), { timeout: 10_000 }).toBe(true);

    await interrupteur.check();
    await expect.poll(() => filsDemandes.some((u) => u.includes('traduire='))).toBe(true);
    // LA PREMIÈRE requête traduite est forcément celle du basculement : un tour parti avant lui porte
    // encore l'ancienne cible (donc aucune), et un tour qui tombe pendant elle passe son tour.
    const allumage = filsDemandes.find((u) => u.includes('traduire='))!;
    expect(allumage, 'le fil a été demandé en DELTA alors que tout l’historique doit être traduit').not.toContain('afterAt=');

    await interrupteur.uncheck();
    await expect.poll(() => filsDemandes[filsDemandes.length - 1]!.includes('traduire=')).toBe(false);
    // Et dans l'autre sens : la requête qui SUIT la dernière traduite est celle de l'extinction.
    let dernierTraduit = -1;
    filsDemandes.forEach((u, i) => { if (u.includes('traduire=')) dernierTraduit = i; });
    const extinction = filsDemandes[dernierTraduit + 1]!;
    expect(extinction, 'le fil est resté traduit à l’écran, faute d’avoir été redemandé en entier').not.toContain('afterAt=');
  });

  test('🔴 les bulles changent vraiment de langue, dans les deux sens', async ({ page }) => {
    // L'ajout au fil est DÉDOUBLONNÉ PAR IDENTIFIANT : les bulles reviennent avec les mêmes identifiants
    // et un autre texte, donc sans remplacement explicite elles resteraient telles quelles à l'écran.
    const { interrupteur } = await monter(page);
    const fil = page.getByTestId('fil-messages');
    await expect(fil).toContainText('Hola, tengo un problema');
    await interrupteur.check();
    await expect(fil).toContainText('Bonjour, j’ai un problème');
    await expect(fil).not.toContainText('Hola, tengo un problema');
    await interrupteur.uncheck();
    await expect(fil).toContainText('Hola, tengo un problema');
    await expect(fil).not.toContainText('Bonjour, j’ai un problème');
  });

  test('🔴 une traduction ratée porte sa marque, un message jamais tenté n’en porte aucune', async ({ page }) => {
    // LES DEUX DERNIERS ÉTATS NE SE CONFONDENT PAS. Au-delà du plafond de 40, rien n'a été tenté :
    // marquer ces messages comme des échecs ferait chercher une panne inexistante sur tout l'historique.
    const { interrupteur } = await monter(page);
    await interrupteur.check();
    await expect(page.getByTestId('bulle-traduite-m1')).toBeVisible();
    // m2 : tenté, pas revenu -> son texte d'ORIGINE, et il le dit.
    await expect(page.getByTestId('fil-messages')).toContainText('Buenos dias');
    await expect(page.getByTestId('bulle-traduction-echouee-m2')).toBeVisible();
    // m3 : jamais tenté -> son texte d'origine, et AUCUNE marque, ni d'échec ni de traduction.
    await expect(page.getByTestId('fil-messages')).toContainText('Gracias');
    await expect(page.getByTestId('bulle-traduction-echouee-m3')).toHaveCount(0);
    await expect(page.getByTestId('bulle-traduite-m3')).toHaveCount(0);
  });

  test('⚠️ sans crédit, le toggle le dit au lieu de rester muet', async ({ page }) => {
    // La traduction est payée par le crédit PRÉPAYÉ du client. Sans lui, le fil s'affiche en VO et la
    // route répond 200 : l'écran doit dire pourquoi, sinon on conclut à une panne du produit.
    const { interrupteur } = await monter(page, { sansCredit: true, dejaActif: true });
    await expect(interrupteur).toBeChecked();
    // ⚠️ Visé par son `data-testid` et non par `getByText(/crédit/i)` : la barre latérale porte déjà une
    // entrée de menu « Crédit », et le test aurait échoué sur deux correspondances au lieu de dire quoi
    // que ce soit sur ce bandeau.
    await expect(page.getByTestId('traduction-indisponible')).toBeVisible();
    await expect(page.getByTestId('traduction-indisponible')).toHaveText(/crédit/i);
    // L'INTERRUPTEUR RESTE VISIBLE : le cacher laisserait croire à une panne de l'écran lui-même.
    await expect(interrupteur).toBeVisible();
    await expect(page.getByTestId('fil-messages')).toContainText('Hola, tengo un problema');
  });

  test('le bandeau de crédit disparaît dès qu’on éteint le réglage', async ({ page }) => {
    // Il n'a de sens que tant qu'on demande une traduction : le laisser afficher sur un fil qu'on lit en
    // VO ferait signaler un manque qui n'empêche plus rien.
    const { interrupteur } = await monter(page, { sansCredit: true, dejaActif: true });
    await expect(page.getByTestId('traduction-indisponible')).toBeVisible();
    await interrupteur.uncheck();
    await expect(page.getByTestId('traduction-indisponible')).toHaveCount(0);
  });

  test('rien ne déborde ni ne se chevauche en 13 pouces', async ({ page }) => {
    await page.setViewportSize(TREIZE_POUCES);
    const { interrupteur } = await monter(page, { dejaActif: true });
    await expect(interrupteur).toBeChecked();
    await pasDeDebordement(page);
    // L'en-tête est déjà chargé : l'interrupteur doit y trouver sa place SANS recouvrir ses voisins ni
    // le fil, quitte à passer à la ligne.
    await pasDeChevauchement(page, ['toggle-traduction', 'inbox-rendre-la-main', 'fil-messages', 'zone-saisie']);
  });
});

/**
 * LE VOCAL, EN UN SEUL GESTE.
 *
 * 🔴 Le serveur sait transcrire PUIS traduire depuis la tâche 5 ; ce qui manquait, c'est que l'écran lui
 * dise la cible. Un paramètre oublié ici ne casse rien, ne lève rien, et rend une transcription en
 * espagnol au milieu d'un fil français : le genre de câblage muet que seul un test de bout en bout voit.
 */
test.describe('Inbox : le vocal suit le réglage', () => {
  const VOCAL = {
    id: 'm9', direction: 'in', type: 'audio', body: '[audio]', buttonPayload: null,
    createdAt: '2026-09-13T10:00:03Z', channel: 'whatsapp', aMedia: true,
    curseur: '2026-09-13T10:00:03.123456Z',
  };

  async function monterVocal(page: Page, actif: boolean) {
    const transcriptions: unknown[] = [];
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    if (actif) await page.addInitScript((k) => window.localStorage.setItem(k, '1'), TRADUCTION_STORAGE_KEY);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const sansQuery = url.split('?')[0]!;
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (/\/messages\/[^/]+\/transcrire$/.test(sansQuery)) {
        transcriptions.push(req.postDataJSON() ?? null);
        return json({ texte: 'Hola, tengo un problema', deja: false, langue: 'es', traduction: actif ? 'Bonjour, j’ai un problème' : null });
      }
      if (/\/conversations\/c1\/messages$/.test(sansQuery)) {
        const cible = new URL(url).searchParams.get('traduire');
        return json({
          waId: CONV.waId, windowOpen: true, lastInboundAt: '2026-09-13T10:00:03Z',
          controlOwner: 'app_human', langueContact: 'es',
          messages: [cible ? { ...VOCAL, affiche: '[audio]', traduit: false, traductionEchouee: false } : VOCAL],
          ...(cible ? { traductionIndisponible: false } : {}),
        });
      }
      if (/\/conversations\/counts/.test(url)) return json({ tout: 1, aTraiter: 1, signalees: 0, archivees: 0, nonAffectees: 1, parMembre: [] });
      if (/\/conversations(\?|$)/.test(url)) return json({ conversations: [CONV] });
      if (url.includes('/unread-count')) return json({ count: 0 });
      if (url.endsWith('/me')) return json({ email: SESSION.email, name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/inbox?c=c1');
    await expect(page.getByTestId('fil-messages')).toBeVisible();
    return { transcriptions };
  }

  test('🔴 réglage allumé : transcrire passe la cible, et le texte revient dans la langue du lecteur', async ({ page }) => {
    const { transcriptions } = await monterVocal(page, true);
    await page.getByTestId('vocal-transcrire-m9').click();
    await expect(page.getByTestId('vocal-texte-m9')).toContainText('Bonjour, j’ai un problème');
    // L'étiquette DIT que c'est notre lecture, pas ce qui a été dit.
    await expect(page.getByTestId('vocal-texte-m9')).toContainText(/transcription traduite/i);
    expect(transcriptions).toEqual([{ traduire: 'fr' }]);
  });

  test('réglage éteint : rien ne change, et surtout aucune cible n’est envoyée', async ({ page }) => {
    // Le rayon de souffle de ce lot doit être NUL quand le réglage est éteint : pas de cible, donc pas
    // de second appel de modèle payé par le client.
    const { transcriptions } = await monterVocal(page, false);
    await page.getByTestId('vocal-transcrire-m9').click();
    await expect(page.getByTestId('vocal-texte-m9')).toContainText('Hola, tengo un problema');
    expect(transcriptions).toEqual([null]);
  });
});
