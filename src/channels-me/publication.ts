import { normalizeText, POSSESSEUR_LIEN_CHAINE } from '../automation/match';
import type { AutomationInput } from '../automation/store.pg';
import { estDemandeArret } from '../crm/consentement';
import { lienWaMe } from '../lib/wa-me';
import type { EtatScenario } from '../workflow/store.pg';
import type { Connexion, Message } from './types';
import type { LienRow } from './link-store.pg';
import { ChannelsMeApiError } from './client';
import { motCleDepuisPhrase, nouveauJeton, textePreRempli } from './jeton';
import { journaliserDistantChannelsMe } from './journal';

const COOLDOWN_LIEN_SECONDES = 300;

export interface ConnexionsPublicationChannelsMe {
  getSecrets(tenantId: string): Promise<Connexion | null>;
}

export interface ClientPublicationChannelsMe {
  createMessage(cx: Connexion, message: { text: string; mediaUrl?: string }): Promise<Message>;
}

export interface LiensPublicationChannelsMe {
  create(tenantId: string, lien: {
    workflowId: string;
    startNodeId: string | null;
    token: string;
    phrase: string;
    automationId: string | null;
    maxParHeure: number | null;
  }): Promise<LienRow>;
  byId(tenantId: string, id: string): Promise<LienRow | null>;
  supprimerAutomationCompagnon(tenantId: string, automationId: string): Promise<void>;
  messagesContenantLaPhrase(tenantId: string, phrase: string): Promise<number>;
  allumerAutomation(tenantId: string, linkId: string): Promise<void>;
}

export interface PostsPublicationChannelsMe {
  create(tenantId: string, post: { cmMessageId: string; linkId: string | null }): Promise<void>;
}

export interface AutomationsPublicationChannelsMe {
  create(tenantId: string, input: AutomationInput): Promise<{ id: string }>;
}

export interface PublicationChannelsMeDeps {
  connexions: ConnexionsPublicationChannelsMe;
  client: ClientPublicationChannelsMe;
  liens: LiensPublicationChannelsMe;
  posts: PostsPublicationChannelsMe;
  automations: AutomationsPublicationChannelsMe;
  phraseEnConflit(tenantId: string, phrase: string): Promise<boolean>;
  scenarioEtat(tenantId: string, workflowId: string): Promise<EtatScenario>;
  getDisplayPhoneNumber(tenantId: string): Promise<string | null>;
}

export type ResultatCreationLien =
  | { kind: 'cree'; lien: LienRow; numero: string }
  | { kind: 'scenario_inconnu' }
  | { kind: 'numero_absent' }
  | { kind: 'phrase_inexploitable' }
  | { kind: 'phrase_arret' }
  | { kind: 'phrase_conflit' }
  | { kind: 'phrase_deja_vue'; occurrences: number }
  | { kind: 'phrase_conflit_course' };

export type AvertissementPublicationChannelsMe =
  | 'automation_non_allumee'
  | 'trace_manquante'
  | 'reponse_inattendue';

export type ResultatPublication =
  | {
      kind: 'publie';
      post: { cmMessageId: string | null; linkId: string | null };
      avertissements: AvertissementPublicationChannelsMe[];
    }
  | { kind: 'connexion_absente' }
  | { kind: 'lien_inconnu' }
  | { kind: 'scenario_inconnu' }
  | { kind: 'scenario_vide' }
  | { kind: 'numero_absent' }
  | { kind: 'delivrance_ambigue' }
  | { kind: 'identifiants_refuses' }
  | { kind: 'publication_refusee' };

export interface PublicationChannelsMe {
  creerLien(input: {
    tenantId: string;
    workflowId: string;
    startNodeId: string | null;
    phrase: string;
    maxParHeure: number | null;
  }): Promise<ResultatCreationLien>;
  publier(input: {
    tenantId: string;
    text: string;
    mediaUrl: string | undefined;
    linkId: string | undefined;
  }): Promise<ResultatPublication>;
}

function estViolationUnique(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}

