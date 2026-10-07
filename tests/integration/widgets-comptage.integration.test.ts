import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, randomInt } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgChannelsMeLinkStore } from '../../src/channels-me/link-store.pg';
import { creerWidget, gestionDesWidgetsEnBase, modifierWidget } from '../../src/widgets/gestion';
import { etiquetteDuWidget } from '../../src/widgets/arrivee';
import { PgWidgetStore, type WidgetInput } from '../../src/widgets/store.pg';
import { newTrackingCode } from '../../src/ids/code';
import { offresToutOuvert } from '../gardes';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION (cf. CLAUDE.md du
// repo), et ce fichier crée puis supprime des espaces. La CI monte un Postgres jetable pour ça (job `integration`).
// `describe.skipIf(!url)` le rend inerte sans DATABASE_URL, mais ne protège pas contre un DATABASE_URL défini qui
// pointerait sur la production.
const url = process.env.DATABASE_URL ?? '';

/**
 * Le comptage des messages reçus qui contiennent déjà une phrase, contre un vrai Postgres (jaune 1 de la relecture du
 * lot 4, replié au lot 5 de docs/superpowers/plans/2026-10-02-widget-whatsapp.md).
 *
 * 🔴 POURQUOI EN INTÉGRATION. La règle vit dans la requête : l'étiquette du contact, le widget retrouvé par son code,
 * sa phrase ACTUELLE, et le filtre d'espace de la sous-requête. Un test à faux pool prouve la FORME de la requête,
 * seul celui-ci prouve son EFFET. Chaque cas compte DEUX fois : avec l'exclusion (la garde d'un widget) et sans elle
 * (la garde d'un lien de chaîne), qui doit rendre ce qu'elle rendait avant le lot 5.
 */
describe.skipIf(!url)('le comptage des messages reçus, hors arrivées par un widget (Postgres réel)', () => {
  let pool: Pool;
  let liens: PgChannelsMeLinkStore;
  let widgets: PgWidgetStore;
  const espaces: string[] = [];

  const espace = async (): Promise<string> => {
    const id = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-widgets-comptage') returning id`)).rows[0]!.id;
    espaces.push(id);
    return id;
  };

  /** Un contact, sa conversation, et les messages qu'il a ENVOYÉS. Rend son identifiant WhatsApp. */
  const contactQuiEcrit = async (tenant: string, etiquettes: string[], messages: string[]): Promise<string> => {
    const waId = `3361${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
    const contactId = (await pool.query<{ id: string }>(
      'insert into contacts (tenant_id, phone_e164, tags) values ($1, $2, $3::text[]) returning id',
      [tenant, `+${waId}`, etiquettes],
    )).rows[0]!.id;
    const conversation = (await pool.query<{ id: string }>(
      'insert into conversations (tenant_id, wa_id, contact_id) values ($1, $2, $3) returning id',
      [tenant, waId, contactId],
    )).rows[0]!.id;
    for (const body of messages) {
      await pool.query(
        `insert into conversation_messages (conversation_id, direction, type, body, channel)
         values ($1, 'in', 'text', $2, 'whatsapp')`,
        [conversation, body],
      );
    }
    return waId;
  };

  const brut = (phrase: string): WidgetInput => ({
    nom: 'itest-widgets-comptage', phrase, devenir: null, agentId: null, workflowId: null, couleur: '#25d366',
    position: 'bas_droite', libelle: null, avatarUrl: null, badge: true, actif: true, maxParHeure: null,
  });

  /** Le compte des deux gardes : celle d'un widget, puis celle d'un lien de chaîne. */
  const comptes = async (tenant: string, phrase: string) => ({
    widget: await liens.messagesContenantLaPhrase(tenant, phrase, { horsArriveesDeWidget: true }),
    lien: await liens.messagesContenantLaPhrase(tenant, phrase),
  });

  const phrase = (): string => `itest comptage ${randomUUID()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    liens = new PgChannelsMeLinkStore(pool);
    widgets = new PgWidgetStore(pool);
  });

  afterAll(async () => {
    for (const t of espaces) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  it('un message ORDINAIRE compte pour les deux gardes', async () => {
    const t = await espace();
    const p = phrase();
    await contactQuiEcrit(t, [], [`Bonjour, ${p} merci`]);
    expect(await comptes(t, p)).toEqual({ widget: 1, lien: 1 });
  });

  it('🔴 l’arrivée par un widget PRÉSENT n’est écartée que par la garde du widget', async () => {
    const t = await espace();
    const p = phrase();
    const w = await widgets.creer(t, brut(`${p} du site`));
    await contactQuiEcrit(t, [etiquetteDuWidget(w.code)], [`${p} du site`]);
    expect(await comptes(t, p)).toEqual({ widget: 0, lien: 1 });
  });

  it('🔴 le message ORDINAIRE d’un contact arrivé par un widget compte toujours', async () => {
    // La règle écarte l'ARRIVÉE, pas le contact : sans ça, un espace dont les visiteurs viennent de ses bulles aurait
    // une garde aveugle, et un widget « Bonjour » y capterait toute la conversation.
    const t = await espace();
    const p = phrase();
    const w = await widgets.creer(t, brut(`${p} du site`));
    await contactQuiEcrit(t, [etiquetteDuWidget(w.code)], [`${p} du site`, `et puis ${p} encore`]);
    expect(await comptes(t, p)).toEqual({ widget: 1, lien: 2 });
  });

  it('🔴 un widget SUPPRIMÉ a perdu sa phrase : les messages de ses contacts qui contiennent la phrase sont écartés', async () => {
    const t = await espace();
    const p = phrase();
    await contactQuiEcrit(t, [etiquetteDuWidget(newTrackingCode())], [p]);
    expect(await comptes(t, p)).toEqual({ widget: 0, lien: 1 });
  });

  it('🔴 une étiquette posée à la main qui commence par « widget- » n’écarte rien', async () => {
    const t = await espace();
    const p = phrase();
    await contactQuiEcrit(t, ['widget-salon'], [p]);
    expect(await comptes(t, p)).toEqual({ widget: 1, lien: 1 });
  });

  it('🔴 le widget d’un AUTRE espace n’écarte rien ici, et les messages d’un autre espace ne comptent pas', async () => {
    const t = await espace();
    const voisin = await espace();
    const p = phrase();
    // Le même code n'existe qu'une fois (index global) : c'est donc un widget du voisin dont ce contact porte
    // l'étiquette. Sans le filtre d'espace de la sous-requête, il passerait pour un widget présent.
    const chezLeVoisin = await widgets.creer(voisin, brut(`${p} ailleurs`));
    await contactQuiEcrit(t, [etiquetteDuWidget(chezLeVoisin.code)], [`${p} ici`]);
    await contactQuiEcrit(voisin, [], [p]);
    // Chez t, l'étiquette ne désigne aucun widget de l'espace : la règle du widget supprimé s'applique.
    expect(await comptes(t, p)).toEqual({ widget: 0, lien: 1 });
    expect(await comptes(voisin, p)).toEqual({ widget: 1, lien: 1 });
  });

  it('les messages qui portent un jeton de lien restent écartés par les deux gardes', async () => {
    const t = await espace();
    const p = phrase();
    await contactQuiEcrit(t, [], [`${p} (cm-k7m2p3q9)`]);
    expect(await comptes(t, p)).toEqual({ widget: 0, lien: 0 });
  });

  describe('🔴 les trois refus du lot 4 que ce comptage causait, par l’assemblage de production', () => {
    it('recréer un widget avec la phrase d’un widget supprimé', async () => {
      const t = await espace();
      const deps = gestionDesWidgetsEnBase(pool, offresToutOuvert);
      const p = phrase();
      const ancien = await widgets.creer(t, brut(p));
      await contactQuiEcrit(t, [etiquetteDuWidget(ancien.code)], [p]);
      expect(await widgets.supprimer(t, ancien.id)).toBe(true);
      expect((await creerWidget(deps, t, { nom: 'itest', phrase: p })).ok).toBe(true);
    });

    it('raccourcir une phrase qui a servi, et retirer sa ponctuation finale', async () => {
      const t = await espace();
      const deps = gestionDesWidgetsEnBase(pool, offresToutOuvert);
      const p = phrase();
      const w = await widgets.creer(t, brut(`${p} du site !`));
      await contactQuiEcrit(t, [etiquetteDuWidget(w.code)], [`${p} du site !`]);
      // Sans ponctuation : la phrase CHANGE pour `normalizeText`, donc le comptage s'applique.
      expect(await modifierWidget(deps, t, w.id, { phrase: `${p} du site` })).toMatchObject({ ok: true });
      // Et raccourcie : les arrivées contiennent toujours la phrase actuelle du widget.
      expect(await modifierWidget(deps, t, w.id, { phrase: p })).toMatchObject({ ok: true });
    });

    it('le pendant : une phrase présente dans la conversation ordinaire reste refusée (409)', async () => {
      const t = await espace();
      const deps = gestionDesWidgetsEnBase(pool, offresToutOuvert);
      const p = phrase();
      await contactQuiEcrit(t, [], [`Bonjour, ${p} svp`]);
      expect(await creerWidget(deps, t, { nom: 'itest', phrase: p })).toMatchObject({ ok: false, statut: 409 });
    });
  });
});
