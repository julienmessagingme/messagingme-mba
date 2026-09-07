import { test, expect } from '@playwright/test';

/**
 * E2E Chaîne (Channels Me) : publier un post dont le bouton démarre un scénario.
 *
 * Ce que ces specs protègent, et qu'aucun test unitaire ne peut voir :
 *
 *  1. 🔴 LES CHEMINS RÉELLEMENT APPELÉS. `api-chaine.test.ts` vérifie ce que le module DEMANDE à `request` ;
 *     ici on vérifie ce qui sort vraiment du navigateur, préfixe du proxy compris. C'est la faute du lot
 *     précédent (`/connexion` au lieu de `/connection`), et elle n'était visible qu'à ce niveau.
 *  2. 🔴 UN BOUTON MORT DEVIENT VISIBLE. L'avertissement `automation_non_allumee` arrive avec un 201 : le
 *     post est parti, son bouton ne démarre rien. Jusqu'ici cela ne se voyait que dans les journaux du
 *     serveur. On vérifie que l'écran le dit ET propose la réparation.
 *  3. Trois états de connexion, pas deux : « rien de provisionné » et « enregistré mais fournisseur muet »
 *     n'appellent pas la même action.
 */

const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONNEXION = { orgId: 'org-1', channelId: 'chan-1', hasApiKey: true, hasSecret: true, verifiedAt: '2026-09-05T10:00:00.000Z' };
const CHAINE = { id: 'chan-1', name: 'Messaging Me', messages_count: 59 };
const WF = { id: 'wf1', name: 'Prise de RDV', nodeCount: 4 };

const LIEN = {
  id: 'lien-1', tenantId: 't-e2e', workflowId: 'wf1', startNodeId: null,
  token: 'cm-a7k2m9p3', phrase: 'Je veux en savoir plus', automationId: 'auto-1',
  maxParHeure: null, createdAt: '2026-09-05T10:00:00.000Z',
  // 🔴 LA PHRASE SEULE : c est ce que l API rend depuis le 2026-09-07. Une fixture qui garderait le jeton
  // resterait verte (le serveur est simule) tout en affirmant une forme que l API ne peut plus produire.
  // C est exactement ainsi qu une valeur inventee a franchi la CI ce mois-ci.
  texteRempli: 'Je veux en savoir plus',
  waMeUrl: 'https://wa.me/33525680250?text=Je%20veux%20en%20savoir%20plus',
  enabled: true,
};

/** Le décor commun : une chaîne branchée, un lien, un scénario en ligne. `sur` permet de surcharger. */
async function monter(
  page: import('@playwright/test').Page,
  sur: {
    distantConnexion?: string;
    liens?: unknown[];
    posts?: unknown[];
    distantPosts?: string;
    reponsePublication?: unknown;
    connexion?: unknown;
  } = {},
) {
  const appels: Array<{ methode: string; chemin: string; corps: unknown }> = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname.replace('/api/backend', '');
    const json = (b: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.startsWith('/tenants/')) {
      appels.push({
        methode: req.method(),
        chemin,
        corps: req.method() === 'GET' ? null : req.postDataJSON?.() ?? null,
      });
    }

    if (chemin.endsWith('/channels-me/connection') && req.method() === 'GET') {
      return json({
        connection: sur.connexion === undefined ? CONNEXION : sur.connexion,
        organisation: { id: 'org-1', name: 'Messaging Me', monthly_messages_count: 5, allowed_message_quota: 10000 },
        channels: sur.distantConnexion === 'injoignable' ? [] : [CHAINE],
        distant: sur.distantConnexion ?? 'ok',
      });
    }
    if (chemin.endsWith('/channels-me/links') && req.method() === 'GET') {
      return json({ links: sur.liens ?? [LIEN], phone: '33525680250' });
    }
    if (chemin.endsWith('/channels-me/posts') && req.method() === 'GET') {
      return json({ posts: sur.posts ?? [], distant: sur.distantPosts ?? 'ok' });
    }
    if (chemin.endsWith('/channels-me/posts') && req.method() === 'POST') {
      return json(sur.reponsePublication ?? { post: { cmMessageId: 'cm-9', linkId: 'lien-1' } }, 201);
    }
    if (chemin.endsWith('/rcs/media') && req.method() === 'POST') {
      const corps = (req.postDataJSON?.() ?? {}) as { dataUrl?: string; nom?: string };
      // 🔴 On verifie que le NAVIGATEUR a bien encode le fichier choisi. C'est la moitie de la chaine que ce
      // test protege ; l'autre moitie, la relecture de la SIGNATURE du fichier, est couverte cote serveur.
      expect(String(corps.dataUrl ?? '')).toMatch(/^data:image\/png;base64,/);
      return json({
        media: { id: 'm1', code: 'abcdefghjkmnpqrstvwxyz0123', mime: 'image/png', taille: 70, nom: corps.nom ?? null, createdAt: '' },
        url: 'https://mba.messagingme.app/m/abcdefghjkmnpqrstvwxyz0123.png',
      }, 201);
    }
    if (/\/channels-me\/links\/[^/]+\/enable$/.test(chemin)) return json({ ok: true });
    if (chemin.endsWith('/channels-me/activation-request')) return json({ ok: true });
    if (chemin.endsWith('/workflows')) return json({ workflows: [WF] });
    if (chemin.endsWith('/me')) return json({ email: SESSION.email, name: 'Jean Test', role: 'admin' });
    return json({});
  });
  return appels;
}

