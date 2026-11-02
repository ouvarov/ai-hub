import type { Action } from "@shared/types";

// Actions registry — empty in the template. The builder appends one import and
// one array entry per action (see derive-registry.ts); keep the array literal
// on its own lines so the additive derivation has a stable anchor.
export const actions: Action<any, any>[] = [
];
