'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, EnTetePage, Liste, Section, Tableau } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { OUTILS_MCP } from '@/lib/mcp-outils';
import { listApiKeys } from '@/lib/api';
import { BASE } from '@/lib/http';
import type { Session } from '@/lib/session';

/**
 * L'espace a-t-il une clé UTILISABLE pour MCP ?
 *
 * `null` = on ne sait pas encore, ou la liste n'a pas pu être lue. Les deux se traitent pareil, et c'est
 * volontaire : une vérification qui échoue ne doit surtout pas afficher « vous n'avez aucune clé », qui
 * enverrait quelqu'un en créer une seconde alors qu'il en a déjà une. Ne rien dire vaut mieux que dire faux.
 */
type EtatCle = null | 'aucune' | 'ok';

/**
 * L'écran d'où un intégrateur part : l'adresse du serveur MCP, la commande à copier, ce que chaque outil
 * fait, et ce que le serveur ne fait volontairement PAS.
 *
 * Le catalogue vient de `lib/mcp-outils.ts` et non d'un appel réseau : ce n'est pas un état du client,
 * c'est une documentation, et la lire exigerait déjà une clé, que cette page sert justement à créer. Un
 * test du serveur (`tests/mcp-doc-parite.test.ts`) garde cette liste alignée sur le catalogue réel, sinon
 * elle promettrait un jour un outil retiré, ou tairait un outil ajouté.
 *
 * 🔴 ELLE EST PUBLIQUE (décision de Julien du 2026-09-25), comme la documentation de l'API, et elle en prend le
 * cadre (`CadreDoc`, refonte du 2026-09-25) : qui peut ouvrir cet écran de la console l'a dans la console, tout
 * autre visiteur la lit dans `CadrePublic`. Sans session, la vérification des clés ne tourne pas : elle lit une
 * donnée d'espace, et il n'y a pas d'espace. Son adresse est publiée sur la vitrine : elle ne bouge pas.
 */
export default function McpPage() {
  return <CadreDoc page="mcp">{(session) => <McpInner session={session} />}</CadreDoc>;
}

