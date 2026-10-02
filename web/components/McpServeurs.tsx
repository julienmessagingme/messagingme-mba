'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import { dateHeure } from '@/lib/day';
import { cardCls, inputCls } from '@/lib/ui';
import { McpOutilReglage } from '@/components/McpOutilReglage';
import {
  apercuMcp, creerServeurMcp, importerMcp, listerOutilsMcp, listerServeursMcp,
  supprimerServeurMcp,
  type AuthMcp, type ChangementMcp, type OutilMcp, type ServeurMcp,
} from '@/lib/api-mcp-connecteurs';
import { Bouton } from '@/components/Bouton';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { Icone } from '@/components/Icone';

/**
 * Les serveurs MCP de l'espace, et ce qu'on a importé de chacun.
 *
 * 🔴 L'APERÇU AVANT L'IMPORT, ET IL N'ÉCRIT RIEN. Un rafraîchissement peut faire TOMBER des consentements
 * et marquer des outils indisponibles : écraser n'est acceptable que si l'on montre quoi avant de le faire.
 * C'est le même dispositif que la publication chez Meta, pour la même raison.
 *
 * 🔴 CES OUTILS VONT AUSSI À L'AGENT DE META depuis le 2026-10-02, et l'écran dit OÙ on les lui donne. Notre relais
 * les appelle pour Meta (`src/http/mba-relais.ts`) : Meta ne parle qu'à nous, en HTTP, et les paramètres réglés ici
 * (fiche du contact, champ, constante) sont posés par le relais, jamais lus dans ce que l'agent envoie. La phrase
 * précédente disait « l'agent de Meta ne les reçoit pas encore », vraie jusqu'à ce jour.
 */
