import { createContext, useContext } from 'react';
import type { IdentityContext } from './auth-api';

/** A capability for this validated session only. Never persisted or shared between tabs. */
export interface SessionMemory {
  read(key: string): unknown;
  write(key: string, value: unknown): void;
  remove(key: string): void;
}

export const SessionMemoryContext = createContext<SessionMemory | null>(null);
export const useSessionMemory = () => useContext(SessionMemoryContext);

/** Owned by the login boundary; suspension retains data but revokes every old capability. */
export function createSessionMemory() {
  const entries = new Map<string, unknown>();
  let principal: string | null = null;
  let generation = 0;
  return {
    suspend() { generation += 1; },
    clear() { generation += 1; entries.clear(); principal = null; },
    activate(identity: IdentityContext): SessionMemory {
      const next = JSON.stringify([identity.companyId, identity.accountId, identity.role]);
      if (next !== principal) entries.clear();
      principal = next;
      const ownGeneration = ++generation;
      const active = () => generation === ownGeneration;
      return {
        read: (key) => active() ? entries.get(key) : undefined,
        write: (key, value) => { if (active()) entries.set(key, value); },
        remove: (key) => { if (active()) entries.delete(key); },
      };
    },
  };
}