test.describe('Chaîne : la connexion', () => {
  test('🔴 tape les chemins ANGLAIS du serveur, jamais une traduction française', async ({ page }) => {
    const appels = await monter(page);
    await page.goto('/chaine');
    await expect(page.getByTestId('chaine-connexion')).toBeVisible();

    const chemins = appels.map((a) => a.chemin);
    expect(chemins).toContain('/tenants/t-e2e/channels-me/connection');
    expect(chemins).toContain('/tenants/t-e2e/channels-me/links');
    expect(chemins).toContain('/tenants/t-e2e/channels-me/posts');
    // La faute exacte du lot précédent, celle qu'aucun compilateur ne voit.
    for (const c of chemins) expect(c).not.toContain('connexion');
  });

  test('affiche la chaîne et ses chiffres', async ({ page }) => {
    await monter(page);
    await page.goto('/chaine');
    await expect(page.getByTestId('chaine-nom')).toHaveText('Messaging Me');
    await expect(page.getByTestId('chaine-mesure-publications')).toContainText('59');
    // Le quota MENSUEL vient de l organisation, pas de la chaine : c est la ou il est reellement mesure.
    await expect(page.getByTestId('chaine-mesure-quota')).toContainText('10');
    await expect(page.getByTestId('chaine-etat-distant')).toContainText('active');
  });

  test('🔴 fournisseur muet : la connexion reste visible et l’écran dit de ne RIEN ressaisir', async ({ page }) => {
    // Confondre « injoignable » et « non configurée » pousse le client à ressaisir des identifiants qui sont
    // bons, puis à conclure que le produit est cassé.
    await monter(page, { distantConnexion: 'injoignable' });
    await page.goto('/chaine');
    await expect(page.getByTestId('chaine-injoignable')).toBeVisible();
    await expect(page.getByTestId('chaine-injoignable')).toContainText('bien enregistrés');
    await expect(page.getByTestId('chaine-vide')).toHaveCount(0);
  });

  test('🔴 aucune chaîne mais des identifiants en main : l’état vide n’est PAS un cul-de-sac', async ({ page }) => {
    // La premiere version ne proposait QUE la demande d activation : un client qui a deja sa chaine voyait
    // un ecran lui demandant de reclamer ce qu il possedait, sans aucun champ ou le saisir. Le formulaire
    // n existait que DERRIERE une connexion enregistree, donc il fallait deja en avoir une pour en creer une.
    const appels = await monter(page, { connexion: null });
    await page.goto('/chaine');
    await expect(page.getByTestId('chaine-vide')).toBeVisible();

    await page.getByTestId('chaine-saisir-identifiants').click();
    await page.getByTestId('chaine-org').fill('org-1');
    await page.getByTestId('chaine-canal').fill('chan-1');
    await page.getByTestId('chaine-cle').fill('cle-de-test');
    await page.getByTestId('chaine-secret').fill('secret-de-test');
    await page.getByTestId('chaine-identifiants-enregistrer').click();

    await expect.poll(() => appels.filter((a) => a.methode === 'PUT').length).toBe(1);
    const mise = appels.find((a) => a.methode === 'PUT')!;
    expect(mise.chemin).toBe('/tenants/t-e2e/channels-me/connection');
    // Les QUATRE champs partent ensemble : la route est un remplacement complet, pas un patch.
    expect(mise.corps).toEqual({ orgId: 'org-1', channelId: 'chan-1', apiKey: 'cle-de-test', secret: 'secret-de-test' });
  });

  test('les deux champs secrets sont masqués à la saisie', async ({ page }) => {
    await monter(page, { connexion: null });
    await page.goto('/chaine');
    await page.getByTestId('chaine-saisir-identifiants').click();
    // Une cle d API saisie en clair a l ecran se lit par-dessus l epaule et part dans les captures.
    await expect(page.getByTestId('chaine-cle')).toHaveAttribute('type', 'password');
    await expect(page.getByTestId('chaine-secret')).toHaveAttribute('type', 'password');
  });

  test('aucune chaîne : l’état vide porte la demande d’activation, et rien d’autre ne se charge', async ({ page }) => {
    const appels = await monter(page, { connexion: null });
    await page.goto('/chaine');
    await expect(page.getByTestId('chaine-vide')).toBeVisible();

    await page.getByTestId('chaine-demande-message').fill('On voudrait une chaîne pour la rentrée.');
    await page.getByTestId('chaine-demande-envoyer').click();
    await expect(page.getByTestId('chaine-demande-envoyee')).toBeVisible();

    const demande = appels.find((a) => a.chemin.endsWith('/activation-request'));
    expect(demande?.corps).toEqual({ message: 'On voudrait une chaîne pour la rentrée.' });
    // Sans chaîne branchée, on n'interroge ni les liens ni les publications : ce serait un aller-retour
    // chez le fournisseur pour du vide.
    expect(appels.map((a) => a.chemin)).not.toContain('/tenants/t-e2e/channels-me/posts');
  });
});

