// src/styles/tooltip.css.ts
// The shared tooltip's stylesheet (design spec §AG), moved out of
// tooltip.ts unchanged. Appended to every shadow root that attaches
// tooltips (sidebar.ts, addMode.ts), after that surface's own CSS.

import { ACC, STD } from '../flip';

export const TOOLTIP_CSS = `
  .sal-tip {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 2147483647;
    max-width: 260px;
    padding: 6px 9px;
    background: var(--sal-raised);
    border: 1px solid var(--sal-line-strong);
    border-radius: var(--sal-radius-sm);
    box-shadow: var(--sal-shadow-pop);
    color: var(--sal-text);
    font-family: var(--sal-font-body);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.3;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    transition: opacity 90ms ${ACC.css}, visibility 0s linear 90ms;
  }
  /* A keyboard shortcut after the label (data-tip-key), drawn as a key. */
  .sal-tip-key {
    display: inline-block;
    margin-left: 7px;
    padding: 0 5px;
    border: 1px solid var(--sal-line-strong);
    border-radius: 4px;
    font-family: var(--sal-font-body);
    font-size: 11px;
    font-weight: 500;
    line-height: 16px;
    color: var(--sal-text);
  }
  .sal-tip[data-open="true"] {
    opacity: 1;
    visibility: visible;
    transition: opacity 120ms ${STD.css}, visibility 0s;
  }
  /* The pointer: a small square turned 45deg, bordered on the two sides
     that face outwards so it reads as part of the tooltip's outline. */
  .sal-tip::after {
    content: '';
    position: absolute;
    width: 7px;
    height: 7px;
    background: var(--sal-raised);
    border: 1px solid var(--sal-line-strong);
    transform: rotate(45deg);
  }
  .sal-tip[data-side="below"]::after {
    top: -5px;
    left: calc(var(--tip-arrow, 50%) - 4.5px);
    border-right: none;
    border-bottom: none;
  }
  .sal-tip[data-side="above"]::after {
    bottom: -5px;
    left: calc(var(--tip-arrow, 50%) - 4.5px);
    border-left: none;
    border-top: none;
  }
  .sal-tip[data-side="right"]::after {
    left: -5px;
    top: calc(var(--tip-arrow, 50%) - 4.5px);
    border-right: none;
    border-top: none;
  }
  .sal-tip[data-side="left"]::after {
    right: -5px;
    top: calc(var(--tip-arrow, 50%) - 4.5px);
    border-left: none;
    border-bottom: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .sal-tip,
    .sal-tip[data-open="true"] { transition: none; }
  }
`;
