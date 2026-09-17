/**
 * Bounds that are the API's own rather than the deployment's, so they sit next to each other instead
 * of being repeated at their call sites. Anything an operator should be able to change lives in
 * `config.ts`; these are contract values, and changing one changes the contract.
 */
export const DEFAULT_LOG_TAIL = 100;
export const MAX_LOG_TAIL = 1000;
