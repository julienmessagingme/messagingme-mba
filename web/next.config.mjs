import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const backend = process.env.BACKEND_URL || 'http://localhost:8095';

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
   * ⚠️ POUR LA PASSER EN BLOCAGE, il faut d abord une destination de rapport (`report-to`) et quelques
   * jours d observation. Sans cette etape, on ne saurait pas ce qu on est en train d interdire. Le jour ou
   * on bascule, c est cette meme chaine qui devient `Content-Security-Policy`.
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
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      // `connect-src` : l API passe par le rewrite same-origin, donc `'self'` suffit pour elle. Les deux
      // origines externes sont celles de l embarquement Meta et de la connexion Google.
      "connect-src 'self' https://graph.facebook.com https://accounts.google.com",
      "frame-src https://connect.facebook.net https://accounts.google.com https://business.facebook.com",
      "font-src 'self' data:",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
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