export function McpServeurs({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  const t = useT();
  const { locale } = useLocale();
  const [serveurs, setServeurs] = useState<ServeurMcp[] | null>(null);
  const [outils, setOutils] = useState<Record<string, OutilMcp[]>>({});
  const [champs, setChamps] = useState<{ champs: string[]; champsContact: string[] }>({ champs: [], champsContact: [] });
  const [plan, setPlan] = useState<{ sourceId: string; plan: ChangementMcp[]; tronque: boolean } | null>(null);
  /** La dernière connexion réussie de cette visite, et si le catalogue était tronqué. */
  const [connexion, setConnexion] = useState<{ sourceId: string; tronque: boolean } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [neuf, setNeuf] = useState<{ label: string; baseUrl: string; authKind: AuthMcp; authSecret: string; authHeaderName: string } | null>(null);

  useEffect(() => {
    let vivant = true;
    listerServeursMcp(tenantId)
      .then((r) => { if (vivant) setServeurs(r.serveurs); })
      .catch(() => { if (vivant) setServeurs([]); });
    return () => { vivant = false; };
  }, [tenantId]);

  const chargerOutils = useCallback(async (sourceId: string) => {
    try {
      const r = await listerOutilsMcp(tenantId, sourceId);
      setOutils((v) => ({ ...v, [sourceId]: r.outils }));
      setChamps({ champs: r.champs, champsContact: r.champsContact });
    } catch {
      // 🔴 Une lecture ratée n'est pas une liste VIDE : « Aucun outil : cliquez sur Connecter » mentirait sur un serveur
      // qui en a. On garde ce qu'on avait, et sans rien de lu, la liste ne s'affiche pas (relecture du 2026-10-02).
    }
  }, [tenantId]);

  /**
   * 🔴 LES OUTILS DE CHAQUE SERVEUR SE LISENT D'OFFICE (Julien, 2026-10-02 : « il faut qu'on voie ici la liste des
   * outils qui ont été importés »). Ils étaient repliés derrière un bouton « Les outils importés », et un serveur
   * importé ressemblait à un serveur vide. Une lecture par serveur, à chaque nouvelle liste de serveurs.
   */
  useEffect(() => {
    for (const s of serveurs ?? []) void chargerOutils(s.id);
  }, [serveurs, chargerOutils]);

  /**
   * 🔴 « CONNECTER », UN SEUL GESTE (Julien, 2026-10-02 : « quand tu connectes, je veux la liste des outils juste en
   * dessous »). Il se connecte et lit le catalogue (l'aperçu, qui marque aussi la réponse du serveur), puis importe
   * aussitôt : les outils apparaissent sous la carte. Il remplace « Éprouver la connexion », « Voir ce qui va
   * changer » et « Appliquer », trois boutons pour un geste que personne ne comprenait.
   * Une seule exception, qui reste une confirmation : reconnecter ferait PERDRE un outil à un agent (son schéma a
   * changé, ou il a disparu du serveur, alors qu'un agent l'a). Écraser sans le dire retirerait une capacité en
   * silence. ⚠️ L'import recalcule le plan : un serveur qui change entre les deux appels, à la seconde près, passe
   * sans confirmation. Résidu assumé.
   */
  async function connecter(sourceId: string): Promise<void> {
    setPlan(null);
    setConnexion(null);
    try {
      const apercu = await apercuMcp(tenantId, sourceId);
      if (apercu.plan.some((c) => 'consentementsTombes' in c && c.consentementsTombes > 0)) {
        setPlan({ sourceId, ...apercu });
        return;
      }
      await importerMcp(tenantId, sourceId);
      setConnexion({ sourceId, tronque: apercu.tronque });
    } finally {
      // Relue dans tous les cas : un échec de connexion se lit aussi sur la carte (« Dernière erreur »).
      await listerServeursMcp(tenantId).then((r) => setServeurs(r.serveurs)).catch(() => {});
      await chargerOutils(sourceId);
    }
  }

  async function agir(travail: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setErreur(null);
    try { await travail(); } catch (e) {
      // Le message du SERVEUR, pas un message maison : il dit précisément ce qui bloque (transport non pris
      // en charge, jeton refusé, serveur injoignable), et le remplacer renverrait le client chercher
      // lui-même ce que le serveur savait déjà.
      setErreur(e instanceof Error ? e.message : t('L’opération a échoué.', 'The operation failed.'));
    } finally { setBusy(false); }
  }

  const LIBELLE: Record<ChangementMcp['type'], string> = {
    nouveau: t('nouvel outil', 'new tool'),
    inchange: t('inchangé', 'unchanged'),
    schema_change: t('schéma changé, autorisation à redonner', 'schema changed, needs re-authorising'),
    disparu: t('disparu du serveur', 'gone from the server'),
  };

  if (serveurs === null) return null;

  return (
    <section className="space-y-4" data-testid="mcp-serveurs">
      <header>
        <TitrePage>{t('Connecteurs MCP', 'MCP connectors')}</TitrePage>
        <IntroPage>
          {t('Déclaré une fois ici, un serveur voit ses outils proposés à chaque agent dans son onglet Outils.',
            'Declared once here, a server has its tools offered to each agent in its Tools tab.')}
        </IntroPage>
        {/* ⚠️ ON LE DIT, ON NE GRISE PAS : une case désactivée sans explication enverrait le client ouvrir
            un ticket. Et on dit que la limite est LA NÔTRE, parce qu'elle l'est. */}
        <p className="mt-2 text-xs text-ink-500" data-testid="mcp-note-mba">
          {t('Ces outils servent vos agents IA, et l’agent de Meta : on les lui donne dans AI Agent > MBA, onglet Outils.',
            'These tools serve your AI agents, and Meta’s agent: give them to it in AI Agent > MBA, Tools tab.')}
        </p>
      </header>

      {erreur && <p className="text-xs text-danger" data-testid="mcp-erreur">{erreur}</p>}

      {isAdmin && (
        <div className={cardCls} data-testid="mcp-declarer">
          {neuf === null ? (
            <button type="button" className="inline-flex items-center gap-1 text-sm text-brand-700 underline hover:text-brand-800" data-testid="mcp-declarer-ouvrir"
              onClick={() => setNeuf({ label: '', baseUrl: '', authKind: 'bearer', authSecret: '', authHeaderName: '' })}>
              <Icone nom="ajouter" />{t('Déclarer un serveur MCP', 'Declare an MCP server')}
            </button>
          ) : (
            <div className="space-y-2">
              <input className={inputCls} value={neuf.label} data-testid="mcp-neuf-label"
                placeholder={t('Nom (ex. Notion)', 'Name (e.g. Notion)')}
                onChange={(e) => setNeuf({ ...neuf, label: e.target.value })} />
              {/* ⚠️ L'ADRESSE DU POINT MCP, PAS UNE RACINE. Un serveur MCP a UNE adresse unique, là où un
                  connecteur API a une base sous laquelle on compose des chemins. Le dire ici évite de
                  coller l'adresse d'une API REST et de se demander pourquoi rien ne répond. */}
              <input className={inputCls} value={neuf.baseUrl} data-testid="mcp-neuf-url"
                placeholder={t('Adresse du point MCP (https://…/mcp)', 'MCP endpoint address (https://…/mcp)')}
                onChange={(e) => setNeuf({ ...neuf, baseUrl: e.target.value })} />
              <select className={inputCls} value={neuf.authKind} data-testid="mcp-neuf-auth"
                onChange={(e) => setNeuf({ ...neuf, authKind: e.target.value as AuthMcp })}>
                <option value="bearer">{t('jeton (Bearer)', 'token (Bearer)')}</option>
                <option value="header">{t('jeton dans un en-tête nommé', 'token in a named header')}</option>
                <option value="none">{t('aucune authentification', 'no authentication')}</option>
              </select>
              {neuf.authKind === 'header' && (
                <input className={inputCls} value={neuf.authHeaderName} data-testid="mcp-neuf-entete"
                  placeholder={t('nom de l’en-tête', 'header name')}
                  onChange={(e) => setNeuf({ ...neuf, authHeaderName: e.target.value })} />
              )}
              {neuf.authKind !== 'none' && (
                <input className={inputCls} type="password" value={neuf.authSecret} data-testid="mcp-neuf-secret"
                  placeholder={t('jeton', 'token')}
                  onChange={(e) => setNeuf({ ...neuf, authSecret: e.target.value })} />
              )}
              <div className="flex gap-2">
                <Bouton taille="petite" type="button" disabled={busy} data-testid="mcp-neuf-creer"
                  onClick={() => void agir(async () => {
                    await creerServeurMcp(tenantId, {
                      label: neuf.label, baseUrl: neuf.baseUrl, authKind: neuf.authKind,
                      ...(neuf.authHeaderName ? { authHeaderName: neuf.authHeaderName } : {}),
                      ...(neuf.authSecret ? { authSecret: neuf.authSecret } : {}),
                    });
                    setNeuf(null);
                    setServeurs((await listerServeursMcp(tenantId)).serveurs);
                  })}>
                  {t('Déclarer', 'Declare')}
                </Bouton>
                <Bouton variante="secondaire" taille="petite" type="button"
                  onClick={() => setNeuf(null)}>{t('Annuler', 'Cancel')}</Bouton>
              </div>
            </div>
          )}
        </div>
      )}

      {serveurs.length === 0 ? (
        <p className="text-sm text-ink-500" data-testid="mcp-vide">
          {t('Aucun serveur MCP déclaré : ajoutez-en un avec le bouton ci-dessus, muni de son adresse et de son jeton.',
            'No MCP server yet: add one with the button above, with its address and its token.')}
        </p>
      ) : (
        <ul className="space-y-3">
          {serveurs.map((s) => (
            <li key={s.id} className={cardCls} data-testid={`mcp-serveur-${s.id}`}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-medium text-ink-900">{s.label}</span>
                <code className="text-xs text-ink-500">{s.baseUrl}</code>
                {/* Des mots, pas la valeur brute (« draft ») : un brouillon s'active à la première connexion. */}
                {s.status !== 'active' && (
                  <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-500" data-testid={`mcp-statut-${s.id}`}>
                    {s.status === 'draft'
                      ? t('pas encore connecté', 'not connected yet')
                      : t('désactivé', 'disabled')}
                  </span>
                )}
              </div>

              {/* 🔴 CE QUI REND UN SERVEUR MORT VISIBLE AVANT QU'UN CONTACT NE LE DÉCOUVRE. Un jeton expiré
                  ne produit aucune erreur applicative : l'agent dégraderait en silence, en pleine
                  conversation. */}
              <p className="mt-1 text-xs text-ink-500" data-testid={`mcp-etat-${s.id}`}>
                {s.lastError
                  ? <span className="text-danger">{t('Dernière erreur : ', 'Last error: ')}{s.lastError}</span>
                  : s.lastOkAt
                    ? `${t('Connecté le ', 'Connected on ')}${dateHeure(s.lastOkAt, locale)}`
                    : t('Jamais connecté.', 'Never connected.')}
              </p>

              {isAdmin && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Bouton taille="petite" type="button" disabled={busy} data-testid={`mcp-connecter-${s.id}`}
                    onClick={() => void agir(() => connecter(s.id))}>
                    {t('Connecter', 'Connect')}
                  </Bouton>
                  <button type="button" disabled={busy} data-testid={`mcp-supprimer-${s.id}`}
                    className="rounded-controle border border-ink-300 bg-white px-2 py-0.5 text-xs text-danger transition-colors duration-150 hover:bg-danger-50 disabled:opacity-50"
                    onClick={() => void agir(async () => {
                      await supprimerServeurMcp(tenantId, s.id);
                      setServeurs((await listerServeursMcp(tenantId)).serveurs);
                    })}>
                    {t('Supprimer', 'Delete')}
                  </button>
                </div>
              )}

              {connexion?.sourceId === s.id && (
                <p className="mt-2 text-xs text-succes-700" data-testid={`mcp-connecte-${s.id}`}>
                  {t(`Connecté : ${(outils[s.id] ?? []).length} outil(s).`, `Connected: ${(outils[s.id] ?? []).length} tool(s).`)}
                </p>
              )}
              {connexion?.sourceId === s.id && connexion.tronque && (
                /* 🔴 UN PLAFOND SILENCIEUX SE LIT COMME UNE COUVERTURE COMPLÈTE : rien n'a été retiré, la liste est partielle. */
                <p className="mt-2 rounded-controle bg-alerte-50 px-2 py-1 text-xs text-ink-900" data-testid={`mcp-tronque-${s.id}`}>
                  {t('Ce serveur annonce plus d’outils que nous n’en lisons d’un coup. Rien n’a été retiré, la liste est incomplète.',
                    'This server announces more tools than we read at once. Nothing was removed, the list is incomplete.')}
                </p>
              )}

              {plan?.sourceId === s.id && (
                <div className="mt-3 rounded-carte border border-alerte-200 bg-alerte-50 p-3" data-testid={`mcp-plan-${s.id}`}>
                  <p className="mb-2 text-xs font-medium text-ink-900">
                    {t('Ce serveur a changé : des agents vont perdre l’accès à certains outils. Confirmez pour mettre à jour.',
                      'This server changed: some agents will lose access to some tools. Confirm to update.')}
                  </p>
                  {plan.tronque && (
                    /* 🔴 UN PLAFOND SILENCIEUX SE LIT COMME UNE COUVERTURE COMPLÈTE. Et il a une conséquence
                       que le client doit connaître : sur un catalogue tronqué, rien n'est retiré. */
                    <p className="mb-2 rounded-controle bg-alerte-50 px-2 py-1 text-xs text-ink-900" data-testid={`mcp-tronque-${s.id}`}>
                      {t('Ce serveur annonce plus d’outils que nous n’en lisons d’un coup. Rien ne sera retiré tant que la liste est incomplète.',
                        'This server announces more tools than we read at once. Nothing will be removed while the list is incomplete.')}
                    </p>
                  )}
                  {plan.plan.length === 0 ? (
                    <p className="text-xs text-succes-700">{t('Rien à changer.', 'Nothing to change.')}</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {plan.plan.map((c, i) => (
                        <li key={`${c.type}-${c.nom}-${i}`} className={`text-xs ${c.type === 'disparu' ? 'text-danger' : 'text-ink-500'}`}>
                          <code>{c.nom}</code> : {LIBELLE[c.type]}
                          {'consentementsTombes' in c && c.consentementsTombes > 0 && (
                            <span className="text-danger">
                              {t(` (${c.consentementsTombes} agent(s) perdront l’accès)`, ` (${c.consentementsTombes} agent(s) will lose access)`)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex gap-2">
                    <Bouton taille="petite" type="button" disabled={busy} data-testid={`mcp-importer-${s.id}`}
                      onClick={() => void agir(async () => {
                        await importerMcp(tenantId, s.id);
                        setConnexion({ sourceId: s.id, tronque: plan.tronque });
                        setPlan(null);
                        setServeurs((await listerServeursMcp(tenantId)).serveurs);
                        await chargerOutils(s.id);
                      })}>
                      {t('Confirmer', 'Confirm')}
                    </Bouton>
                    <Bouton variante="secondaire" taille="petite" type="button" disabled={busy} data-testid={`mcp-annuler-${s.id}`}
                      onClick={() => setPlan(null)}>
                      {t('Annuler', 'Cancel')}
                    </Bouton>
                  </div>
                </div>
              )}

              {outils[s.id] !== undefined && (
                <ul className="mt-3 space-y-2" data-testid={`mcp-liste-outils-${s.id}`}>
                  {(outils[s.id] ?? []).length === 0
                    ? <li className="text-xs text-ink-500">{t('Aucun outil : cliquez sur « Connecter ».', 'No tool: click “Connect”.')}</li>
                    : (outils[s.id] ?? []).map((o) => (
                      <li key={o.id}>
                        <McpOutilReglage tenantId={tenantId} outil={o} champs={champs.champs}
                          champsContact={champs.champsContact} onChange={() => void chargerOutils(s.id)} />
                      </li>
                    ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