export function creerPublicationChannelsMe(deps: PublicationChannelsMeDeps): PublicationChannelsMe {
  return {
    async creerLien(input): Promise<ResultatCreationLien> {
      const { tenantId, workflowId, startNodeId, phrase, maxParHeure } = input;

      if ((await deps.scenarioEtat(tenantId, workflowId)) === 'inconnu') return { kind: 'scenario_inconnu' };

      const numero = await deps.getDisplayPhoneNumber(tenantId);
      if (numero === null) return { kind: 'numero_absent' };
      if (normalizeText(phrase) === '') return { kind: 'phrase_inexploitable' };
      if (estDemandeArret(phrase)) return { kind: 'phrase_arret' };
      if (await deps.phraseEnConflit(tenantId, phrase)) return { kind: 'phrase_conflit' };

      const occurrences = await deps.liens.messagesContenantLaPhrase(tenantId, phrase);
      if (occurrences > 0) return { kind: 'phrase_deja_vue', occurrences };

      const token = nouveauJeton();
      const { id: automationId } = await deps.automations.create(tenantId, {
        name: `Chaine : ${phrase}`.slice(0, 200),
        triggerKind: 'keyword',
        triggerConfig: { keywords: [motCleDepuisPhrase(phrase)], mode: 'contains' },
        conditionGroup: null,
        workflowId,
        startNodeId,
        cooldownSeconds: COOLDOWN_LIEN_SECONDES,
        enabled: false,
        possedePar: POSSESSEUR_LIEN_CHAINE,
        maxFiresPerHour: maxParHeure,
      });

      try {
        const lien = await deps.liens.create(tenantId, {
          workflowId, startNodeId, token, phrase, automationId, maxParHeure,
        });
        return { kind: 'cree', lien, numero };
      } catch (err) {
        await deps.liens.supprimerAutomationCompagnon(tenantId, automationId).catch((errRattrapage: unknown) => {
          journaliserDistantChannelsMe(tenantId, 'link_rattrapage_automation', errRattrapage);
        });
        journaliserDistantChannelsMe(tenantId, 'link_create', err);
        if (estViolationUnique(err)) return { kind: 'phrase_conflit_course' };
        throw err;
      }
    },

    async publier(input): Promise<ResultatPublication> {
      const { tenantId, text, mediaUrl, linkId } = input;
      const connexion = await deps.connexions.getSecrets(tenantId);
      if (connexion === null) return { kind: 'connexion_absente' };

      let lien: LienRow | null = null;
      let texteDuPost = text;
      if (linkId !== undefined) {
        lien = await deps.liens.byId(tenantId, linkId);
        if (lien === null) return { kind: 'lien_inconnu' };

        const etat = await deps.scenarioEtat(tenantId, lien.workflowId);
        if (etat === 'inconnu') return { kind: 'scenario_inconnu' };
        if (etat !== 'ok') return { kind: 'scenario_vide' };

        const url = lienWaMe(await deps.getDisplayPhoneNumber(tenantId), textePreRempli(lien.phrase));
        if (url === null) return { kind: 'numero_absent' };
        texteDuPost = `${text}\n\n${url}`;
      }

      const avertissements: AvertissementPublicationChannelsMe[] = [];
      let publie: Message | null = null;
      try {
        publie = await deps.client.createMessage(connexion, {
          text: texteDuPost,
          ...(mediaUrl !== undefined ? { mediaUrl } : {}),
        });
      } catch (err) {
        journaliserDistantChannelsMe(tenantId, 'post_create', err);
        if (err instanceof ChannelsMeApiError && err.status === 0) return { kind: 'delivrance_ambigue' };
        if (err instanceof ChannelsMeApiError && (err.status === 401 || err.status === 403)) {
          return { kind: 'identifiants_refuses' };
        }
        if (!(err instanceof ChannelsMeApiError) || err.status < 200 || err.status >= 300) {
          return { kind: 'publication_refusee' };
        }
        avertissements.push('reponse_inattendue');
      }

      if (lien !== null) {
        try {
          await deps.liens.allumerAutomation(tenantId, lien.id);
        } catch (err) {
          journaliserDistantChannelsMe(tenantId, 'post_allumage', err);
          avertissements.push('automation_non_allumee');
        }
      }

      const cmMessageId = publie === null ? null : String(publie.id);
      if (cmMessageId !== null) {
        try {
          await deps.posts.create(tenantId, { cmMessageId, linkId: lien?.id ?? null });
        } catch (err) {
          journaliserDistantChannelsMe(tenantId, 'post_trace', err);
          avertissements.push('trace_manquante');
        }
      }

      return {
        kind: 'publie',
        post: { cmMessageId, linkId: lien?.id ?? null },
        avertissements,
      };
    },
  };
}
