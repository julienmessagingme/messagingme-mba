import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RateLimiter } from '../auth/rate-limit';
import { texteDe } from '../lib/erreur';

/**
 * Le formulaire de contact de la vitrine (app.messagingme.fr, HTML statique, `site/contact/`). Même chemin
 * que le formulaire de support de la console : un e-mail envoyé par Resend à `SUPPORT_TO`.
 *
 * 🔴 UN FORMULAIRE HTML NATIF, PAS UN `fetch`. La page le poste en `application/x-www-form-urlencoded` et la route
 * répond par une redirection 303 vers la vitrine : aucune requête CORS (une navigation n'en déclenche pas), donc
 * aucune origine à ajouter à `CORS_ORIGINS`, et le formulaire marche sans JavaScript.
 */
export interface ContactVitrineDeps {
  /** false si l'envoi n'est pas configuré (clé Resend ou destinataire manquant) : même condition que le support. */
  enabled: boolean;
  /** Envoie le courriel. Lève sur erreur Resend : la route renvoie alors la personne sur la page, avec l'erreur. */
  envoyer(courriel: { sujet: string; texte: string; repondreA: string }): Promise<void>;
}

/**
 * La seule destination des redirections, écrite ici et jamais lue dans la requête : une adresse de retour prise
 * dans le formulaire ferait de cette route une redirection ouverte.
 */
export const VITRINE = 'https://app.messagingme.fr';

/** Un champ d'une ligne : les retours à la ligne et les blancs répétés deviennent une espace (il finit dans un sujet). */
const uneLigne = (s: string): string => s.replace(/\s+/g, ' ').trim();

const Demande = z.object({
  nom: z.string().transform(uneLigne).pipe(z.string().min(1).max(120)),
  societe: z.string().default('').transform(uneLigne).pipe(z.string().max(160)),
  email: z.string().transform(uneLigne).pipe(z.email().max(254)),
  telephone: z.string().default('').transform(uneLigne).pipe(z.string().max(40)),
  message: z.string().transform((s) => s.trim()).pipe(z.string().min(1).max(5000)),
  /** Le pot de miel : caché à l'écran, seul un robot le remplit. */
  site: z.string().default(''),
});
export type DemandeContact = z.infer<typeof Demande>;

/** Le courriel reçu par l'équipe. L'adresse est celle que le visiteur a TAPÉE : rien ne prouve qu'elle est à lui. */
export function courrielDeContact(d: DemandeContact): { sujet: string; texte: string; repondreA: string } {
  return {
    sujet: `[Vitrine Messaging Me] ${d.nom}${d.societe ? `, ${d.societe}` : ''}`,
    texte: [
      'Nouvelle demande de contact (vitrine app.messagingme.fr)',
      '',
      `Nom : ${d.nom}`,
      `Société : ${d.societe || 'non renseignée'}`,
      `E-mail : ${d.email} (saisi par le visiteur, non vérifié)`,
      `Téléphone : ${d.telephone || 'non renseigné'}`,
      '',
      d.message,
    ].join('\n'),
    repondreA: d.email,
  };
}

export function registerContactVitrine(app: FastifyInstance, deps: ContactVitrineDeps, vitrine: string = VITRINE): void {
  /**
   * UN plafond pour toute la plateforme, et c'est voulu : derrière Cloudflare puis NPM, sans `trustProxy`, `req.ip`
   * est le même pour tout le monde (`src/auth/routes.ts`, `rateKey`). Un robot qui l'épuise bloque les vrais
   * visiteurs dix minutes ; sans lui, il remplirait la boîte de l'équipe et le quota Resend. Le pot de miel et les
   * formulaires invalides n'y comptent pas : ils ne coûtent aucun envoi.
   */
  const plafond = new RateLimiter(10, 10 * 60_000);

  // Le lecteur de formulaire n'existe que dans cette portée : ailleurs, un corps urlencoded reste refusé (415).
  void app.register(async (portee) => {
    portee.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64_000 }, (_req, corps, fait) => {
      fait(null, Object.fromEntries(new URLSearchParams(String(corps))));
    });

    portee.post('/vitrine/contact', async (req, reply) => {
      const vers = (chemin: string) => reply.redirect(`${vitrine}${chemin}`, 303);

      const lu = Demande.safeParse(req.body);
      if (!lu.success) return vers('/contact/?erreur=champs#formulaire');
      // Au robot, la même réponse qu'à un humain : lui dire qu'on l'a repéré lui apprendrait à contourner.
      if (lu.data.site !== '') return vers('/contact/merci/');
      if (!plafond.take('vitrine')) return vers('/contact/?erreur=trop#formulaire');
      if (!deps.enabled) return vers('/contact/?erreur=envoi#formulaire');

      try {
        await deps.envoyer(courrielDeContact(lu.data));
        return vers('/contact/merci/');
      } catch (err) {
        // Journaliser avant de masquer, comme le support : une panne Resend et un bogue ne se lisent pas pareil.
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ lvl: 'error', msg: 'contact_vitrine_echec', err: texteDe(err) }));
        return vers('/contact/?erreur=envoi#formulaire');
      }
    });
  });
}