test.describe('Chaîne : mettre en forme le message', () => {
  test('🔴 C1 : le bouton Gras entoure la SÉLECTION, et l aperçu le rend en gras', async ({ page }) => {
    // La logique est testée en unite (`lib/chaine-mise-en-forme.test.ts`). Ce qui se prouve ICI est le
    // geste : la barre agit sur ce qui est selectionne dans le champ, pas sur la fin du texte, et l apercu
    // MONTRE le style au lieu d afficher des etoiles. Sans ce second point, la fonctionnalite est un
    // mensonge : le client ecrit `*promo*` et voit `*promo*`.
    await monter(page);
    await page.goto('/chaine');
    const zone = page.getByTestId('chaine-texte');
    await zone.fill('Grosse promo cette semaine');
    // Selectionne « promo » (positions 7 a 12).
    await zone.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(7, 12));
    await page.getByTestId('chaine-format-gras').click();

    await expect(zone).toHaveValue('Grosse *promo* cette semaine');
    const apercu = page.getByTestId('chaine-apercu-texte');
    await expect(apercu.locator('strong')).toHaveText('promo');
    // 🔴 Les etoiles ne s affichent PAS : c est la difference entre montrer le gras et montrer le balisage.
    await expect(apercu).not.toContainText('*promo*');
  });

  test('🔴 le balisage part TEL QUEL au fournisseur : c est WhatsApp qui rend le gras', async ({ page }) => {
    // Garde contre un « nettoyage » futur. L apercu retranscrit le style pour que le client voie ce qu il
    // publie, mais le texte ENVOYE doit garder ses marqueurs : c est le client WhatsApp qui les interprete.
    // Les retirer a l envoi produirait un post sans aucune mise en forme, et l apercu aurait menti.
    const appels = await monter(page);
    await page.goto('/chaine');
    await page.getByTestId('chaine-texte').fill('Grosse *promo* cette semaine');
    await page.getByTestId('chaine-lien').selectOption('lien-1');
    await page.getByTestId('chaine-publier').click();

    await expect(page.getByTestId('chaine-publie')).toBeVisible();
    const publication = appels.find((a) => a.methode === 'POST' && a.chemin.endsWith('/channels-me/posts'));
    expect(publication?.corps).toEqual({ text: 'Grosse *promo* cette semaine', linkId: 'lien-1' });
  });

  test('🔴 C3 : un smiley s insere AU CURSEUR, pas a la fin', async ({ page }) => {
    await monter(page);
    await page.goto('/chaine');
    const zone = page.getByTestId('chaine-texte');
    await zone.fill('Bonjour tout le monde');
    await zone.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(7, 7));
    await page.getByTestId('chaine-emojis').click();
    // LE selecteur du produit, partage avec les composeurs de template : pas une troisieme grille.
    await page.getByTestId('selecteur-emojis').getByRole('button', { name: '🎉' }).click();
    await expect(zone).toHaveValue('Bonjour🎉 tout le monde');
  });
});

