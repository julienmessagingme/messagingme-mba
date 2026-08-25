import { describe, it, expect } from 'vitest';
import { emailVariableFields, emailResolvableFields } from './fields';
import { contactVars } from '../../src/crm/render';
import type { UserFieldDef } from './api';

const t = (fr: string) => fr;
const champ = (key: string, label: string): UserFieldDef => ({ key, label, type: 'text' });

/**
 * Défaut signalé par Julien le 2026-08-25 : « dans les variables dispo je n'ai pas les champs de base, ou
 * tout du moins je ne vois pas le nom ou le numéro de tel ». La liste venait de `GET /user-fields`, qui ne
 * renvoie que les champs PERSO ; les champs de base n'y étaient jamais versés.
 */
describe('emailVariableFields', () => {
  it('propose le nom et le téléphone même quand le tenant n’a AUCUN champ perso', () => {
    const out = emailVariableFields([], t).map((f) => f.key);
    expect(out).toContain('profile_name');
    expect(out).toContain('phone');
  });

  it('🔴 le nom porte la clé SERVEUR `profile_name`, pas `name` (qui rendrait du vide)', () => {
    const nom = emailVariableFields([], t).find((f) => f.label === 'Nom');
    expect(nom?.key).toBe('profile_name');
    // `name` reste exclu : c'est un attribut que la table de substitution email ne fournit pas.
    expect(emailVariableFields([champ('name', 'Nom')], t).map((f) => f.key)).not.toContain('name');
  });

  it('garde les champs perso, et les place APRÈS les variables de base', () => {
    const out = emailVariableFields([champ('ville', 'Ville')], t).map((f) => f.key);
    expect(out).toEqual(['profile_name', 'phone', 'ville']);
  });

  it('un champ perso de même clé qu’une variable de base ne la duplique pas', () => {
    const out = emailVariableFields([champ('phone', 'Mon téléphone')], t);
    expect(out.filter((f) => f.key === 'phone')).toHaveLength(1);
    // C'est le champ PERSO qui gagne : `contactVars` écrase la clé système avec `contacts.fields`.
    expect(out.find((f) => f.key === 'phone')?.label).toBe('Mon téléphone');
  });

  it('n’expose PAS bsuid : identifiant technique, sans place dans un message lu par un humain', () => {
    expect(emailVariableFields([], t).map((f) => f.key)).not.toContain('bsuid');
  });

  it('🔴 TOUTE variable proposée est réellement résolue par le serveur (contrat vérifié sur contactVars)', () => {
    // Le vrai garde-fou : on confronte la liste proposée à ce que la table de substitution fournit VRAIMENT.
    // Sans lui, on peut re-proposer une clé qui laisse un blanc dans le mail envoyé au client, sans erreur.
    const contact = { phone_e164: '+33600000001', bsuid: 'b1', profile_name: 'Camille', fields: { ville: 'Lyon' } };
    const vars = contactVars(contact);
    for (const f of emailVariableFields([champ('ville', 'Ville')], t)) {
      expect(Object.keys(vars), `variable proposée « ${f.label} » (${f.key})`).toContain(f.key);
    }
  });
});

describe('emailResolvableFields (choix d’un champ CONTENANT une adresse)', () => {
  it('ne se confond pas avec les variables de corps : aucune variable de base ajoutée ici', () => {
    // Proposer « Téléphone » comme destinataire d'un mail serait un piège : ce n'est pas une adresse.
    const out = emailResolvableFields([champ('mail', 'Mail')]).map((f) => f.key);
    expect(out).toEqual(['mail']);
  });
});
