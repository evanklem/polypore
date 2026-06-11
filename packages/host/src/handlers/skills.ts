/* skill + skillset crud and publish handlers — registered against the core server by
   registerBuiltinHandlers(). HostInternals documents exactly which
   server state this domain touches. */

import type { HostInternals } from './internals';
import type { SkillRecord, SkillsetRecord } from '../rpc-server';
import { fileSlug, summarizeSkillBody } from '../rpc-server';

export function registerSkillsHandlers(host: HostInternals) {
  host.registerHandler('skills.list', () => ({ skills: [...host.skills] }));
  host.registerHandler('skills.read', (params) => {
    const { id } = params as { id: string };
    const skill = host.skills.find((s) => s.id === id);
    if (!skill) throw new Error(`skill not found: ${id}`);
    return { skill };
  });
  host.registerHandler('skills.write', (params) => {
    const partial = params as Partial<SkillRecord>;
    const id = partial.id ?? `skill-${Date.now()}`;
    const existing = host.skills.find((s) => s.id === id);
    const body = partial.body ?? existing?.body;
    const skill: SkillRecord = {
      id,
      name: partial.name ?? existing?.name ?? id,
      summary: partial.summary ?? existing?.summary ?? summarizeSkillBody(body) ?? '',
      ...(body === undefined ? {} : { body }),
      /* preserve skillsetId / origin / publishedTo unless caller overrides */
      skillsetId: partial.skillsetId !== undefined ? partial.skillsetId : existing?.skillsetId,
      origin: partial.origin ?? existing?.origin ?? 'polypore',
      publishedTo: partial.publishedTo ?? existing?.publishedTo,
    };
    host.skills = [skill, ...host.skills.filter((s) => s.id !== skill.id)];
    host.publish('skills:changed', { skills: host.skills });
    return { skill, written: true };
  });
  host.registerHandler('skills.publish', async (params) => {
    const { id, agents } = params as { id: string; agents: Array<'claude' | 'codex'> };
    const existing = host.skills.find((s) => s.id === id);
    if (!existing) throw new Error(`skill not found: ${id}`);
    const skill: SkillRecord = { ...existing, publishedTo: [...new Set(agents)] };
    host.skills = host.skills.map((s) => (s.id === id ? skill : s));
    host.publish('skills:changed', { skills: host.skills });
    if (host.skillPublisher) {
      if (agents.length) {
        await host.skillPublisher.publish(id, existing.name, existing.body ?? '', agents).catch(() => {});
      } else {
        await host.skillPublisher.unpublish(id).catch(() => {});
      }
    }
    return { skill };
  });
  host.registerHandler('skills.delete', async (params) => {
    const { id } = params as { id: string };
    if (!host.skills.some((skill) => skill.id === id)) throw new Error(`skill not found: ${id}`);
    if (host.skillPublisher) {
      await host.skillPublisher.delete(id).catch(() => {});
    }
    host.skills = host.skills.filter((skill) => skill.id !== id);
    host.publish('skills:changed', { skills: host.skills });
    return { deleted: true, id };
  });
  host.registerHandler('skills.invoke', async (params) => {
    const { id, sessionId, args } = params as { id: string; sessionId?: string; args?: Record<string, unknown> };
    const skill = host.skills.find((s) => s.id === id);
    if (!skill) throw new Error(`skill not found: ${id}`);
    const header = `# Skill: ${skill.name || skill.id}`;
    const argLine = args && Object.keys(args).length ? `\n\nArguments: ${JSON.stringify(args)}` : '';
    const text = `${header}${argLine}\n\n${skill.body ?? ''}`.trim();
    /* a skill "activates" by entering a chat session as a header-prefixed
       message; reuse chat.send so the agent dispatcher handles delivery and
       transcript persistence exactly like a user turn. */
    let delivered = false;
    if (sessionId) {
      const chatSend = host.handlers.get('chat.send');
      if (chatSend) {
        await chatSend({ sessionId, text });
        delivered = true;
      }
    }
    host.publish('skills:invoked', { id, sessionId: sessionId ?? null, text, delivered });
    return { invoked: true, id, sessionId: sessionId ?? null, delivered, text };
  });
  
  /* skillsets — bundle of skills (e.g. polyflow). loose skills (no
     skillsetId) are also returned as a synthetic top-level group by
     the renderer when needed. */
  host.registerHandler('skillsets.list', () => ({ skillsets: [...host.skillsets] }));
  host.registerHandler('skillsets.read', (params) => {
    const { id } = params as { id: string };
    const skillset = host.skillsets.find((s) => s.id === id);
    if (!skillset) throw new Error(`skillset not found: ${id}`);
    const skills = host.skills.filter((s) => s.skillsetId === id);
    return { skillset, skills };
  });
  host.registerHandler('skillsets.upsert', (params) => {
    const partial = params as Partial<SkillsetRecord> & { title: string };
    const id = partial.id ?? fileSlug(partial.title);
    const existing = host.skillsets.find((s) => s.id === id);
    const skillset: SkillsetRecord = {
      id,
      title: partial.title,
      version: partial.version ?? existing?.version ?? '0.1.0',
      builtin: existing?.builtin ?? false,
      source: partial.source ?? existing?.source ?? 'user',
      summary: partial.summary ?? existing?.summary,
      skills: partial.skills ?? existing?.skills ?? [],
    };
    host.skillsets = [skillset, ...host.skillsets.filter((s) => s.id !== id)];
    host.publish('skillsets:changed', { skillsets: host.skillsets });
    return { skillset };
  });
  host.registerHandler('skillsets.delete', (params) => {
    const { id } = params as { id: string };
    const target = host.skillsets.find((s) => s.id === id);
    if (!target) throw new Error(`skillset not found: ${id}`);
    if (target.builtin) throw new Error(`cannot delete builtin skillset: ${id}`);
    host.skillsets = host.skillsets.filter((s) => s.id !== id);
    /* orphan contained skills back to loose */
    host.skills = host.skills.map((s) => (s.skillsetId === id ? { ...s, skillsetId: undefined } : s));
    host.publish('skillsets:changed', { skillsets: host.skillsets });
    host.publish('skills:changed', { skills: host.skills });
    return { deleted: true, id };
  });
  
  /* mcp servers — registry of agent-agnostic mcp endpoints. polypore
     owns the canonical list; the desktop shell publishes them to
     ~/.claude/ and ~/.codex/ so all agents see the same servers. */
}