test.describe('Chaîne : l’image', () => {
  /**
   * 🔴 CE QUE CE TEST PROTÈGE, ET POURQUOI IL N'Y A PAS DE MULTIPART ICI. Julien voulait un bouton pour
   * téléverser une photo depuis son poste au lieu de coller une adresse. Le fournisseur accepte deux
   * formes : une adresse publique qu'il va CHERCHER (`media_url`), ou le fichier en multipart accompagné
   * d'un `media_checksum` dont sa spec ne nomme PAS l'algorithme, et qui obligerait à signer autre chose
   * que ce qu'on transmet. La première suffit, et l'hébergeur existe déjà : c'est celui qui sert les
   * visuels RCS aux opérateurs. Ce test épingle le chemin retenu, pour qu'on ne le remplace pas par un
   * multipart deviné.
   */
  test('🔴 D : téléverse une photo locale, et c’est l’ADRESSE hébergée qui part au fournisseur', async ({ page }) => {
    const appels = await monter(page);
    await page.goto('/chaine');
    await page.getByTestId('chaine-texte').fill('Notre nouvelle carte');

    // Un vrai PNG minimal (1x1 transparent), pas un fichier au hasard renomme.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    await page.getByTestId('chaine-image-file').setInputFiles({ name: 'carte.png', mimeType: 'image/png', buffer: png });

    const adresse = 'https://mba.messagingme.app/m/abcdefghjkmnpqrstvwxyz0123.png';
    // L'adresse se remplit toute seule : c'est exactement ce que le client ne veut pas avoir a fabriquer.
    await expect(page.getByTestId('chaine-image')).toHaveValue(adresse);
    // Elle est https et publique, donc le refus AVANT publication ne se declenche pas.
    await expect(page.getByTestId('chaine-image-refus')).toHaveCount(0);
    // ⚠️ Et AUCUN avertissement d'extension : cette regle est celle de l'operateur RCS, mesuree chez lui.
    // La spec de Channels Me ne nomme aucune extension, donc on n'invente pas la contrainte.
    await expect(page.getByTestId('chaine-image-warn')).toHaveCount(0);
    await expect(page.getByTestId('chaine-apercu-image')).toHaveAttribute('src', adresse);

    await page.getByTestId('chaine-lien').selectOption('lien-1');
    await page.getByTestId('chaine-publier').click();
    await expect(page.getByTestId('chaine-publie')).toBeVisible();

    const publication = appels.find((a) => a.methode === 'POST' && a.chemin.endsWith('/channels-me/posts'));
    expect(publication?.corps).toEqual({
      text: 'Notre nouvelle carte',
      linkId: 'lien-1',
      mediaUrl: adresse,
    });
  });

  test('🔴 D, preuve inverse : coller une adresse reste possible, et une adresse en http est toujours refusée', async ({ page }) => {
    // Sans ce sens-la, on aurait pu remplacer le champ par un bouton et casser le client qui heberge
    // deja ses visuels sur son propre CDN. Et la garde d'avant le lot doit tenir a l'identique.
    await monter(page);
    await page.goto('/chaine');
    await page.getByTestId('chaine-image').fill('http://exemple.fr/photo.jpg');
    await expect(page.getByTestId('chaine-image-refus')).toBeVisible();
    await page.getByTestId('chaine-image').fill('https://exemple.fr/photo.jpg');
    await expect(page.getByTestId('chaine-image-refus')).toHaveCount(0);
  });
});

