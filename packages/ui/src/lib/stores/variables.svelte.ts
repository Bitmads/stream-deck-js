// Thin re-export layer — all state lives in store.svelte.ts
import { store } from "./store.svelte";

export function getVariable(name: string) { return store.getVariable(name); }
export function setVariable(name: string, value: string) { store.setVariable(name, value); }
export function setVariableLocal(name: string, value: string) { store.setVariableLocal(name, value); }
export function deleteVariable(name: string) { store.deleteVariable(name); }
export function deleteVariableLocal(name: string) { store.deleteVariableLocal(name); }
export function getAllVariables() { void store.varRevision; return { ...store.variables }; }
export function resolveTemplate(text: string) { return store.resolveTemplate(text); }
export function hasTemplates(text: string) { return store.hasTemplates(text); }
export function extractVariableNames(text: string) { return store.extractVariableNames(text); }
export function resolveNumber(input: string | number | undefined, fallback: number) { return store.resolveNumber(input, fallback); }
export function initVariables() { store.initVariables(); }
