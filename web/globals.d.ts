/**
 * Ambient shapes the app relies on but does not import.
 *
 * The `__`-prefixed window properties are a CONTRACT WITH THE E2E SUITE, not
 * debugging leftovers: `src/e2e/ui.e2e.ts` calls each one to test a pure function
 * without a page around it. Declaring them here is the only place that link is
 * written down — deleting one otherwise breaks a test with nothing pointing back.
 */

interface Window {
  /** highlight.js, loaded as a plain script from `vendor/`. */
  hljs?: {
    highlight(code: string, opts: { language: string; ignoreIllegals?: boolean }): { value: string };
    highlightElement(el: Element): void;
    getLanguage(name: string): unknown;
  };
  /** marked, loaded as a plain script from `vendor/`. */
  marked?: { parse(md: string): string };

  /** @see src/e2e/ui.e2e.ts — "app.js must expose __diffCodeRows for this" */
  __diffCodeRows?: (lines: unknown[], language: string) => unknown[];
  /** @see src/e2e/ui.e2e.ts — reading order across features/chapters/steps */
  __readingOrder?: (story: unknown, steps: unknown) => unknown[];
  /** @see src/e2e/ui.e2e.ts — scrolls a step under the sticky header */
  __revealStep?: (anchorId: string) => void;
}

interface Element {
  /**
   * Idempotence marker for the pan/zoom wiring on a rebuilt SVG. An expando
   * rather than a WeakSet because vdx may hand back the same element across
   * renders and the wiring must attach exactly once.
   */
  _cmWired?: boolean;
}
