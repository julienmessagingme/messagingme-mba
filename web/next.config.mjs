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
    ];
  },
};

export default nextConfig;
