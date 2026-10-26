import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const backend = process.env.BACKEND_URL || 'http://localhost:8095';

/**
 * L'ORIGINE DE L'API QUAND LE NAVIGATEUR L'APPELLE EN DIRECT, lue sur la MÊME variable que `BASE` (`lib/http.ts`) et
 * figée au même moment, le build. Sur Vercel, `NEXT_PUBLIC_API_URL` vaut `https://api.messagingme.app` : la console
 * appelle une AUTRE origine que la sienne, que `connect-src 'self'` ne couvre pas. Sans la variable (VPS), l'API passe
 * par le rewrite `/api/backend` de la même origine, et `'self'` suffit. Une valeur relative reste sur la même origine.
 */
const brute = process.env.NEXT_PUBLIC_API_URL ?? '';
const origineApi = /^https?:\/\//.test(brute) ? new URL(brute).origin : null;

/**
 * OÙ LES NAVIGATEURS ENVOIENT LEURS RAPPORTS DE VIOLATION : le collecteur de l'API (`POST /csp-rapports`), sur la même
 * base que `BASE` (`lib/http.ts`) : `https://api.messagingme.app/csp-rapports` sur Vercel, `/api/backend/csp-rapports`
 * sur le VPS. ⚠️ L'adresse doit être EXACTE : le navigateur l'envoie sans suivre de redirection, une barre de trop ou un
 * `http` perdraient tous les rapports sans bruit. `scripts/verifier-base-api.mjs` la vérifie sur le build de Vercel.
 */
const rapportsCsp = `${brute.replace(/\/+$/, '') || '/api/backend'}/csp-rapports`;