function McpInner({ session }: { session: Session | null }) {
  const t = useT();
  const [etatCle, setEtatCle] = useState<EtatCle>(null);
  const tenantId = session?.tenantId;

  // La commande affichée ne peut pas marcher sans une clé portant un droit `mcp:*`. La copier puis se
  // heurter à un 401 est un aller-retour de support garanti, alors que la réponse tient en une phrase.
  // Sans espace (lecture publique), on se tait : cf. EtatCle.
  useEffect(() => {
    if (!tenantId) return;
    let vivant = true;
    listApiKeys(tenantId)
      .then(({ keys }) => {
        if (!vivant) return;
        // Une clé RÉVOQUÉE reste dans la liste : elle ne compte pas. Sans ce filtre, l'avertissement se
        // tairait pour un espace dont la seule clé MCP vient justement d'être coupée.
        const utilisable = keys.some((k) => k.revokedAt === null && k.scopes.some((s) => s.startsWith('mcp:')));
        setEtatCle(utilisable ? 'ok' : 'aucune');
      })
      .catch(() => { /* on ne sait pas : on se tait, cf. EtatCle */ });
    return () => { vivant = false; };
  }, [tenantId]);
  // 🔴 L'ADRESSE EST CELLE DE L'API PUBLIQUE (`BASE`, la même source que la documentation de l'API), parce
  // que c'est l'API qui sert `/mcp`, pas la console. Elle suivait le domaine de la console : sur la console
  // hébergée chez Vercel, `/mcp` rend 404 (mesuré le 2026-09-25, quand `api.` et `mba.` rendent 401), donc
  // la commande copiée depuis `engageme.` était morte. Repli sur le domaine de la page quand `BASE` est
  // relative : l'ancienne console du VPS, dont le proxy sert `/mcp`, et le serveur local des tests.
  const origine = BASE.startsWith('http') ? BASE : typeof window !== 'undefined' ? window.location.origin : 'https://mba.messagingme.app';
  const commande = `claude mcp add --transport http mba ${origine}/mcp --header "Authorization: Bearer VOTRE_CLE"`;

  return (
    <>
      <EnTetePage page="mcp">
        <p>
          {t(
            'Brancher un assistant (Claude, ou tout client compatible MCP) sur l’espace, sans intégration à développer.',
            'Connect an assistant (Claude, or any MCP-compatible client) to the workspace, with no integration to build.',
          )}
        </p>
      </EnTetePage>

      <Section titre={t('Adresse', 'Endpoint')}>
        <Bloc legende={t('Adresse', 'Endpoint')} testid="mcp-adresse">{`${origine}/mcp`}</Bloc>
        <Bloc legende={t('Commande à copier', 'Command to copy')} testidCopier="mcp-copier">{commande}</Bloc>
        <p className="text-sm text-ink-500">
          {t('Remplacer VOTRE_CLE par une clé d’API avec un droit MCP.', 'Replace VOTRE_CLE with an API key holding an MCP scope.')}{' '}
          <Link href="/developers/keys" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">
            {t('Créer une clé', 'Create a key')}
          </Link>
        </p>

        {/* L'avertissement ne s'affiche QUE sur une certitude (`aucune`). Tant qu'on ne sait pas, ou si la
            liste n'a pas pu être lue, on se tait : annoncer « aucune clé » à quelqu'un qui en a une l'enverrait
            en créer une seconde, et ce serait notre faute. */}
        {etatCle === 'aucune' && (
          <div data-testid="mcp-sans-cle" className="rounded-controle border border-alerte-300 bg-alerte-50 px-3 py-2 text-sm text-alerte-900">
            {t(
              'Cet espace n’a aucune clé d’API avec un droit MCP : la commande ci-dessus sera refusée telle quelle.',
              'This workspace has no API key with an MCP scope: the command above will be rejected as is.',
            )}{' '}
            <Link href="/developers/keys" className="font-semibold underline underline-offset-2">
              {t('Créer une clé avec « MCP : lire »', 'Create a key with "MCP: read"')}
            </Link>
          </div>
        )}
      </Section>

      <Section titre={t('Ce que l’assistant peut faire', 'What the assistant can do')}>
        <p>{t('Une clé en lecture seule ne voit pas les outils qui écrivent.', 'A read-only key does not see the tools that write.')}</p>
        {/* 🔴 Les outils de l'agent IA et du crédit agissent au nom d'une personne (lot 8a) : une clé d'API ne les voit
            pas, même avec le droit d'écrire. Le dire évite qu'un intégrateur cherche un outil que sa clé ne listera jamais. */}
        <p>
          {t(
            'Les outils marqués « connexion OAuth requise » agissent au nom d’une personne : une clé d’API ne les voit pas. Ils s’ouvrent quand Claude se connecte à l’espace avec l’accord d’un administrateur, qui signe ce qu’ils font.',
            'Tools marked "OAuth connection required" act on behalf of a person: an API key does not see them. They open when Claude connects to the workspace with an administrator’s consent, who signs what they do.',
          )}
        </p>
        {/* Les noms d'outils, en police fixe, ne se coupent pas : sur mobile, le tableau défile dans son cadre
            plutôt que de faire déborder la page entière (vu par l'e2e de la CI, 16 px). */}
        <Tableau
          entetes={[t('Outil', 'Tool'), t('Droit', 'Scope'), t('Ce qu’il fait', 'What it does')]}
          lignes={OUTILS_MCP.map((o) => ({
            cle: o.nom,
            cellules: [
              <span key="n" className="whitespace-nowrap font-mono text-ink-900">{o.nom}</span>,
              <span key="s" className="flex flex-col items-start gap-1">
                <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${o.scope === 'mcp:write' ? 'bg-brand-50 text-brand-700' : 'bg-ink-100 text-ink-500'}`}>{o.scope}</span>
                {o.oauth && <span className="whitespace-nowrap text-xs text-ink-500">{t('connexion OAuth requise', 'OAuth connection required')}</span>}
              </span>,
              t(...o.quoi),
            ],
          }))}
        />
      </Section>

      <Section titre={t('Ce qu’il ne fait pas', 'What it does not do')}>
        <Liste>
          <li>
            <strong className="text-ink-900">{t('Pas de campagne.', 'No campaigns.')}</strong>{' '}
            {t('Il envoie un modèle à une personne à la fois, connecté en votre nom ; il ne lance pas d’envoi de masse.', 'It sends a template to one person at a time, signed in as you; it does not launch a mass send.')}
          </li>
          <li>
            <strong className="text-ink-900">{t('Hors de la fenêtre de 24 h, seul un modèle approuvé part.', 'Outside the 24 h window, only an approved template goes out.')}</strong>{' '}
            {t('Un message libre est refusé, avec la raison ; un modèle approuvé part par send_template_to_contact.', 'A free-form message is refused, with the reason; an approved template goes out through send_template_to_contact.')}
          </li>
          <li>
            <strong className="text-ink-900">{t('Numéro WhatsApp délié, rien ne part.', 'WhatsApp number unlinked, nothing is sent.')}</strong>{' '}
            {t('L’outil refuse, avec la raison, jusqu’à ce qu’un administrateur relie le numéro depuis l’Accueil.', 'The tool refuses, with the reason, until an admin relinks the number from the Home page.')}
          </li>
          <li>
            <strong className="text-ink-900">{t('Les automations ne se déclenchent pas.', 'Automations are not triggered.')}</strong>{' '}
            {t('Un tag posé par l’assistant classe le contact, sans réveiller les automations qui écoutent ce tag.', 'A tag set by the assistant classifies the contact, without waking the automations listening for that tag.')}
          </li>
          <li>
            <strong className="text-ink-900">{t('Activer un agent IA ne le fait pas répondre.', 'Activating an AI agent does not make it answer.')}</strong>{' '}
            {t('Créé et activé par l’assistant, il parle aux clients dans un scénario publié qui le contient, ou une fois choisi pour répondre au client (set_default_responder, mode « agent ») : il répond alors à tout message que personne ne tient, et l’agent de Meta, s’il est allumé, reste en veille.', 'Created and activated by the assistant, it talks to customers inside a published scenario that contains it, or once chosen to answer the customer (set_default_responder, “agent” mode): it then answers every message nobody handles, and Meta’s agent, if on, stays on standby.')}
          </li>
          <li>
            <strong className="text-ink-900">{t('L’accès passe par une clé ou par une connexion OAuth.', 'Access goes through a key or an OAuth connection.')}</strong>{' '}
            {t('L’une comme l’autre porte l’espace et les droits. Couper un assistant : révoquer sa clé ou son autorisation dans « Clés d’API ».', 'Either one carries the workspace and the scopes. To cut an assistant off: revoke its key or its authorization under "API keys".')}
          </li>
        </Liste>
      </Section>
    </>
  );
}
