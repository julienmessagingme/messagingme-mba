import type { Pool } from 'pg';
import { DEFAULT_TIMEZONE } from '../settings/store.pg';
import { journaliser } from '../lib/journal';

/**
 * L'ALERTE DE CRÉDIT ÉPUISÉ (lot 5, spec `docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md`, § 7) :
 * un e-mail aux admins de l'espace, une fois par jour au plus, avec le lien de recharge. Les agents IA se taisent à
 * sec, et le client ne le verrait qu'en ouvrant l'Inbox.
 *
 * 🔴 LE « UNE PAR JOUR » SE TIENT EN BASE (`repondeur_alertes_credit`, migration 0209), PAS EN MÉMOIRE : l'API et les
 * workers sont plusieurs copies, et chaque message entrant d'un espace à sec passe par ici. Seule l'insertion qui a
 * PRIS la ligne du jour envoie ; les autres s'arrêtent sans rien demander. Le jour est celui du fuseau de l'espace,
 * celui que le client lit.
 *
 * Appelée par le démarreur du répondeur (`./demarrer.ts`, solde lu avant de démarrer) et par le tour d'un agent qui
 * sort faute de crédit (`src/agent/run-turn.ts`). Ne lève JAMAIS : une alerte qui tombe ne doit pas faire tomber le
 * passage à l'équipe qu'elle accompagne.
 */

export interface DepsAlerteCredit {
  /** Pose la ligne de ce jour pour l'espace. `true` seulement si cette insertion l'a créée. */
  marquerLeJour(tenantId: string, jour: string): Promise<boolean>;
  /** Le fuseau IANA de l'espace (`tenant_settings.timezone`, défaut du serveur). */
  fuseau(tenantId: string): Promise<string>;
  /** Les adresses des administrateurs actifs de l'espace. */
  admins(tenantId: string): Promise<string[]>;
  /**
   * Envoie un e-mail (Resend, le canal des e-mails transactionnels). `null` = Resend n'est pas configuré sur
   * l'instance : l'alerte est journalisée, rien ne part, et rien n'échoue.
   */
  envoyer: ((m: { to: string; subject: string; text: string; html: string }) => Promise<void>) | null;
  /** La page Crédit IA de la console, où l'admin recharge. */
  pageCredit: string;
  now?: () => Date;
}

export interface AlerteCredit {
  alerter(tenantId: string): Promise<void>;
}

/** Le jour civil `AAAA-MM-JJ` dans ce fuseau ; un fuseau illisible retombe sur celui du serveur. */
export function jourDans(fuseau: string, maintenant: Date): string {
  try {
    return maintenant.toLocaleDateString('en-CA', { timeZone: fuseau });
  } catch {
    return maintenant.toLocaleDateString('en-CA', { timeZone: DEFAULT_TIMEZONE });
  }
}

/** Le texte de l'e-mail, en clair et en HTML. Le lien est le seul élément variable : aucune donnée de contact. */
export function messageAlerte(pageCredit: string): { subject: string; text: string; html: string } {
  const subject = 'Crédit IA épuisé : vos agents IA ne répondent plus';
  const lignes = [
    'Bonjour,',
    'Le crédit IA de votre espace est épuisé. Vos agents IA, dont le répondeur automatique, ne répondent plus : les '
      + 'messages qu’ils auraient pris arrivent dans « À traiter » de l’Inbox, pour votre équipe.',
    `Rechargez le crédit pour qu’ils reprennent : ${pageCredit}`,
    'Cette alerte part une fois par jour au plus.',
  ];
  const html = lignes.slice(0, 2).map((l) => `<p>${l}</p>`).join('')
    + `<p><a href="${pageCredit}">Recharger le crédit IA</a></p><p>${lignes[3]}</p>`;
  return { subject, text: lignes.join('\n\n'), html };
}

export function creerAlerteCreditEpuise(deps: DepsAlerteCredit): AlerteCredit {
  return {
    async alerter(tenantId) {
      try {
        const jour = jourDans(await deps.fuseau(tenantId), deps.now ? deps.now() : new Date());
        if (!(await deps.marquerLeJour(tenantId, jour))) return;
        if (!deps.envoyer) {
          journaliser('warn', 'alerte_credit_sans_resend', { tenantId, jour });
          return;
        }
        const admins = await deps.admins(tenantId);
        if (admins.length === 0) {
          journaliser('warn', 'alerte_credit_sans_admin', { tenantId, jour });
          return;
        }
        const m = messageAlerte(deps.pageCredit);
        // Un envoi par admin, isolé : une adresse refusée ne prive pas les autres.
        for (const to of admins) {
          try {
            await deps.envoyer({ to, ...m });
          } catch (err) {
            journaliser('error', 'alerte_credit_non_envoyee', { err, tenantId, jour });
          }
        }
        journaliser('info', 'alerte_credit_envoyee', { tenantId, jour, admins: admins.length });
      } catch (err) {
        journaliser('error', 'alerte_credit_impossible', { err, tenantId });
      }
    },
  };
}

/** La mémoire de l'alerte et les admins, en base. 🔴 `tenant_id = $1` sur chaque requête. */
export class PgAlertesCreditStore {
  constructor(private readonly pool: Pool) {}

  async marquerLeJour(tenantId: string, jour: string): Promise<boolean> {
    const res = await this.pool.query(
      `insert into repondeur_alertes_credit (tenant_id, jour) values ($1, $2::date) on conflict do nothing`,
      [tenantId, jour],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async admins(tenantId: string): Promise<string[]> {
    const res = await this.pool.query<{ email: string }>(
      `select email from users where tenant_id = $1 and role = 'admin' and disabled_at is null order by created_at`,
      [tenantId],
    );
    return res.rows.map((r) => r.email);
  }
}
