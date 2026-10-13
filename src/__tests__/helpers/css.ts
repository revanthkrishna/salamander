// Shared by the suites that read a shadow root's stylesheet text (the
// approved-visual pins in sidebar.test.ts and addMode.test.ts): the first
// rule in `css` whose selector list is exactly `selector`, braces included,
// or '' when there is none. Matching starts at a line start, so a selector
// that only appears inside a longer selector list never matches.
export function cssRuleIn(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? '';
}
