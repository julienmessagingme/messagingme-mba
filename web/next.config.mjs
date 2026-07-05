/** @type {import('next').NextConfig} */
const backend = process.env.BACKEND_URL || 'http://localhost:8095';

const nextConfig = {
  // Proxy vers l'API Fastify : le navigateur appelle /api/backend/* (même origine, zéro CORS),
  // Next relaie vers le backend en forwardant l'en-tête Authorization.
  async rewrites() {
    return [{ source: '/api/backend/:path*', destination: `${backend}/:path*` }];
  },
};

export default nextConfig;
