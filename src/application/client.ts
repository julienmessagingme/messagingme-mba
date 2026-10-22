import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { signRequest } from '../lib/signature';
import { STATUTS_COMPTE, type StatutCompte } from './comptes';
import { PREFIXE } from './routes-internes';

/**
 * LE CLIENT DU SERVICE DE CONNEXIONS (plan 2026-10-22, tâche 3), pour l'API et le worker. Chaque appel est signé
 * (`APPLICATION_SERVICE_SECRET`) ; un refus du service ou une panne réseau rendent un résultat lisible, jamais une
 * exception : l'appelant dit au développeur ce qui se passe.
 */
export type RaisonClient = 'non_relie' | 'statut' | 'compte_inconnu' | 'refuse' | 'service_injoignable';
export type Resultat<T extends object = object> = ({ ok: true } & T) | { ok: false; raison: RaisonClient };

export interface ClientApplication {
  relier(compteId: string): Promise<Resultat>;
  qr(compteId: string): Promise<Resultat<{ qr: string | null; ouverte: boolean; statut: StatutCompte | null }>>;
  envoyer(compteId: string, destinataire: string, texte: string): Promise<Resultat<{ messageId: string }>>;
  sommeil(compteId: string): Promise<Resultat>;
  retirer(compteId: string): Promise<Resultat>;
}

export interface OptionsClient {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => number;
  delaiMs?: number;
}

const refusLu = z.object({ raison: z.enum(['non_relie', 'statut', 'compte_inconnu']) });
const qrLu = z.object({ qr: z.string().nullable(), ouverte: z.boolean(), statut: z.enum(STATUTS_COMPTE).nullable() });
const envoiLu = z.object({ messageId: z.string().min(1) });

export function creerClientApplication(o: OptionsClient): ClientApplication {
  const f = o.fetch ?? fetch;
  const now = o.now ?? (() => Date.now());

  async function appeler(methode: 'GET' | 'POST', chemin: string, corps?: unknown): Promise<{ ok: true; json: unknown } | { ok: false; raison: RaisonClient }> {
    const texte = methode === 'POST' ? JSON.stringify(corps ?? {}) : '';
    const signature = signRequest(o.secret, { ts: now(), nonce: randomBytes(8).toString('hex'), method: methode, path: chemin, body: texte });
    let r: Response;
    try {
      r = await f(new URL(chemin, o.url), {
        method: methode,
        headers: { 'x-mm-service-signature': signature, ...(methode === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(methode === 'POST' ? { body: texte } : {}),
        signal: AbortSignal.timeout(o.delaiMs ?? 15_000),
      });
    } catch {
      return { ok: false, raison: 'service_injoignable' };
    }
    let json: unknown = null;
    try {
      json = await r.json();
    } catch {
      json = null;
    }
    if (r.ok) return { ok: true, json };
    if (r.status === 409) {
      const lu = refusLu.safeParse(json);
      if (lu.success) return { ok: false, raison: lu.data.raison };
    }
    return { ok: false, raison: r.status >= 500 ? 'service_injoignable' : 'refuse' };
  }

  const simple = async (methode: 'POST', compteId: string, action: string): Promise<Resultat> => {
    const r = await appeler(methode, `${PREFIXE}/${encodeURIComponent(compteId)}/${action}`);
    return r.ok ? { ok: true } : r;
  };

  return {
    relier: (id) => simple('POST', id, 'relier'),
    sommeil: (id) => simple('POST', id, 'sommeil'),
    retirer: (id) => simple('POST', id, 'retirer'),
    async qr(id) {
      const r = await appeler('GET', `${PREFIXE}/${encodeURIComponent(id)}/qr`);
      if (!r.ok) return r;
      const lu = qrLu.safeParse(r.json);
      return lu.success ? { ok: true, ...lu.data } : { ok: false, raison: 'refuse' };
    },
    async envoyer(id, destinataire, texte) {
      const r = await appeler('POST', `${PREFIXE}/${encodeURIComponent(id)}/envoyer`, { destinataire, texte });
      if (!r.ok) return r;
      const lu = envoiLu.safeParse(r.json);
      return lu.success ? { ok: true, messageId: lu.data.messageId } : { ok: false, raison: 'refuse' };
    },
  };
}