test.describe('Chaîne : publier', () => {
  test('l’aperçu montre le bouton seulement quand un lien est rattaché', async ({ page }) => {
    await monter(page);
    await page.goto('/chaine');

    await page.getByTestId('chaine-texte').fill('Nouvelle collection disponible');
    // Sans lien : pas de bouton, et l'écran le dit plutôt que de laisser deviner.
    await expect(page.getByTestId('chaine-apercu-bouton')).toHaveCount(0);
    await expect(page.getByTestId('chaine-apercu-sans-bouton')).toBeVisible();

    await page.getByTestId('chaine-lien').selectOption('lien-1');
    await expect(page.getByTestId('chaine-apercu-bouton')).toHaveText('Discuter');
    // 🔴 L'adresse affichée est celle du SERVEUR, pas une recomposition : le jeton doit s'y retrouver tel quel.
    // L apercu montre le lien wa.me tel qu il partira. Le jeton n y est plus ; ce qui compte est que
    // l adresse soit celle du serveur, pas une recomposition du front.
    await expect(page.getByTestId('chaine-apercu-lien')).toContainText('wa.me/33525680250');
  });

  test('publie avec le lien, et le brouillon se vide', async ({ page }) => {
    const appels = await monter(page);
    await page.goto('/chaine');

    await page.getByTestId('chaine-texte').fill('Nouvelle collection disponible');
    await page.getByTestId('chaine-lien').selectOption('lien-1');
    await page.getByTestId('chaine-publier').click();

    await expect(page.getByTestId('chaine-publie')).toBeVisible();
    const publication = appels.find((a) => a.methode === 'POST' && a.chemin.endsWith('/channels-me/posts'));
    expect(publication?.corps).toEqual({ text: 'Nouvelle collection disponible', linkId: 'lien-1' });
    // 🔴 Le brouillon se vide : un second appui ne doit pas renvoyer le même message à toute l'audience.
    await expect(page.getByTestId('chaine-texte')).toHaveValue('');
  });

  test('une image en http est refusée AVANT l’envoi, et bloque le bouton', async ({ page }) => {
    await monter(page);
    await page.goto('/chaine');
    await page.getByTestId('chaine-texte').fill('Coucou');
    await page.getByTestId('chaine-image').fill('http://pas-https.test/a.jpg');
    await expect(page.getByTestId('chaine-image-refus')).toBeVisible();
    await expect(page.getByTestId('chaine-publier')).toBeDisabled();
  });

  test('🔴 allumage raté : l’écran le dit et offre la réparation, sans jamais inviter à republier', async ({ page }) => {
    const appels = await monter(page, {
      reponsePublication: { post: { cmMessageId: 'cm-9', linkId: 'lien-1' }, avertissements: ['automation_non_allumee'] },
      posts: [{
        id: 'p1', tenantId: 't-e2e', cmMessageId: 'cm-9', linkId: 'lien-1',
        createdAt: '2026-09-06T09:00:00.000Z', message: { id: 'cm-9', status: 'published', text: 'Coucou' },
      }],
      liens: [{ ...LIEN, enabled: false }],
    });
    await page.goto('/chaine');

    await page.getByTestId('chaine-texte').fill('Coucou');
    await page.getByTestId('chaine-lien').selectOption('lien-1');
    await page.getByTestId('chaine-publier').click();

    const avert = page.getByTestId('chaine-avertissement-automation_non_allumee');
    await expect(avert).toBeVisible();
    await expect(avert).toContainText('ne démarre rien');
    await expect(avert).not.toContainText(/republie[rz]|réessaie/i);

    // La publication porte la marque, et le bouton de réparation est à côté.
    await expect(page.getByTestId('chaine-publication-bouton-mort-p1')).toBeVisible();
    await page.getByTestId('chaine-publication-rallumer-p1').click();
    await expect.poll(() => appels.filter((a) => a.chemin.endsWith('/enable')).length).toBe(1);
    expect(appels.find((a) => a.chemin.endsWith('/enable'))!.chemin)
      .toBe('/tenants/t-e2e/channels-me/links/lien-1/enable');
  });
});

test.describe('Chaîne : les publications', () => {
  test('un statut inconnu s’affiche TEL QUEL, jamais rangé dans « Publiée »', async ({ page }) => {
    await monter(page, {
      posts: [{
        id: 'p2', tenantId: 't-e2e', cmMessageId: 'cm-10', linkId: null,
        createdAt: '2026-09-06T09:00:00.000Z', message: { id: 'cm-10', status: 'moderation_hold', text: 'Un post' },
      }],
    });
    await page.goto('/chaine');
    await expect(page.getByTestId('chaine-publication-etat-p2')).toHaveText('moderation_hold');
  });

  test('fournisseur muet : les publications restent affichées, sans statut', async ({ page }) => {
    await monter(page, {
      distantPosts: 'injoignable',
      posts: [{
        id: 'p3', tenantId: 't-e2e', cmMessageId: 'cm-11', linkId: null,
        createdAt: '2026-09-06T09:00:00.000Z', message: null,
      }],
    });
    await page.goto('/chaine');
    // Les masquer laisserait croire qu'il n'y a jamais rien eu.
    await expect(page.getByTestId('chaine-publication-p3')).toBeVisible();
    await expect(page.getByTestId('chaine-publication-etat-p3')).toHaveText('Non communiqué');
    await expect(page.getByTestId('chaine-publications-injoignable')).toBeVisible();
  });
});