const nextConfig = {
  // Build autonome pour un conteneur léger (server.js + deps minimales).
  output: 'standalone',
  // web/ EST la racine de tracing (sinon Next détecte le package.json parent et niche la sortie
  // sous .next/standalone/web/). Ainsi server.js reste à .next/standalone/server.js.
  outputFileTracingRoot: dirname,
  // Proxy vers l'API Fastify : le navigateur appelle /api/backend/* (même origine, zéro CORS),
  // Next relaie vers le backend en forwardant l'en-tête Authorization.
  /**
   * Les en-tetes de securite de la console (plan RSSI du 2026-09-09, livres le 2026-09-10).
   *
   * 🔴 LA CSP EST EN REPORT-ONLY, ET ELLE DOIT LE RESTER JUSQU A OBSERVATION. La console charge le SDK Meta
   * (`connect.facebook.net`) et Google Sign-In (`accounts.google.com`), et Next injecte ses propres scripts
   * en ligne. Une CSP enforcante posee sans mesure casserait la connexion des clients, c est-a-dire la
   * porte d entree du produit. Report-Only pose la meme politique et se contente de la SIGNALER : rien ne
   * casse, et on apprend ce qui la violerait vraiment.
   *
   * ⚠️ POUR LA PASSER EN BLOCAGE, il faut quelques jours d observation des rapports (`report-uri`, lus dans
   * `csp_rapports`). Sans cette etape, on ne saurait pas ce qu on est en train d interdire. Le jour ou on
   * bascule, c est cette meme chaine qui devient `Content-Security-Policy`.
   *
   * ⚠️ `Strict-Transport-Security` n est PAS ici : Vercel le pose deja sur ce domaine (mesure le
   * 2026-09-10, `max-age=63072000`). Deux sources pour une meme valeur finissent par diverger.
   */
  async headers() {
    const csp = [
      "default-src 'self'",
      // Next injecte des scripts en ligne (hydratation, chargeur). `unsafe-inline` est ce qui rend cette
      // politique OBSERVABLE plutot que bruyante ; c est le premier relachement a retirer le jour ou on
      // passera aux nonces.
      "script-src 'self' 'unsafe-inline' https://connect.facebook.net https://accounts.google.com",
      // La feuille de style du bouton Google Sign-In, à l'adresse que Google documente pour une CSP. Vue dans un vrai
      // navigateur sur la page de connexion : les e2e simulent Google et ne la chargent jamais.
      "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
      "img-src 'self' data: blob: https:",
      // L'apercu d'une video de publicite lit le fichier choisi par une adresse locale `blob:`. Sans cette ligne,
      // `media-src` retombe sur `default-src 'self'`, qui ne couvre pas `blob:` : la future CSP bloquante
      // couperait l'apercu, et la politique actuelle le signalerait a chaque video choisie.
      "media-src 'self' blob:",
      // `connect-src` : l'API (son origine quand la console l'appelle en direct, cf. `origineApi`), puis
      // l'embarquement Meta et la connexion Google. 🔴 Sans l'origine de l'API, cette politique passée en blocage
      // couperait chaque appel de la console servie par Vercel. `e2e/aide/test.ts` fait échouer tout e2e qui la
      // viole, et la CI les joue dans les DEUX topologies.
      `connect-src 'self'${origineApi ? ` ${origineApi}` : ''} https://graph.facebook.com https://accounts.google.com`,
      "frame-src https://connect.facebook.net https://accounts.google.com https://business.facebook.com",
      "font-src 'self' data:",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      // `report-uri` et pas `report-to` : compris de tous les navigateurs, sans en-tête `Reporting-Endpoints` ni
      // requête préliminaire CORS. Les rapports se lisent dans `csp_rapports` (documentation.md, la CSP de la console).
      `report-uri ${rapportsCsp}`,
    ].join('; ');
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy-Report-Only', value: csp },
        // Ceux-la sont ENFORCANTS des maintenant : ils ne peuvent rien casser dans une application qui n est
        // jamais encadree, ne devine jamais un type MIME et n a besoin d aucune capacite materielle.
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
      ],
    }];
  },

  /**
   * LES ADRESSES HISTORIQUES DE LA CONSOLE, gardées pour les liens partagés, les signets et les specs qui les citent : un
   * 404 se lit comme une panne, une redirection emmène là où l'écran vit maintenant. Côté serveur (307), et non plus par
   * une page qui faisait `router.replace` : rien ne clignote, et le bouton « précédent » ne ramène pas sur une page qui
   * repart aussitôt. `/outils` : les outils de l'agent de Meta sont un onglet de ses paramètres (spec
   * 2026-09-21-outils-maison-mba, § 9.5). `/agents/credit` : le crédit IA paie les agents ET la traduction, c'est un
   * réglage de l'espace (2026-09-29). `/mba` : le guide qui vivait là est retiré (2026-09-29), le menu mène droit aux
   * paramètres. `/dashboard/erreurs` : le journal des erreurs a rejoint le centre de Sécurité (2026-09-17).
   */
  async redirects() {
    return [
      { source: '/outils', destination: '/mba/parametres?tab=outils', permanent: false },
      { source: '/agents/credit', destination: '/parametres/credit', permanent: false },
      { source: '/mba', destination: '/mba/parametres', permanent: false },
      { source: '/dashboard/erreurs', destination: '/securite/erreurs', permanent: false },
    ];
  },

  async rewrites() {
    return [
      { source: '/api/backend/:path*', destination: `${backend}/:path*` },
      // Redirection des liens tracés des templates. Chemin COURT et sans `/api` parce qu'il voyage dans un
      // message WhatsApp : c'est l'adresse qu'un destinataire voit s'ouvrir, et elle compte dans les 2000
      // caractères que Meta accepte pour une URL de bouton.
      //
      // ⚠️ Servi par le backend, qui répond une 302. NPM ne route que mba-web et l'API n'a aucun port hôte
      // publié : ce rewrite est le SEUL chemin qui les relie. Le modifier casse des liens DÉJÀ LIVRÉS dans
      // des messages, qu'on ne peut plus corriger.
      { source: '/r/:code', destination: `${backend}/r/:code` },
      // 🔴 LA FORME ATTRIBUÉE, ET IL EN FAUT DEUX. Un rewrite `/r/:code` ne capture QU'UN segment : sans
      // cette seconde ligne, `/r/<code>/<jeton>` n'atteint jamais le backend et Next rend une 404. Découvert
      // en production le 2026-09-02, sur un template déjà APPROUVÉ par Meta portant `/r/<code>/{{1}}` : le
      // lien aurait été mort pour tous ses destinataires au premier envoi. `tests/web-rewrites-liens.test.ts`
      // garde la parité entre les routes montées et les rewrites.
      { source: '/r/:code/:jeton', destination: `${backend}/r/:code/:jeton` },
      // Visuels des messages RCS. Chemin COURT et sans `/api` pour la même raison que `/r/` : c'est une
      // adresse que l'OPÉRATEUR TÉLÉCOM va chercher, et qui doit finir par `.jpg`/`.png`/`.gif` pour qu'il
      // accepte l'envoi. ⚠️ Servi par le backend, qui n'a aucun port hôte publié : ce rewrite est le SEUL
      // chemin qui les relie. Le modifier casse les visuels de messages DÉJÀ ENVOYÉS.
      { source: '/m/:fichier', destination: `${backend}/m/:fichier` },
      // Serveur MCP. Chemin COURT et sans `/api` parce que c'est l'adresse qu'un intégrateur tape dans sa
      // commande `claude mcp add --transport http mba https://mba.messagingme.app/mcp` : elle est destinée
      // à être lue et recopiée par un humain, pas à être construite par notre front.
      //
      // ⚠️ Servi par le backend, qui n'a aucun port hôte publié : ce rewrite est le SEUL chemin qui les
      // relie. Comme `/r/` et `/m/`, il est GELÉ AU BUILD de l'image web : toute modification de ce fichier
      // exige `up -d --build`, un simple `up -d` laisserait le proxy dans son état d'avant.
      { source: '/mcp', destination: `${backend}/mcp` },
    ];
  },
};

export default nextConfig;
