import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  redirect,
  useLocation,
  useRouter,
  useRouterState,
} from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { OutboundNavLinks } from '../components/GithubLink'
import { DesktopMark, FAVICON, Logo } from '../components/Logo'
import { NavIcon } from '../components/NavIcon'
import { currentSession, signOut, usingDefaultPassword } from '../server/auth'

/**
 * The whole stylesheet, injected once from here.
 *
 * Add a class here rather than an inline style for anything used twice. There is no CSS
 * framework and no build step for styles on purpose — the cost of that choice is that
 * this file is the design system, so it has to stay legible.
 *
 * ponytail: one string. It works to roughly 700 lines; past that it needs real files and
 * a real answer.
 */
const css = `
:root {
  /* Neutrals are cool and the accent is rationed: moss marks where you are, ink marks
     what to press. See designv2.md — this block is the whole palette. */
  --ink: #171717; --moss: #2f6b5f; --smoke: #737373;
  --sand: #fafafa; --white: #fff; --line: #ebebeb; --edge: #d4d4d4;
  /* The one tinted surface in the system: behind the nav item you are on. */
  --moss-face: #edf4f2;
  --amber: #ffd166; --amber-edge: #e8bb4e;
  /* Conversation states. Green is answered, amber is waiting on a person. */
  --ok-face: #eaf5ef; --ok-ink: #1d6b45;
  --warn-face: #fff6e3; --warn-ink: #8a6212;
  --bad-face: #fdecec; --bad-ink: #96262b;
  /* Controls, containers, and things that are fully round. The 6px step between the
     first two is what makes a button inside a card read as deliberate. */
  --r-sm: 8px; --r-md: 14px; --r-full: 999px;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0; background: var(--sand); color: var(--ink);
  font-family: Inter, system-ui, -apple-system, sans-serif; font-size: 16px; line-height: 1.5;
  letter-spacing: -0.011em;
}
/* Inside the app the viewport is fixed and each pane scrolls itself. A bare page — the
   landing, the sign-in form — is an ordinary document and has to scroll the ordinary way,
   or everything below the fold is unreachable. */
body:has(> .shell) { overflow: hidden; }

.shell { display: grid; grid-template-columns: 236px minmax(0, 1fr); height: 100%; }
aside {
  background: var(--white);
  border-right: 1px solid var(--line); padding: 24px 14px;
  height: 100%; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 4px;
}
.brand {
  display: flex; align-items: center; gap: 8px; text-decoration: none; color: var(--ink);
  font-size: 20px; font-weight: 600; letter-spacing: -0.02em; padding: 0 10px 18px;
}
.brand span span { color: var(--moss); font-weight: 500; }
/* The edition mark. Moss like the word it follows, so the two read as one unit and the
   bubble stays the thing your eye lands on first. Nudged down a hair because a stroked
   rectangle sits optically high beside a cap-height word. */
.brand .editionmark { color: var(--moss); margin-left: 2px; transform: translateY(1px); flex: none; }
aside a.link {
  display: flex; align-items: center; gap: 10px;
  color: var(--ink); text-decoration: none; font-size: 15px; font-weight: 500;
  border-radius: var(--r-sm); padding: 8px 10px;
}
/* The mark is secondary to the word until this is the page you are on. */
aside a.link svg { flex: none; color: var(--smoke); }
aside a.link:hover { background: var(--line); }
/* A soft wash rather than a solid fill. Where you are should be findable at a glance,
   not the loudest object on the screen — an operator looks at this rail all day. */
aside a.link.active { background: var(--moss-face); color: var(--moss); }
aside a.link.active svg { color: var(--moss); }
aside .sect {
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px; text-transform: uppercase;
  letter-spacing: 0.07em; color: var(--smoke); padding: 18px 10px 5px;
}
/* Whose session this is, and which workspace it is pointed at. Belongs to the person
   rather than to the page, so it sits below everything and is ruled off from the nav. */
aside .foot {
  margin-top: auto; padding: 12px 10px 2px; font-size: 13px; color: var(--smoke);
  border-top: 1px solid var(--line);
}
aside .who { display: flex; align-items: center; gap: 8px; }
aside .who .face {
  flex: none; display: grid; place-items: center; width: 28px; height: 28px;
  border-radius: var(--r-full); background: var(--line); color: var(--ink);
  font-size: 12px; font-weight: 600; text-transform: uppercase;
}
/* The address is the long part and the one that can be truncated; the button must not be. */
aside .who .email { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
aside .who .out {
  flex: none; background: none; border: 0; padding: 4px; border-radius: var(--r-sm);
  color: var(--smoke); cursor: pointer; display: grid; place-items: center;
}
aside .who .out:hover { background: var(--line); color: var(--ink); }

/*
  The repository link. Deliberately quieter than a nav item — it leaves the app, so it
  should not look like somewhere in it. The trailing arrow carries that; the icon alone
  reads as another destination.
*/
.repo {
  display: flex; align-items: center; gap: 8px;
  color: var(--smoke); text-decoration: none; font-size: 13px;
  padding: 7px 8px; border-radius: var(--r-sm);
}
.repo span { flex: 1; min-width: 0; }
.repo svg:last-child { flex: none; opacity: 0.55; }
.repo:hover { background: var(--line); color: var(--ink); }
.repo:hover svg:last-child { opacity: 1; }
aside .foot .repo { margin: 0 0 6px; }
/* On the sign-in card there is no sidebar to belong to, so the pair centres under the
   form. They wrap rather than squeeze on a narrow phone. */
.repos { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; margin-top: 16px; }
.repo.quiet { justify-content: center; }
.repo.quiet span { flex: none; }

main { height: 100%; min-height: 0; overflow-y: auto; }
main > .page { padding: 36px 36px 64px; max-width: 1240px; }

h1 { font-size: 38px; line-height: 1.08; letter-spacing: -0.022em; font-weight: 600; margin: 0 0 6px; }
h2 { font-size: 20px; line-height: 1.35; letter-spacing: -0.015em; font-weight: 600; margin: 36px 0 14px; }
h3 { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
p.lede { color: var(--smoke); font-size: 17px; margin: 0 0 32px; max-width: 62ch; }
.note { color: var(--smoke); font-size: 13px; }
/* Like .note, but for something the operator probably wants to act on. */
.warn { color: var(--warn-ink); font-size: 13px; }
/* Its opposite, for the line that says something worked. Same size and weight: good news
   that shouts is as hard to skim past as bad news that whispers. */
.ok { color: var(--ok-ink); font-size: 13px; }
a { color: var(--moss); }

/* The ancestor this page hangs off, named rather than called "Back". Sits above the title. */
.backlink {
  display: inline-block; color: var(--smoke); text-decoration: none; font-size: 14px;
  margin-bottom: 12px;
}
.backlink:hover { color: var(--ink); }
/* Title on the left, what you can do to it on the right, on one line. Every page that
   has actions was building this by hand. */
.pagehead { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.pagehead .titles { flex: 1 1 320px; min-width: 0; }
.pagehead .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
/* Detached from any form, so these are full pills. Buttons inside a form are not —
   a pill next to a rectangular input reads as a mistake. */
.pagehead .actions button, .pagehead .actions a.button { border-radius: var(--r-full); }

/*
 * The navigation bar, in the "is anything happening" sense.
 *
 * Indeterminate on purpose: the router knows a loader is pending, never how far through it
 * is, and a bar that crept to 90% and waited would be inventing a number. This says only
 * "working", which is the true thing and the thing somebody actually needs.
 *
 * Fixed to the viewport top and above everything, so it is visible from a page scrolled
 * halfway down and from inside a dialog. pointer-events: none because it must never be
 * something you can click on or hover.
 */
.navload {
  position: fixed; top: 0; left: 0; right: 0; height: 2px; z-index: 100;
  pointer-events: none; overflow: hidden;
  /* Faded rather than unmounted: the element is already laid out when a navigation
     starts, so appearing costs nothing at the moment the machine is busiest. */
  opacity: 0; transition: opacity 0.15s ease;
}
.navload.on { opacity: 1; }
.navload::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, var(--moss), transparent);
  /* Only animates while it is on, so an idle tab is not repainting forever. */
  animation: navload 1.1s ease-in-out infinite;
  animation-play-state: paused;
}
.navload.on::after { animation-play-state: running; }
@keyframes navload {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
/* Somebody who asked for less motion still needs to know it is working, so the bar stays
   and only the sweep stops. */
@media (prefers-reduced-motion: reduce) {
  .navload::after { animation: none; background: var(--moss); opacity: 0.6; }
}

.card { background: var(--white); border: 1px solid var(--line); border-radius: var(--r-md); padding: 20px; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.grid.two { grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); }
.stat { font-size: 32px; line-height: 1.15; letter-spacing: -0.022em; font-variant-numeric: tabular-nums; }
/* The label sits above the figure: in a row of three you want to know what you are
   looking at before you read it. */
.stat small {
  display: block; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px;
  font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em; color: var(--smoke);
  margin-bottom: 6px; font-variant-numeric: normal;
}
/* A label says what the figure is; a caption says what to do about it. The second one is
   a sentence, so it stays prose and stays below the number. */
.stat .cap {
  display: block; font-size: 13px; line-height: 1.4; font-weight: 400; color: var(--smoke);
  letter-spacing: -0.011em; margin-top: 6px; font-variant-numeric: normal;
}

table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 500; color: var(--smoke); padding: 8px 10px; border-bottom: 1px solid var(--edge); white-space: nowrap; }
td { padding: 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.click { cursor: pointer; }
tr.click:hover td { background: var(--sand); }

button {
  background: var(--ink); color: var(--white); border: 0; border-radius: var(--r-sm);
  padding: 9px 16px; font: inherit; font-weight: 500; font-size: 15px; cursor: pointer;
}
button.ghost { background: none; color: var(--ink); border: 1px solid var(--edge); }
/* Destructive, and only obviously so once somebody is reaching for it — loud enough to
   read as a warning under the cursor, quiet enough not to invite a click. */
button.ghost.bad { color: var(--bad-ink); }
/* The answer in a confirm dialog: as easy to press as any other primary, and unmistakably
   the destructive one. */
button.primary.bad { background: var(--bad-ink); color: var(--white); }
button.primary.bad:hover:not(:disabled) { filter: brightness(1.1); }
button.ghost.bad:hover:not(:disabled) { border-color: var(--bad-ink); background: var(--bad-face); }
button.small { padding: 5px 10px; font-size: 13px; }
button:disabled { opacity: 0.5; cursor: default; }
input, select, textarea {
  width: 100%; padding: 9px 11px; font: inherit; font-size: 15px; color: var(--ink);
  background: var(--white); border: 1px solid var(--edge); border-radius: var(--r-sm);
}
textarea { resize: vertical; min-height: 84px; }
label { display: block; font-size: 13px; font-weight: 500; color: var(--smoke); margin-bottom: 4px; }
.fields { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
/* The spacer that pushes what follows it to the far end of a row. It was only ever defined
   inside .training .reviewbar, so the seven other places using it were quietly doing
   nothing — buttons meant to sit right were sitting next to the text they follow. */
.grow { flex: 1; }
/* Two rows of controls in a column want air between them, wherever they are. */
.row + .row { margin-top: 10px; }

.pill {
  display: inline-block; border-radius: var(--r-full); padding: 2px 9px; font-size: 12px; font-weight: 500;
  background: var(--line); color: var(--smoke); white-space: nowrap;
}
.pill.ok { background: var(--ok-face); color: var(--ok-ink); }
/*
 * A settings tab, split into its parts: the list on the left, the one you picked on the right.
 *
 * Both halves are cards, and that is what makes it read as a place rather than a toolbar —
 * a rail of bare buttons above a form looks like something you press, while a panel beside
 * a panel looks like something you are inside of.
 */
/* Sub-tabs within a page: a row of words on a rule, the current one underlined in ink.
   Deliberately not chips — chips are filters, and these change the whole view. */
.tabs { display: flex; gap: 0; border-bottom: 1px solid var(--line); margin: 20px 0 0; }
.tab {
  background: none; border: 0; border-bottom: 2px solid transparent; border-radius: 0;
  color: var(--smoke); font: inherit; font-size: 14px; font-weight: 400;
  padding: 7px 2px; margin: 0 18px -1px 0; cursor: pointer;
}
.tab:hover { color: var(--ink); }
.tab.on { color: var(--ink); font-weight: 600; border-bottom-color: var(--ink); }

.subsplit {
  display: grid; grid-template-columns: minmax(200px, 248px) minmax(0, 1fr);
  gap: 16px; align-items: start;
}
.subrail {
  display: grid; gap: 1px; padding: 6px;
  background: var(--white); border: 1px solid var(--line); border-radius: var(--r-md);
  position: sticky; top: 0;
}
.subrail button {
  display: block; width: 100%; text-align: left; padding: 8px 10px;
  background: none; color: var(--ink); border: 0; border-radius: var(--r-sm);
  font: inherit; cursor: pointer;
}
.subrail button:hover { background: var(--sand); }
.subrail button strong { display: block; font-size: 13.5px; font-weight: 500; }
.subrail button .note { display: block; margin: 1px 0 0; font-size: 11.5px; line-height: 1.35; }
/* The one you are on is a solid block, so the eye finds it before it reads anything. */
.subrail button.on { background: var(--ink); color: var(--white); }
.subrail button.on .note { color: var(--white); opacity: 0.62; }

.subpane {
  background: var(--white); border: 1px solid var(--line); border-radius: var(--r-md);
  padding: 18px 20px;
}
.subpane > header { margin-bottom: 16px; }
.subpane > header h3 { font-size: 16px; font-weight: 600; margin: 0; }
.subpane > header .note { margin: 3px 0 0; max-width: 64ch; }
/*
 * Smaller type inside a panel than out in the page.
 *
 * A settings panel is a form being worked through rather than a page being read, and at
 * page size four fields filled the screen. Scoped here, so the app's reading sizes are
 * untouched.
 */
.subpane .fieldset { gap: 16px; }
.subpane input, .subpane select, .subpane textarea { font-size: 14px; padding: 8px 10px; }
.subpane .field > .note, .subpane .field .note { font-size: 12.5px; line-height: 1.45; }
.subpane .switch strong { font-size: 13.5px; }
/*
 * Field labels in here are small caps, which is the one place this app shouts: a two-column
 * form of plain-sentence labels reads as prose and you lose which words are the questions.
 */
.subpane .field > label, .subpane .field > .switch + label {
  font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--smoke);
}

@media (max-width: 760px) {
  /* The rail becomes a scrolling row of names above the panel — a 200px column beside a
     form is neither of them on a phone. */
  .subsplit { grid-template-columns: minmax(0, 1fr); }
  .subrail {
    position: static; display: flex; gap: 4px; overflow-x: auto; padding: 6px;
  }
  .subrail button { width: auto; white-space: nowrap; padding: 7px 12px; }
  .subrail button .note { display: none; }
  .subpane { padding: 18px 16px; }
}

/*
 * A price list, and the dates a business keeps.
 *
 * Rows rather than a table for the same reason the move history is: one of the columns is a
 * sentence, and a table that has to hold one is a table that overflows a phone.
 */
.pricelist { display: grid; margin-top: 12px; border-top: 1px solid var(--line); }
.pricerow {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 10px 2px; border-bottom: 1px solid var(--line);
}
.pricerow.off { opacity: 0.5; }
.pricerow .what { flex: 1; min-width: 160px; }
.pricerow .what b { font-size: 14px; font-weight: 500; }
.pricerow .what code { margin-left: 8px; font-size: 11px; }
.pricerow .what .pill { margin-left: 8px; font-size: 11px; }
.pricerow .what small { display: block; font-size: 12.5px; color: var(--smoke); }
.pricerow .cost { font-size: 14px; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* The hour on a month grid, before the name of the thing. */
.calentry small { font-variant-numeric: tabular-nums; opacity: 0.75; margin-right: 4px; }

/*
 * The calendar page: what is being drawn on the left, the merged month on the right.
 *
 * The same shape as the knowledge base list, because it is the same question — which of
 * these several things am I looking at — and answering it twice in two layouts would be
 * two things to learn rather than one.
 */
.calmain { min-width: 0; margin-top: 18px; }

/*
 * The calendars themselves, under the month they add up to.
 *
 * A row rather than a rail: this is a list of things you keep, add to and remove — the
 * tick that takes one out of the month above is the smaller half of what it is for.
 */
.callist {
  display: grid; gap: 2px; margin-top: 12px; padding: 8px;
  background: var(--white); border: 1px solid var(--line); border-radius: var(--r-md);
}
/* The whole row opens what it names, so it is a link and has to stop looking like one. */
.calrow {
  display: flex; align-items: center; gap: 12px; margin: 0; padding: 10px;
  border-radius: var(--r-sm); font-weight: 400; cursor: pointer;
  color: var(--ink); text-decoration: none;
}
.calrow:hover { background: var(--sand); }
/* The tick wears the calendar's colour, which is the only legend the month needs. */
/*
 * The colour, as a dot rather than a tick.
 *
 * The row stopped being a control when the filter became pills over the month — what is
 * left is a list of what exists, and the dot is only there to tie a row to its colour in
 * the grid above.
 */
.calrow .dot { flex: none; width: 10px; height: 10px; border-radius: var(--r-full); background: var(--src); }

/* The filter itself: one pill per source, over the month it decides. */
.calpills { margin: 0 0 10px; align-items: center; }
.calpills .chip .dot { width: 8px; height: 8px; border-radius: var(--r-full); background: var(--src); margin: 0; }
/* Off: the colour stays, so a pill still says which calendar it turns back on. */
.calpills .chip { opacity: 0.55; }
.calpills .chip.on { opacity: 1; background: var(--white); border-color: var(--src); color: var(--ink); }
.calpills .chip.on b { opacity: 0.6; }
.calrow .what { flex: 1; min-width: 0; }
.calrow b { font-size: 14px; font-weight: 500; }
.calrow .pill { margin-left: 8px; font-size: 11px; }
.calrow small { display: block; font-size: 12.5px; }
.calrow .count { flex: none; white-space: nowrap; font-variant-numeric: tabular-nums; }
.calrow > .button, .calrow > button { flex: none; }

/*
 * One palette, six names.
 *
 * Names rather than hex values on the row, so a calendar cannot be made unreadable and the
 * colours stay this app's — set once here, used by the tick, the swatch and every entry.
 */
/* Blue leads because a calendar defaults to it, and red is next because a project does. */
.sky { --src: #2b6b8f; }
.rose { --src: #b03a48; }
.moss { --src: var(--moss); }
.amber { --src: #b7791f; }
.plum { --src: #7c3f6b; }
.clay { --src: #a35a3c; }
.slate { --src: #5b6472; }
.calentry.moss, .calentry.amber, .calentry.plum, .calentry.sky, .calentry.rose, .calentry.clay, .calentry.slate {
  border-left: 3px solid var(--src);
}
.swatch {
  width: 22px; height: 22px; padding: 0; border-radius: var(--r-full);
  background: var(--src); border: 2px solid transparent;
}
.swatch.on { border-color: var(--ink); }

@media (max-width: 640px) {
  /* The count and the description are the two things a phone can lose here. */
  .calrow { flex-wrap: wrap; gap: 8px; }
  .calrow .count { order: 3; }
}

/* A date the bot worked out from a conversation and somebody approved. */
.calentry.learned { border-left: 3px solid var(--amber-edge); }

/*
 * A note at the top of a page saying what the thing below it is for.
 *
 * Reserved for a distinction somebody will otherwise get wrong — two calendars that look
 * alike and hold opposite kinds of date. A tip on every page would be a page nobody reads
 * the top of.
 */
.tip {
  margin: 12px 0 14px; padding: 12px 14px; max-width: 78ch;
  background: var(--sand); border: 1px solid var(--line); border-left: 3px solid var(--moss);
  border-radius: var(--r-sm);
}
.tip strong { display: block; font-size: 13.5px; margin-bottom: 3px; }
.tip p { margin: 0; font-size: 13px; line-height: 1.5; color: var(--smoke); }
.tip b { color: var(--ink); font-weight: 500; }

/*
 * Where the reading stopped, drawn across the thread.
 *
 * A rule with the words sitting in a gap in it, rather than a bubble of its own: it is not
 * something anybody said, and giving it the shape of a message would put a sentence in the
 * transcript that nobody wrote.
 */
.readline {
  display: flex; align-items: center; gap: 10px; margin: 6px 2px;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
  font-family: ui-monospace, SFMono-Regular, monospace; color: var(--smoke);
}
.readline::before, .readline::after { content: ''; flex: 1; height: 1px; background: var(--line); }
.readline span { flex: none; }

/*
 * A reply somebody else wrote, sitting above the box it is in.
 *
 * Joined to the textarea rather than floating above it, because they are one thing: the
 * words below are the ones this bar is talking about, and a gap between them invites
 * reading the bar as a notice about the page.
 */
.draftbar {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  margin-top: 12px; padding: 9px 12px;
  background: var(--warn-face); border: 1px solid var(--amber-edge); border-bottom: 0;
  border-radius: var(--r-sm) var(--r-sm) 0 0;
}
.draftbar > span:first-child { flex: 1; min-width: 0; }
.draftbar strong { display: block; font-size: 13.5px; color: var(--warn-ink); }
.draftbar .note { display: block; margin: 1px 0 0; color: var(--warn-ink); opacity: 0.8; }
.draftbar + textarea { border-top-left-radius: 0; border-top-right-radius: 0; border-color: var(--amber-edge); }

/*
 * Work that has not been saved, said where it cannot be missed.
 *
 * Sticky to the top of the scrolling pane rather than the page, so it is still there after
 * scrolling through a long form — and it carries both answers, because a warning with no
 * way to act on it is just an alarm.
 */
.unsaved {
  position: sticky; top: 0; z-index: 30;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  margin: -8px 0 18px; padding: 11px 14px;
  background: var(--bad-face); border: 1px solid var(--bad-ink); border-radius: var(--r-sm);
  box-shadow: 0 6px 18px rgba(18, 48, 44, 0.08);
}
.unsaved > span:first-child { flex: 1; min-width: 0; }
.unsaved strong { display: block; font-size: 14px; color: var(--bad-ink); }
.unsaved .note { display: block; margin: 1px 0 0; color: var(--bad-ink); opacity: 0.75; }
.unsaved button { background: var(--bad-ink); }
.unsaved button.ghost { background: none; color: var(--bad-ink); border-color: var(--bad-ink); }

/* What this page is about, before its title: the instance rather than a workspace. */
.badge {
  display: inline-block; background: var(--amber); color: var(--ink); border-radius: var(--r-full);
  padding: 5px 13px; margin-bottom: 16px;
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.04em;
}
/* A record rather than a decision: spent codes stay listed and stop competing for the eye. */
tr.done td { opacity: 0.45; }
/* A button that is really a word in a sentence — Show, Hide, Copy. */
.linkish {
  background: none; border: 0; padding: 0; color: var(--moss); font: inherit; font-size: 12px;
  text-decoration: underline; cursor: pointer;
}
/* A code is read off one screen and typed into another, so it is spaced to be read. */
.codeinput { font-family: ui-monospace, SFMono-Regular, monospace; letter-spacing: 0.06em; }
.pill.warn { background: var(--warn-face); color: var(--warn-ink); }
.pill.bad { background: var(--bad-face); color: var(--bad-ink); }
.err { background: var(--bad-face); color: var(--bad-ink); border-radius: var(--r-sm); padding: 10px 12px; font-size: 14px; }

/*
 * Connectors: a card per channel, a row per connection.
 *
 * The vocabulary is deliberately small — a dot for live or not, a flag for the card's
 * state, a row that holds a name, its numbers and its buttons — because five connectors
 * that each invented their own layout is what this replaced.
 */
/*
 * One row's share of a total, as a bar.
 *
 * Beside the percentage rather than instead of it: the bar is what makes a column of shares
 * comparable at a glance, and the number is for the one row somebody wants to read out.
 * Marked aria-hidden where it is used, since the figure next to it already says this.
 */
.sharebar {
  display: inline-block; vertical-align: middle; width: 56px; height: 6px;
  background: var(--line); border-radius: var(--r-full); overflow: hidden;
}
.sharebar span { display: block; height: 100%; background: var(--moss); border-radius: var(--r-full); }

.dot { display: inline-block; width: 8px; height: 8px; border-radius: var(--r-full); margin-right: 8px; flex: none; }
.dot.on { background: var(--moss); }
.dot.off { background: var(--edge); }
/* Typed but not written down, on a tab that is not the one being looked at. Red, matching
   the unsaved bar on the chatbot page, because it means the same thing. */
.tabstrip .dot { width: 6px; height: 6px; margin: 0 0 0 6px; background: var(--bad-ink); vertical-align: middle; }
.flag {
  margin-left: 8px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.04em; color: var(--smoke);
  border: 1px solid var(--edge); border-radius: var(--r-full); padding: 1px 7px; white-space: nowrap;
}
/* Mark and name on one line, the mark holding its size in a flex row. */
.chline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
/*
 * A chat box that takes files: what is about to go with the message, and where to drop one.
 *
 * The drop target is the composer rather than the textarea because that is what somebody
 * aims at, and the dashed outline only appears mid-drag — a box permanently advertising that
 * it accepts files is noise in a thing people type into all day.
 */
.composer { border: 1px dashed transparent; border-radius: var(--r-sm); margin: -6px; padding: 6px; }
.composer.dragging { border-color: var(--ink); background: var(--sand); }
.chline.attached { margin-bottom: 8px; }
.chline.attached .pill { padding-left: 6px; }
/* Small enough to sit in a chip, square so five screenshots line up rather than stagger. */
.chipthumb { width: 20px; height: 20px; border-radius: 3px; object-fit: cover; margin-right: 6px; vertical-align: middle; }
/* On a sent turn, the same ceiling the inbox puts on an image in a bubble. */
.bubble .sentimg { display: block; max-width: 100%; max-height: 220px; border-radius: var(--r-sm); margin-top: 8px; }
.chicon { flex: none; vertical-align: -2px; }
/* Each channel's own brand mark, darkened to sit on parchment without glaring. */
.src-web { --src: var(--moss); }
.src-email { --src: var(--smoke); }
.src-gmail { --src: #d93025; }
.src-outlook { --src: #5c2d91; }
/*
 * Two WhatsApps, two colours.
 *
 * Both connectors are the same whatsapp channel, so a thread on a linked handset and one
 * on the Business API used to be the same green — and the two are answered differently:
 * Business threads may also be live in somebody else’s inbox. Plum is far enough from the
 * green to read at a glance, and is already in the palette above.
 */
.src-whatsapp { --src: #128c7e; }
.src-whatsapp_cloud { --src: #7c3f6b; }
.src-telegram { --src: #229ed9; }
.src-linkedin { --src: #0a66c2; }
.src-instagram { --src: #c13584; }
.src-discord { --src: #5865f2; }
/* Messenger's blue rather than the Page's: what a workspace connects is an inbox. */
.src-facebook { --src: #0084ff; }
/* TikTok's mark is black, and ink is as near as parchment takes without glaring. */
.src-tiktok { --src: var(--ink); }
.src-x, .src-other, .src-phone { --src: var(--smoke); }
.src-website { --src: var(--moss); }
/* A credential and its buttons: the field takes the room, the buttons keep their size. */
.secret { max-width: 560px; flex-wrap: nowrap; }
.secret input {
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px;
  /* Dots are wider than characters; this keeps the box from growing when it is hidden. */
  letter-spacing: 0.02em;
}
.secret button { flex: none; }

/* A checkbox with its explanation beside it, not under it. */
label.check { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; margin: 0; cursor: pointer; }
label.check input { width: auto; flex: none; margin-top: 3px; accent-color: var(--ink); }
label.check strong { font-size: 14px; font-weight: 500; color: var(--ink); }
/* A linked connection and its buttons. The text must never be squeezed to one word per
   line, so it keeps a floor width and the buttons drop below it instead. */
.acctrow { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; padding: 12px 0; border-top: 1px solid var(--line); }
.acctwho { flex: 1 1 240px; min-width: 0; }
.acctactions { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
.acctactions button { padding: 6px 12px; font-size: 13px; }
button.danger { background: none; color: var(--bad-ink); border: 1px solid var(--edge); }
code {
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px;
  background: var(--sand); padding: 2px 6px; border-radius: var(--r-sm); word-break: break-all;
}
/* A result of the last thing that happened, at the top of the page. */
.card.banner { border-color: var(--ink); }
.card.banner.bad { border-color: var(--bad-ink); }

/* ---------------------------------------------------------------- chatbots */

/* A link that is a button. Same box, no underline, so the two can sit side by side. */
a.button {
  display: inline-block; border-radius: var(--r-sm); padding: 9px 16px; font-size: 15px; font-weight: 500;
  text-decoration: none; white-space: nowrap; border: 1px solid var(--edge); color: var(--ink);
}
a.button.small, button.small { padding: 5px 10px; font-size: 13px; }
a.button.primary, button.primary { background: var(--ink); color: var(--white); border-color: var(--ink); }

/* Three across, and honestly three: auto-fit would stretch a lone card the full width. */
.cards { display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 8px; }

/* One knowledge base. The name is the target — the whole card being a link would swallow
   the buttons under it. */
.basecard .baselink {
  display: block; font-size: 17px; font-weight: 600; letter-spacing: -0.015em;
  color: var(--ink); text-decoration: none; overflow-wrap: anywhere;
}
.basecard .baselink:hover { color: var(--moss); }
.basecard .desc { margin: 4px 0 14px; min-height: 34px; }
.basecard .counts { gap: 18px; margin-bottom: 6px; font-size: 13px; color: var(--smoke); }
.basecard .counts strong { font-size: 20px; color: var(--ink); font-variant-numeric: tabular-nums; margin-right: 4px; }
@media (max-width: 1100px) { .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .cards { grid-template-columns: 1fr; } }

.botcard { display: flex; flex-direction: column; gap: 10px; }
.botcard .botname { font-size: 17px; font-weight: 600; color: var(--ink); text-decoration: none; }
.botcard .botname:hover { text-decoration: underline; }
.botcard .desc { margin: 0; min-height: 2.6em; }
/* Facts as a definition list: label above value, so nothing has to line up across cards. */
.botcard dl.facts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 0; }
.botcard dl.facts dt {
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--smoke); margin-bottom: 2px;
}
.botcard dl.facts dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.botcard .mono, .review .mono { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12.5px; }
.botcard .cardfoot { margin-top: auto; padding-top: 10px; border-top: 1px solid var(--line); }
/*
 * A bot card in the playground picker, where the whole card is the link.
 *
 * There is exactly one thing to do with a bot here, so asking somebody to aim at a button
 * inside the card would be giving them a target with no competition. It borrows .botcard's
 * shape and only has to undo the anchor: no underline, inherited colour, and a border that
 * answers the pointer so it reads as pressable rather than as a panel that happens to move.
 */
.botcard.pickbot { text-decoration: none; color: inherit; transition: border-color .12s, box-shadow .12s; }
.botcard.pickbot:hover { border-color: var(--ink); box-shadow: 0 2px 10px rgba(0,0,0,.06); }
.botcard.pickbot .go { margin-top: auto; padding-top: 10px; font-size: 13px; font-weight: 500; color: var(--moss); }
/* A proposed wording, offered under the answer it would replace. Set apart so it reads as an
   offer rather than as more of the example. */
.suggestion { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--sand); }

.card.empty { text-align: center; padding: 44px 24px; max-width: 520px; margin: 8px auto 0; }
.card.empty p { margin: 6px auto 0; max-width: 42ch; }

/*
 * The step rail.
 *
 * A row of targets with a line behind them, so where you are is visible at a glance and
 * every step is one click away. Scrolls sideways rather than wrapping: a stepper that
 * reflows onto two rows stops reading as a sequence.
 */
ol.steps {
  display: flex; gap: 6px; list-style: none; margin: 18px 0; padding: 0 0 4px;
  overflow-x: auto; scrollbar-width: thin;
}
ol.steps li { flex: 1 1 0; min-width: 150px; }
ol.steps li button {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  background: none; border: 0; border-top: 2px solid var(--line);
  padding: 10px 8px 0; color: var(--smoke); font: inherit; cursor: pointer;
}
ol.steps li.done button { border-top-color: var(--moss); }
ol.steps li.on button { border-top-color: var(--ink); color: var(--ink); }
ol.steps .dot {
  flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
  background: var(--line); color: var(--smoke); font-size: 11px; font-weight: 600;
}
ol.steps li.done .dot { background: var(--ok-face); color: var(--ok-ink); }
ol.steps li.on .dot { background: var(--ink); color: var(--white); }
ol.steps .what { min-width: 0; }
ol.steps .what strong { display: block; font-size: 13px; font-weight: 600; }
ol.steps .what .note { display: block; font-size: 11.5px; line-height: 1.3; }

/* One section at a time, with room to breathe — the fix for a wall of stacked inputs. */
.card.sectioncard { padding: 26px 28px; }
/*
 * A split brings its own two cards, so the card it is dropped into stops being one —
 * otherwise every settings tab is a panel inside a panel inside a page, and its 28px of
 * padding pushed the whole thing out of line with the tab strip above it.
 *
 * Three classes deep on purpose: at two it tied with the rule above and lost to source
 * order, which is exactly how it came back without anybody changing it.
 */
.card.sectioncard:has(> .subsplit) { background: none; border: 0; padding: 0; }
.fieldset { display: grid; gap: 22px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.field.wide { grid-column: 1 / -1; }
.field label { margin-bottom: 6px; }
.field .note { margin: 6px 0 0; max-width: 60ch; }

/* A radio pair rendered as two cards, because the choice deserves more than a dot. */
.choices { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.choice {
  display: flex; gap: 10px; align-items: flex-start; margin: 0; font-weight: 400;
  border: 1px solid var(--edge); border-radius: var(--r-md); padding: 14px; cursor: pointer;
}
.choice.on { border-color: var(--ink); background: var(--sand); }
.choice input { width: auto; margin-top: 3px; }
.choice strong { display: block; font-size: 14px; color: var(--ink); }
.choice .note { display: block; margin-top: 2px; }

.picker { margin-top: 14px; border: 1px solid var(--line); border-radius: var(--r-md); max-height: 320px; overflow-y: auto; }
.pick {
  display: flex; gap: 10px; align-items: flex-start; margin: 0; font-weight: 400; cursor: pointer;
  padding: 11px 14px; border-bottom: 1px solid var(--line); color: var(--ink); font-size: 14px;
}
.pick:last-child { border-bottom: 0; }
.pick:hover { background: var(--sand); }
.pick input { width: auto; margin-top: 3px; }
.pick .note { display: block; }
/* A row that holds a tick *and* a button: the label takes the space, the button sits at
   the end and keeps its size. */
.pick:has(> .pickmain) { align-items: center; gap: 12px; }
.pickmain { display: flex; gap: 10px; align-items: flex-start; flex: 1; min-width: 0; cursor: pointer; }
.pickmain > input { flex: none; }
/* min-width:0 on every ancestor, or the ellipsis never happens — a flex item's default
   min-width is its content, so the row grows instead of the text being cut. */
.pickmain .what { display: block; flex: 1; min-width: 0; }
.pick .line { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick .what strong { font-size: 14px; font-weight: 500; color: var(--ink); }
.pick .what .meta { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; opacity: 0.75; }
/* Absent rather than empty, and it should read as absent. */
.pick .what .dim { font-style: italic; opacity: 0.7; }
.pick.resource > button { flex: none; }
.pick.editing { display: block; cursor: default; background: var(--sand); padding: 14px; }
.pick.editing:hover { background: var(--sand); }
.pick.editing .field { margin-bottom: 10px; }
.pick.editing input { width: 100%; margin-top: 0; }
.pick.editing .note { margin: 4px 0 0; }
.mono { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }

/* Put away, not gone: readable, and visibly not one of the ones running. */
tr.click.archived > td { opacity: 0.62; }

/*
 * The project's name, edited in place.
 *
 * Sized and weighted like the h1 it replaces, with no border until it is reached for — so it
 * reads as a heading and behaves as a field, which is the entire point of not having a modal.
 */
.titleinput, .subinput {
  width: 100%; padding: 2px 6px; margin-left: -6px;
  background: none; border: 1px solid transparent; border-radius: var(--r-sm);
}
.titleinput { font-size: 30px; font-weight: 500; line-height: 1.2; letter-spacing: -0.02em; }
/* Clipped rather than cut off mid-letter when it is longer than the box and not being
   edited. Focus scrolls it normally. */
.subinput { font-size: 15px; color: var(--smoke); text-overflow: ellipsis; }
.subinput:focus { text-overflow: clip; }
@media (max-width: 640px) {
  .titleinput { font-size: 24px; }
  .tabstrip { width: 100%; margin: 10px 0 12px; }
  .seg.tabstrip button { margin-right: 14px; }
}
/* The name takes the room, and what you can do to the whole board sits at the end of it. */
.titlerow { display: flex; align-items: center; gap: 4px; }
.titlerow .titleinput { flex: 1; min-width: 0; }
.titlerow .titlebtn {
  flex: none; display: grid; place-items: center; width: 32px; height: 32px; padding: 0;
  color: var(--smoke); border-color: transparent;
}
.titlerow .titlebtn:hover:not(:disabled) { color: var(--ink); border-color: var(--edge); }
.titlerow .titlebtn.bad:hover:not(:disabled) { color: var(--bad-ink); border-color: var(--bad-ink); background: var(--bad-face); }
/* Already archived: the button is the state as much as the action. */
.titlerow .titlebtn.on { color: var(--warn-ink); background: var(--warn-face); border-color: var(--amber-edge); }

/*
 * Every move on a board, as rows rather than a table.
 *
 * Five columns, one of them a sentence, do not fit across a phone — and a table that
 * overflows makes somebody drag the page sideways to find out who did what. Grid, so the
 * same markup is a row of columns on a screen wide enough for it and a small stacked block
 * where it is not.
 */
.movelist { margin-top: 12px; }
.moverow {
  display: grid; gap: 4px 14px; align-items: baseline; padding: 11px 2px;
  grid-template-columns: 160px minmax(110px, 1fr) minmax(150px, auto) 90px minmax(0, 2fr);
  border-bottom: 1px solid var(--line);
}
.moverow:last-child { border-bottom: 0; }
.moverow.head {
  padding: 0 2px 8px; border-bottom-color: var(--edge);
  font-size: 12px; font-weight: 500; color: var(--smoke);
}
.moverow .when { font-variant-numeric: tabular-nums; }
.moverow .what { font-size: 13.5px; }
.moverow .what .pill { margin-left: 6px; font-size: 11px; }
.moverow .why { overflow-wrap: anywhere; }
.moverow .note { margin: 0; }

@media (max-width: 760px) {
  /* One block per move: what happened, then who and when under it. The head row is a table
     heading with no table left to head. */
  .moverow.head { display: none; }
  .moverow { grid-template-columns: 1fr; gap: 2px; padding: 12px 2px; }
  .moverow .what { order: 1; font-size: 14px; }
  .moverow .who { order: 2; }
  .moverow .why { order: 3; }
  .moverow .when { order: 4; }
  .moverow .by { order: 4; display: inline; }
  /* When and who-moved-it read as one line rather than two half-empty ones. */
  .moverow .when::after { content: ' · '; }
  .moverow .when, .moverow .by { display: inline; }
}

.titleinput:hover, .subinput:hover { border-color: var(--line); }
.titleinput:focus, .subinput:focus { background: var(--white); border-color: var(--edge); outline: none; }

/*
 * Tabs, as text with a line under the current one.
 *
 * They were segmented buttons — a bordered box with a filled dark pill in it — which is the
 * right weight for a control that *does* something (live / paused, day / week / month) and
 * far too much for one that only says which of three things you are looking at. Two of them
 * stacked, one inside the other, read as a toolbar rather than as a place in the page.
 *
 * Same markup, so nothing needed rewriting: .seg on its own is still the segmented
 * control, and these two modifiers turn it into a row of tabs.
 */
.seg.tabstrip, .seg.small {
  border: 0; border-radius: 0; border-bottom: 1px solid var(--line);
  gap: 2px; overflow: visible;
}
.seg.tabstrip button, .seg.small button {
  border: 0; border-radius: 0; background: none; padding: 7px 2px; margin-right: 18px;
  color: var(--smoke); font-size: 14px;
  /* The line sits on the button, and is transparent until it is the one you are on, so
     nothing moves by a pixel when the selection changes. */
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.seg.small { margin-bottom: 12px; }
.seg.small button { font-size: 13px; margin-right: 14px; }
.seg.tabstrip button:hover, .seg.small button:hover { background: none; color: var(--ink); }
.seg.tabstrip button.on, .seg.small button.on {
  background: none; color: var(--ink); font-weight: 600; border-bottom-color: var(--ink);
}
.seg.tabstrip button:last-child, .seg.small button:last-child { margin-right: 0; }

.tabstrip { margin: 12px 0 14px; align-self: flex-start; }

/* ---------------------------------------------------------------- calendar */

.calendar { display: flex; flex-direction: column; min-height: 0; flex: 1; }
/*
 * Two groups, each of which wraps as a unit.
 *
 * It used to be six loose children in a flex row, so a narrow screen broke it wherever it
 * happened to run out of width — leaving a lone "‹" on one line and the month on the next.
 */
.calbar { align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.calnav { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
.callabel { font-size: 15px; text-align: center; white-space: nowrap; }
.caldue { margin-left: auto; white-space: nowrap; }

@media (max-width: 640px) {
  /* The view picker takes the line; the month and its arrows take the next. */
  .calbar > .seg { width: 100%; }
  .calbar > .seg button { flex: 1; }
  .callabel { flex: 1; font-size: 14px; }
  .caldue { flex-basis: 100%; margin-left: 0; text-align: right; }
}

/*
 * Seven columns, whatever the view. A week and a month differ only in how many rows they
 * have, so they share a grid and the row height is what changes.
 */
.calgrid {
  flex: 1; min-height: 0; overflow-y: auto;
  display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 1px;
  background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md);
}
.calhead {
  background: var(--white); padding: 8px 10px; font-size: 12px; color: var(--smoke);
  position: sticky; top: 0; z-index: 1;
}
.calday {
  background: var(--white); padding: 6px; min-height: 96px;
  display: flex; flex-direction: column; gap: 3px;
}
.calgrid.week .calday { min-height: 320px; }
/* The days either side of the month, faded. Without them the first falls in the wrong column. */
.calday.outside { background: var(--sand); }
.calday.outside .calnum { color: var(--smoke); }
.calday.today { box-shadow: inset 0 0 0 2px var(--moss); }
/* A whole day is the tap target, so it has to carry a button's reset and say it is one. */
button.calday {
  width: 100%; text-align: left; font: inherit; color: inherit;
  border: 0; cursor: pointer; appearance: none;
  /* A button gets align-items: center from the browser, which shrink-wraps every entry
     inside it to a sliver. The day was a div until it became a tap target. */
  align-items: stretch;
}
button.calday:hover { background: var(--sand); }
button.calday.outside:hover { background: var(--line); }
button.calday:focus-visible { outline: 2px solid var(--moss); outline-offset: -2px; }

/* One thing on the day, in the day's dialog. */
.dayitem {
  display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  padding: 11px 2px; background: none; border: 0; border-bottom: 1px solid var(--line);
  font: inherit; color: var(--ink); cursor: pointer;
}
.dayitem:last-child { border-bottom: 0; }
.dayitem:hover { background: var(--sand); }
.dayitem .what { flex: 1; min-width: 0; }
.dayitem .what b { display: block; font-size: 14px; font-weight: 500; }
.dayitem .what small { display: block; font-size: 12.5px; color: var(--smoke); overflow-wrap: anywhere; }

/* A row that opens something, rather than a row with buttons on it. */
.pricerow.rowbutton {
  width: 100%; text-align: left; background: none; border: 0;
  border-bottom: 1px solid var(--line); font: inherit; color: var(--ink); cursor: pointer;
}
.pricerow.rowbutton:hover { background: var(--sand); }

.factlist { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 6px 14px; margin: 14px 0 4px; }
.factlist dt { font-size: 12.5px; color: var(--smoke); }
.factlist dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }

/* The same log, in a dialog that has no room for five columns. */
.movelist.tight .moverow { grid-template-columns: 150px 84px 100px minmax(0, 1fr); padding: 9px 2px; }
.calnum {
  align-self: flex-start; padding: 1px 6px; min-width: 24px;
  background: none; border: 0; border-radius: var(--r-full);
  font: inherit; font-size: 13px; font-variant-numeric: tabular-nums; color: var(--ink); cursor: pointer;
}
.calnum:hover { background: var(--sand); }
.calday.today .calnum { font-weight: 600; color: var(--moss); }

.calentry {
  display: flex; gap: 5px; align-items: baseline;
  padding: 3px 6px; border-radius: 5px; font-size: 12.5px;
  text-decoration: none; color: var(--ink); overflow: hidden;
}
.calentry .calwho { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/*
 * How many more dates sit in this exact slot. Folded rather than merged: two courses really
 * can run the same days at the same hours, so the count opens the day rather than deciding.
 */
.calentry .calmore {
  flex: none; margin-left: auto; font-style: normal; font-size: 11px; font-weight: 600;
  opacity: 0.6; font-variant-numeric: tabular-nums;
}
.calentry b { font-variant-numeric: tabular-nums; font-weight: 500; }
/*
 * Dates sharing a slot, boxed with the buttons that act on them.
 *
 * A loose row of "Keep" buttons under a flat list gives no clue which dates any of them would
 * remove. The border is doing the explaining.
 */
.slotgroup {
  border: 1px solid var(--edge); border-radius: var(--r-md);
  padding: 12px; margin: 10px 0; background: var(--sand);
}
.slotgroup > header { margin-bottom: 8px; }
.slotgroup > header b { display: block; font-size: 14px; }
.slotgroup > header small { display: block; margin-top: 2px; max-width: 64ch; }
/* On the group's own ground rather than the sheet's, so the box reads as one thing. */
.slotgroup .dayitem { background: var(--white); }
.slotkeep { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
/* The offer to break a span into its days, beside the explanation of why you might. */
.splitnote {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  margin: 14px 0 0; padding: 10px 12px; background: var(--sand); border-radius: var(--r-sm);
}
/* The two kinds are different commitments — a slot somebody agreed to, and a follow-up
   somebody owes — so they do not look the same. */
.calentry.booking { background: var(--ok-face); color: var(--ok-ink); }
.calentry.next-action { background: var(--sand); }
/* The customer own availability, a different sort of fact from a commitment we made: away
   reads as a block, free as an opening, a preference as neither. */
.calentry.away { background: var(--bad-face); color: var(--bad-ink); }
.calentry.free { background: var(--ok-face); color: var(--ok-ink); opacity: 0.8; }
.calentry.prefer, .calentry.other { background: var(--sand); color: var(--smoke); }
.calentry:hover { filter: brightness(0.97); }

.dayfeed { display: flex; flex-direction: column; gap: 6px; }
.dayfeed .calentry { padding: 8px 10px; font-size: 14px; }

/* ---------------------------------------------------------------- assigned */

.botrows { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
/*
 * Wraps rather than squeezes.
 *
 * The name and description were sharing a row with a pill, two counts and a button, so on a
 * phone the description got about ten characters of width and ran down the card in a column
 * one word wide. Given a whole line of its own it reads; the rest follows underneath.
 */
.botrow {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px;
  padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-sm);
}
.botrow .botmain { flex: 1 1 240px; min-width: 0; }
.botrow > button { margin-left: auto; }

@media (max-width: 640px) {
  .botrow .botmain { flex-basis: 100%; }
  .botrow > button { margin-left: auto; }
  .calday { min-height: 58px; padding: 4px; }
  /* A name is unreadable in a seventh of a phone, so a month cell shows that something is
     there and the day view says what. Week and day still name them. */
  .calgrid.month .calentry { font-size: 0; gap: 0; padding: 0; height: 9px; border-radius: var(--r-full); }
  .calgrid.month .calentry small { display: none; }
  .calgrid.month .calentry b { display: none; }
  .calgrid.week .calday { min-height: 220px; }
}


.stagelist { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
.stagerow { display: flex; gap: 8px; align-items: center; }
.stagerow > input { flex: 1; min-width: 0; }

/* The two on a column: quiet until the column is under the cursor, then obvious. */
.lane > header .lanecog {
  flex: none; padding: 2px 7px; line-height: 1.2; border-color: transparent;
  color: var(--smoke); opacity: 0.5; transition: opacity 0.12s;
}
.lane:hover > header .lanecog, .lane > header .lanecog:focus-visible { opacity: 1; border-color: var(--edge); }
.lane > header .lanecog.bad:hover { color: var(--bad-ink); border-color: var(--bad-ink); background: var(--bad-face); }



/* What happens once a bot is pointed at a board. A list, because it is three steps. */
.boardsteps { margin: 8px 0 0; padding-left: 18px; max-width: 62ch; }
.boardsteps li { margin-bottom: 3px; }

/* The facts on an opened card: label above value, wrapping into columns. */
.cardfacts {
  display: grid; gap: 10px 22px; margin: 0 0 12px;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
}
.cardfacts dt { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1px; }
.cardfacts dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }

/* Training: rows waiting on a decision. Wider than a table row because each one is a
   question, an answer and the reason to think twice about it. */
/* An example already in use: no tick, and a way back out of it. */
/* Inside a form section the bar is not the page header, so it does not stick. */
/* The inbox narrowed to one bot, and the way back out of it. */
.botfilter { display: flex; gap: 8px; align-items: baseline; margin: 0 0 10px; }
.botfilter strong { color: var(--ink); }

/* How a bot runs: three states and a switch, in the page header. */
.runmode { max-width: 340px; text-align: right; }
.runmode .note { display: block; margin: 6px 0 0; }
.runmode label.switch { text-align: left; }
/* A segmented control. Three buttons in one box, so they read as one choice rather than
   three things that could each be on. */
.seg { display: inline-flex; border: 1px solid var(--edge); border-radius: var(--r-sm); overflow: hidden; }
.seg button {
  background: none; color: var(--smoke); border: 0; border-right: 1px solid var(--line);
  border-radius: 0; padding: 6px 14px; font-size: 13px; font-weight: 500;
}
.seg button:last-child { border-right: 0; }
.seg button:hover { background: var(--sand); color: var(--ink); }
.seg button.on { background: var(--ink); color: var(--white); }

/* A checkbox whose label is a sentence, not a word. */
label.switch { display: flex; gap: 10px; align-items: flex-start; margin: 0; font-weight: 400; cursor: pointer; }
label.switch input { width: auto; margin-top: 3px; }
label.switch strong { display: block; font-size: 14px; color: var(--ink); }
label.switch .note { display: block; margin-top: 2px; max-width: 52ch; }

.addresource {
  margin-top: 14px; padding: 14px; border: 1px dashed var(--edge); border-radius: var(--r-md);
}
.addresource .field { margin-top: 12px; }
.pick.allpick { background: var(--sand); font-weight: 500; }
.wizardfoot { margin-top: 18px; }
.review { display: grid; gap: 14px; margin: 0; }
.review dt {
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--smoke); margin-bottom: 3px;
}
.review dd { margin: 0; font-size: 15px; overflow-wrap: anywhere; }

/* One conversation, read back. */
.thread { margin-top: 14px; display: flex; flex-direction: column; gap: 12px; }
.thread .msg { border-left: 3px solid var(--line); padding-left: 12px; }
.thread .msg.out { border-left-color: var(--moss); }
.thread .msg p { margin: 3px 0 0; font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.thread .cites { margin-top: 6px; }

/* The dialogs every connector adds and configures through. */
.backdrop {
  position: fixed; inset: 0; background: rgba(23, 23, 23, .42); z-index: 20;
  display: flex; align-items: flex-start; justify-content: center; padding: 8vh 24px 24px;
}
.modal {
  background: var(--white); border: 1px solid var(--line); border-radius: var(--r-md); padding: 24px;
  width: min(680px, 100%); max-height: 82vh; overflow: auto;
  box-shadow: 0 18px 60px rgba(0,0,0,.22);
}
.modalhead { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 20px; }
.modalhead > div { flex: 1; }
.modalhead button { padding: 6px 12px; }
.modal h4 { font-size: 13px; font-weight: 600; margin: 0 0 6px; }
.modal ol { padding-left: 20px; color: var(--smoke); font-size: 13.5px; }
.modal ol li { margin-bottom: 6px; }
.modal ol li b { color: var(--ink); font-weight: 500; }

/*
 * The inbox: a list of threads beside the one being read.
 *
 * Each pane scrolls itself, so reading a long conversation never scrolls the list of
 * conversations out from under the person reading it.
 */
/*
 * A page that owns its height.
 *
 * The inbox is a workspace, not a document: the list of conversations must not scroll away
 * while somebody reads one, and the composer must not be somewhere below the fold. So the
 * page fills the frame exactly and every scrollbar inside it belongs to a pane.
 *
 * min-height: 0 on each link of the chain is what actually makes this work — a flex child
 * defaults to min-content, so without it the panes grow to fit their contents and push the
 * page taller instead of scrolling inside themselves.
 */
main:has(> .page > .fullheight) { overflow: hidden; }
.page:has(> .fullheight) { height: 100%; min-height: 0; display: flex; flex-direction: column; padding-bottom: 24px; }
.fullheight { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.fullheight .inboxsplit { flex: 1; min-height: 0; }
.fullheight .inboxsplit > * { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.inboxsplit { display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: 10px; align-items: start; }

/* The column that chooses a conversation: title, counts, filters, then the list. */
.inboxside { gap: 8px; }
.inboxside h1 { font-size: 26px; margin: 0; }
/*
 * Filters as chips: one row each, small enough that four of them fit a narrow column.
 * Buttons at button size wrapped into four lines and read as four decisions rather than
 * one row of options.
 */
/*
 * A row of them carries its own spacing, above and below.
 *
 * Two of these stacked — the status chips and the channel marks — sat against each other and
 * against the list underneath, so three separate controls read as one block of pills with no
 * edges. Spacing here rather than at each call site, because every one of them wanted it.
 */
.filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.filters + .filters { margin-top: -2px; }
/* Unless it is riding inside a row, where the row owns the spacing and a margin would
   only push it out of line with what it sits beside. */
.row > .filters { margin-bottom: 0; }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  background: none; color: var(--ink); border: 1px solid var(--edge); border-radius: var(--r-full);
  padding: 5px 12px; font: inherit; font-size: 13px; font-weight: 500; line-height: 1.5; cursor: pointer;
}
.chip:hover { background: var(--sand); }
.chip.on { background: var(--ink); color: var(--white); border-color: var(--ink); }
/* The count rides inside the chip, muted, so the row says how much of each there is. */
.chip b { font-weight: 500; font-variant-numeric: tabular-nums; opacity: 0.55; }
.chip.on b { opacity: 0.7; }
/* A channel chip is its mark and nothing else; the brand colour is the label. */
.chip.mark { padding: 5px 9px; }
.chip.mark.on .chicon { color: var(--white); }
/* The list is whatever height is left after the controls above it. */
/* The heading is not one of the controls under it. */
.inboxside > h1 { margin-bottom: 14px; }
.inboxside > .card { flex: 1; min-height: 0; padding: 0; overflow: hidden; display: flex; flex-direction: column; }
.threadlist { flex: 1; min-height: 0; overflow-y: auto; }
.threadrow {
  display: block; width: 100%; text-align: left; background: none; color: var(--ink);
  border: 0; border-bottom: 1px solid var(--line); border-radius: 0;
  /* The channel's colour as a strip, replacing padding rather than adding to it. */
  border-left: 4px solid var(--src, transparent); padding: 12px 14px 12px 10px;
  font: inherit; font-size: 14px; font-weight: 400; cursor: pointer;
}
.threadrow:hover { background: var(--sand); }
.threadrow.on { background: var(--line); }
.msgs { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 4px; }
.watermark { display: flex; align-items: center; gap: 8px; color: var(--smoke); font-size: 11px; text-align: center; }
.watermark::before, .watermark::after { content: ''; flex: 1; border-top: 1px solid var(--line); }
.watermark { display: flex; align-items: center; gap: 8px; color: var(--smoke); font-size: 11px; text-align: center; }
.watermark::before, .watermark::after { content: ''; flex: 1; border-top: 1px solid var(--line); }
.bubble {
  max-width: 78%; padding: 9px 12px; border-radius: 12px; font-size: 14px; line-height: 1.45;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
/* Them on the left, us on the right — the way it reads in every messaging app. */
.bubble.in { align-self: flex-start; background: var(--sand); border: 1px solid var(--line); border-bottom-left-radius: 3px; }
.bubble.out { align-self: flex-end; background: var(--ink); color: var(--white); border-bottom-right-radius: 3px; }
.bubble small { display: block; opacity: 0.7; font-size: 11px; margin-top: 4px; }
/*
 * A file inside a bubble.
 *
 * An image is its own thumbnail. Everything else is a card: a short uppercase extension
 * rather than an icon set — legible at any size, no assets to ship, and never wrong about
 * a format nobody anticipated.
 */
/*
 * A button rather than a link now, because opening it shows a sheet over the thread instead
 * of leaving for a new tab — so the browser's own button paint has to come off: its
 * background, its font, and the text alignment it centres by default.
 */
.bubble .file {
  display: flex; align-items: center; gap: 10px; margin-top: 8px; width: 100%;
  color: inherit; text-decoration: none; text-align: left; font: inherit; background: none;
  cursor: pointer;
  border: 1px solid currentColor; border-radius: var(--r-sm); padding: 8px 10px; opacity: 0.9;
}
.bubble .file:hover { opacity: 1; }
.bubble .filekind {
  flex: none; display: grid; place-items: center; width: 38px; height: 38px;
  border-radius: var(--r-sm); background: currentColor; font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 10px; font-weight: 600; letter-spacing: 0.03em;
}
/*
 * The letters are knocked out of the block, so they read on either bubble colour.
 *
 * Both halves stated, which they were not: the base rule sets background to currentColor, so
 * setting only the colour made the block and its letters the same shade -- an ink square with
 * ink letters on the dark bubble, a white square with white letters on the light one. The
 * glyph was invisible in both, which is the one place it had to work.
 */
.bubble.out .filekind { background: var(--white); color: var(--ink); }
.bubble.in .filekind { background: var(--ink); color: var(--white); }
.bubble .filewho { min-width: 0; }
.bubble .filewho b { display: block; font-weight: 500; font-size: 13px; overflow-wrap: anywhere; }
.bubble .filewho small { display: block; opacity: 0.75; font-size: 11px; margin: 0; }
/* Its own thumbnail, and nothing around it. */
.bubble .file.image { display: block; border: 0; padding: 0; width: auto; }
.bubble .file.image img {
  display: block; max-width: 100%; max-height: 280px; border-radius: var(--r-sm);
}

/*
 * ---------------------------------------------------------------- picking days
 *
 * The same seven-column calgrid, with its own cell. A calday is a container for a day's
 * entries -- 96px tall, a flex column -- and a picker's cell holds one number and a pressed
 * state, so it borrows the grid and nothing else.
 */
.calgrid.picker { flex: none; max-height: none; }
button.calpick {
  background: var(--white); border: 0; padding: 10px 0; font: inherit; font-size: 13px;
  color: var(--ink); cursor: pointer; text-align: center; appearance: none;
}
.calgrid.picker .calhead { text-align: center; padding: 7px 0; }
button.calpick:hover { background: var(--sand); }
button.calpick.outside { color: var(--smoke); }
button.calpick[aria-pressed='true'] { background: var(--ink); color: var(--white); font-weight: 600; }
/* Today, when it is not picked: an outline rather than a fill, so the two never read alike. */
button.calpick.now:not([aria-pressed='true']) { box-shadow: inset 0 0 0 2px var(--moss); }
button.calpick:disabled { cursor: not-allowed; opacity: 0.45; }
.pickeddays { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.pickeddays .chip { padding-right: 6px; }
.pickeddays .chip button {
  background: none; border: 0; padding: 0 2px; font: inherit; color: inherit; cursor: pointer; opacity: 0.6;
}
.pickeddays .chip button:hover { opacity: 1; }

/*
 * ---------------------------------------------------------------- a message, as it lands
 *
 * The template preview's chat variant: the same bubble, dressed as the conversation it is
 * about to appear in.
 *
 * Worth the thirty lines because the question being asked of it is different. Everywhere
 * else a preview answers "what does this template say", and a grey box does that. On a flow
 * somebody is deciding whether a stranger's first impression of the company is right, and
 * that is a judgement about the thing on the phone -- the attachment above the text, the
 * width the lines break at, the buttons under it -- not about the words in isolation.
 *
 * WhatsApp's own outgoing green rather than the app's ink, for the same reason. Using the
 * product's palette here would be consistent and would quietly misrepresent the one screen
 * this is pretending to be.
 */
.wachat {
  border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden;
  background: #efe7dd;
  /* The faint pattern a real chat has, without shipping an asset for it. */
  background-image: radial-gradient(rgba(0, 0, 0, 0.045) 1px, transparent 1px);
  background-size: 18px 18px;
}
.wascroll { display: flex; flex-direction: column; padding: 16px 14px; max-height: 560px; overflow-y: auto; }
.bubble.wa {
  align-self: flex-end; max-width: 92%; background: #d9fdd3; color: #111b21;
  border-bottom-right-radius: 3px; box-shadow: 0 1px 1px rgba(0, 0, 0, 0.1);
  padding: 7px 9px 18px; position: relative;
}
.bubble.wa .note { color: #54656f; }
/* The time sits in the padding the bubble leaves for it, which is how the real one does it. */
.bubble.wa .wawhen {
  position: absolute; right: 10px; bottom: 5px; font-size: 11px; color: #667781;
}
/* The attachment above the text: a block inside the bubble, not a card beside it. */
.wadoc {
  display: flex; align-items: center; gap: 10px;
  background: rgba(0, 0, 0, 0.05); border-radius: 7px; padding: 10px; margin-bottom: 7px;
}
.wadoc .filekind {
  flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 6px;
  background: #ea4335; color: #fff;
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px; font-weight: 600;
}
.wadoc .filewho { min-width: 0; }
.wadoc .filewho b { display: block; font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.wadoc .filewho small { display: block; font-size: 11px; color: #667781; }
/* Quick replies: full width, separated by a hairline, the way WhatsApp stacks them. */
.wabtns { margin: 8px -9px -12px; border-top: 1px solid rgba(0, 0, 0, 0.08); }
.wabtns span {
  display: block; padding: 9px; text-align: center; font-size: 14px; color: #027eb5;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
}
.wabtns span:first-child { border-top: 0; }

/*
 * The form on the left, what it produces on the right.
 *
 * Sticky because the preview is the thing being judged and the form is longer than it: a
 * template with four placeholders scrolls the answer off the screen exactly when somebody is
 * typing the values that change it.
 */
.withpreview { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 420px); gap: 18px; align-items: start; }
.withpreview > .side { position: sticky; top: 16px; }
@media (max-width: 1000px) {
  .withpreview { grid-template-columns: 1fr; }
  .withpreview > .side { position: static; }
}

/* Known of, not held. Dashed, and it says so on the card. */
.bubble .file.gone { border-style: dashed; opacity: 0.65; cursor: default; }
@media (max-width: 900px) { .inboxsplit { grid-template-columns: 1fr; } }

/* The forms you can reach signed out: sign-in, registration, a new password. One card
   centred in the viewport. The landing has its own column — see .marketing. */
.authpage { min-height: 100%; display: grid; place-items: center; padding: 40px 20px; }
.authcard { width: 100%; max-width: 400px; }

/*
 * The landing.
 *
 * The one page that is read rather than worked in. .authpage centres a single object in
 * the viewport, which is right for a door and wrong for six sections of prose — so this is
 * the second bare-page layout, and the last one: a left-aligned column that scrolls like an
 * ordinary document. 760px is wider than a form and narrower than the app; wide enough for
 * a three-card row, short enough that a line of lede stays readable.
 *
 * main above is a fixed-height scroller, because inside the shell each pane scrolls
 * itself. Out here it is the document, and these two lines are what stop it becoming a
 * nested scroll box that fights the URL bar on a phone.
 */
main.marketing {
  max-width: 1080px; margin: 0 auto; padding: 56px 24px 96px;
  height: auto; overflow: visible;
}
/* Prose stays narrow inside a wide column. The page is wide because it carries pictures;
   a 1080px line of body copy would be unreadable and the pictures would have bought it. */
.marketing p.lede, .marketing .prose { max-width: 62ch; }
/* Section rhythm. h2 already carries 36px of its own; the two collapse and this wins, so a
   section sits further from the one above it than a heading does from its own body copy. */
.marketing > section + section { margin-top: 60px; }
.marketing footer { margin-top: 60px; padding-top: 22px; border-top: 1px solid var(--line); }
/* A form keeps a form's width wherever it sits — a 760px-wide box around one email field
   reads as a banner, which is exactly the thing this page is not. */
.marketing form.card, .marketing .joined { max-width: 460px; }
/*
 * The honeypot.
 *
 * Not display:none, which the bots worth stopping already check for. Taken out of the
 * layout, off the tab order and hidden from the accessibility tree instead, so it is
 * invisible to a person using the page by any means and ordinary to something filling in
 * every field it can find.
 */
.trap { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
/*
 * ---------------------------------------------------------------- the landing's pictures
 *
 * Every picture on this page is built from the same divs, hairlines and tokens as the app
 * itself, rather than being a screenshot. That is not cleverness for its own sake: a PNG
 * goes stale the day a screen changes, weighs more than the whole stylesheet, and cannot
 * be read by anything. These re-theme with the palette, cost nothing to ship, and are the
 * only honest way to show a product that does not have customers to photograph yet.
 *
 * All of it is scoped under .marketing, so nothing here can reach the app.
 */

/* A pane of the product, framed. The dots are the only skeuomorphic thing on the page and
   they are what makes the reader see "an application" without a caption saying so. */
.marketing .shot { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--white); overflow: hidden; }
.marketing .shot .bar { display: flex; align-items: center; gap: 6px; padding: 9px 12px; border-bottom: 1px solid var(--line); background: var(--sand); }
.marketing .shot .bar i { width: 8px; height: 8px; border-radius: var(--r-full); background: var(--edge); display: block; }
.marketing .shot .bar em { margin-left: 8px; font-style: normal; font-size: 12px; color: var(--smoke); }
.marketing .shot .panes { display: grid; grid-template-columns: 148px 1fr; min-height: 0; }
.marketing .shot .rail { border-right: 1px solid var(--line); padding: 12px 10px; background: var(--sand); }
.marketing .shot .rail b { display: block; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--smoke); margin: 12px 0 4px 8px; font-weight: 500; }
.marketing .shot .rail a { display: block; padding: 6px 8px; border-radius: var(--r-sm); font-size: 13px; color: var(--ink); text-decoration: none; }
.marketing .shot .rail a.on { background: var(--moss-face); color: var(--moss); font-weight: 500; }
.marketing .shot .pane { padding: 14px; min-width: 0; }

/* A list of things, hairline separated. Threads, sources, deals — same shape each time. */
.marketing .rows { display: grid; }
.marketing .rows > div { padding: 10px 2px; border-top: 1px solid var(--line); font-size: 13px; min-width: 0; }
.marketing .rows > div:first-child { border-top: 0; }
.marketing .rows .top { display: flex; align-items: baseline; gap: 8px; }
.marketing .rows .top strong { font-size: 13px; font-weight: 500; }
.marketing .rows .top span { margin-left: auto; font-size: 11px; color: var(--smoke); white-space: nowrap; }
.marketing .rows .sub { color: var(--smoke); font-size: 12px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* A conversation. Theirs on the left in the page's own surface, ours on the right in ink,
   which is the same rule the rest of the system runs on: ink is us acting. */
.marketing .talk { display: grid; gap: 8px; }
.marketing .talk .msg { max-width: 82%; padding: 9px 12px; border-radius: var(--r-md); font-size: 13px; line-height: 1.45; }
.marketing .talk .msg.them { background: var(--sand); border: 1px solid var(--line); }
.marketing .talk .msg.us { background: var(--ink); color: var(--white); margin-left: auto; }
.marketing .talk .msg cite { display: block; margin-top: 6px; font-style: normal; font-size: 11px; opacity: 0.72; }
.marketing .talk .who { font-size: 11px; color: var(--smoke); }

/* The numbered feature blocks, as on the deck: a rule, a number, the claim, the picture. */
.marketing .feat { border-left: 2px solid var(--ink); padding-left: 22px; }
.marketing .feat .no { font-size: 13px; font-weight: 600; letter-spacing: 0.06em; color: var(--moss); font-variant-numeric: tabular-nums; }
.marketing .feat h2 { margin: 4px 0 6px; }
.marketing .feat .prose { margin: 0 0 18px; }
.marketing .featgrid { display: grid; gap: 40px 44px; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }

/* Two facing columns where a picture sits beside its claim. Collapses on its own. */
.marketing .beside { display: grid; gap: 36px; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); align-items: center; }

/* Small labelled facts under a picture — what the thing did, in numbers. */
.marketing .figures { display: flex; flex-wrap: wrap; gap: 26px; margin-top: 18px; }
.marketing .figures div { font-size: 12px; color: var(--smoke); }
.marketing .figures strong { display: block; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; color: var(--ink); font-variant-numeric: tabular-nums; }

/*
 * The board and the connector cards, borrowed rather than redrawn.
 *
 * These two pictures use the app's own .lane / .leadcard / .card.src-* classes, so what the
 * landing shows is literally the same markup the product renders. The only thing added here
 * is size: the real board is a full-height flex child that scrolls, and inside a picture it
 * has to be a fixed, quiet block that does not steal the page's scroll or invite a drag.
 */
.marketing .board { display: flex; gap: 10px; overflow-x: auto; padding: 0 0 4px; flex: none; }
.marketing .lane { flex: 0 0 178px; }
.marketing .lane > header { cursor: default; padding: 8px 10px; }
.marketing .lane > header strong { font-size: 13px; }
.marketing .lanecards { padding: 8px; gap: 8px; overflow: visible; flex: none; }
.marketing .leadcard { cursor: default; gap: 3px; padding: 8px 9px; }
.marketing .leadcard .leadname { font-size: 13px; cursor: default; }
.marketing .leadcard .note { font-size: 11px; }

/*
 * The landing's nav.
 *
 * A bar, now that there is more than one thing in it. The earlier rule against one was
 * written when the page held a single Sign in link and a bar to hold one link is furniture;
 * four destinations and an action is a component, and loose underlined links at the top of
 * a page read as an accident. Still not sticky — the page is short enough to scroll and the
 * call to action is repeated at the foot.
 */
.marketing .topnav {
  display: flex; align-items: center; gap: 2px; flex-wrap: wrap;
  padding: 7px 8px 7px 16px; margin-bottom: 56px;
  background: var(--white); border: 1px solid var(--line); border-radius: var(--r-full);
}
.marketing .topnav .brand { padding: 0; margin-right: auto; font-size: 17px; }
.marketing .topnav a.nav {
  padding: 7px 13px; border-radius: var(--r-full); font-size: 14px; font-weight: 500;
  color: var(--smoke); text-decoration: none; white-space: nowrap;
}
.marketing .topnav a.nav:hover { background: var(--sand); color: var(--ink); }
/* A nav item carrying a mark. inline-flex so the glyph sits on the text's own line rather
   than on the baseline, and the gap is what stops the two reading as one word. */
.marketing .topnav a.nav.withmark { display: inline-flex; align-items: center; gap: 7px; }
.marketing .topnav a.nav.withmark svg { flex: none; opacity: 0.75; }
.marketing .topnav a.nav.withmark:hover svg { opacity: 1; }
.marketing .topnav a.button { margin-left: 6px; padding: 8px 16px; border-radius: var(--r-full); }
@media (max-width: 620px) {
  /* Wrapped onto two lines a pill looks like a mistake, so it squares off and the brand
     takes its own row with the action beside it. */
  .marketing .topnav { border-radius: var(--r-md); padding: 10px; gap: 4px; }
  .marketing .topnav .brand { flex: 1 0 100%; margin: 0 0 6px 4px; }
}

/* Four across on a wide screen, down to one on a phone, with nothing in between that
   leaves a lonely card on its own row. */
.marketing .four { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(212px, 1fr)); }
.marketing .four .card { padding: 18px 16px; }
.marketing .four h3 { margin: 0 0 6px; }
/* The comparison table. Two product columns, narrow and centred, so a row reads across. */
.marketing .compare td:not(:first-child), .marketing .compare th:not(:first-child) { width: 24%; }
.marketing .compare td:first-child { font-weight: 500; }
.marketing .compare .yes { color: var(--ok-ink); font-weight: 600; }
.marketing .compare .no { color: var(--edge); }
.marketing .compare .soon { color: var(--smoke); font-size: 12px; }

@media (max-width: 720px) {
  .marketing .shot .panes { grid-template-columns: 1fr; }
  .marketing .shot .rail { display: none; }
  .marketing .featgrid { gap: 34px; }
}


/* A title that opens something, styled as a link because that is what it does. */
button.linky {
  background: none; border: 0; padding: 0; color: var(--moss); font: inherit; font-size: 14px;
  text-align: left; cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}
/* Something to look at, not something that broke. Amber rather than red, deliberately:
   a crawl that filed 24 of 25 pages worked, and colouring it red teaches people to
   ignore the colour on the crawls that genuinely failed. */
button.linky.warn { color: var(--warn-ink); font-size: 13px; }
.failures {
  margin-top: 14px; padding: 12px 14px; border-radius: var(--r-md);
  background: var(--warn-face); border: 1px solid var(--amber-edge);
}
.failures h3 { font-size: 14px; color: var(--warn-ink); }
.failures td { border-bottom-color: var(--amber-edge); font-size: 13px; }
/* The expander triangle: a square target, not a character floating in a button. */
button.ghost.small.disclose { padding: 2px 8px; line-height: 1.2; margin-top: 2px; }
.site table { margin-top: 12px; }

/* Crawl progress. Cross-browser <progress> needs both the bar and the value addressed. */
progress { width: 260px; max-width: 100%; height: 8px; vertical-align: middle;
  border: 0; border-radius: var(--r-full); background: var(--line); appearance: none; }
progress::-webkit-progress-bar { background: var(--line); border-radius: var(--r-full); }
progress::-webkit-progress-value { background: var(--moss); border-radius: var(--r-full); }
progress::-moz-progress-bar { background: var(--moss); border-radius: var(--r-full); }
/*
 * No value, because reading a file has no honest denominator — the passages are not
 * countable until it has been chunked. A travelling stripe claims only that something is
 * happening, which is all we know. Painted on the element itself so it survives
 * appearance:none in every engine.
 */
progress:indeterminate {
  background: linear-gradient(90deg, var(--line) 40%, var(--moss) 50%, var(--line) 60%) 0 0 / 300% 100%;
  animation: sweep 1.4s linear infinite;
}
progress:indeterminate::-webkit-progress-bar { background: none; }
@keyframes sweep { to { background-position: -300% 0; } }

/* Already in use: a list rather than cards. These are settled, and settled things should
   not shout as loudly as decisions. */
.lessonrow {
  display: flex; align-items: flex-start; gap: 12px;
  border-bottom: 1px solid var(--line); padding: 12px 2px;
}
.lessonrow:last-child { border-bottom: 0; }
.lessonrow .body { flex: 1; min-width: 0; }
.lessonrow .said { margin: 0; font-size: 13.5px; color: var(--ink); overflow-wrap: anywhere; }
.lessonrow > button { flex: none; }

/*
 * The training queue.
 *
 * A review screen before it is a settings page: one question per row — is this true, and
 * should it be said again — so the layout puts the source, the shape of the exchange and
 * the decision within one glance of each other.
 */
.training .queuehead {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 16px; flex-wrap: wrap; margin-bottom: 12px;
}
.training .queuehead h3 { font-size: 16px; margin: 0 0 2px; }
.training .queuehead .note { margin: 0; }

/* Stays put while a long queue scrolls under it, because the buttons belong to the whole. */
.training .reviewbar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  position: sticky; top: 0; z-index: 2;
  background: var(--white); border: 1px solid var(--line); border-radius: var(--r-md);
  padding: 10px 14px; margin-bottom: 14px;
}
.training .reviewbar .grow { flex: 1; }
.training .reviewbar .check { align-items: center; }
.training .reviewbar strong { font-size: 14px; }

/* A heading for each kind, because approving a fact and approving a phrasing are not the
   same decision and should not read as one list. */
.lessongroup { margin-top: 18px; }
.lessongroup > header { margin-bottom: 10px; }
.lessongroup > header h4 { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
.lessongroup > header .note { margin: 0; max-width: 68ch; }

/*
 * Proposals that say nearly the same thing, folded under the first one that said it.
 *
 * The fold is attached to its leader rather than floating below it -- the leader loses its
 * bottom margin and the summary sits flush against it -- so the relationship is legible
 * before it is opened, and a run of nine cards reads as three decisions.
 */
/* What an example will send, shown on the card before the tick rather than after it. */
.sends { margin: 10px 0 0; }
.sendrow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; }
/* The button that opens the picker sits in the row with them, not under it. */
.sendrow > button.ghost { padding: 4px 12px; font-size: 12.5px; }
.sendrow > .note { margin: 0; margin-right: 2px; }
.sendnote { margin: 6px 0 0; }
.sendrow .chip { max-width: 100%; padding: 0; gap: 0; font-size: 12.5px; overflow: hidden; }
.sendrow .chipname {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 34ch;
}
.sendrow .chip .mark {
  flex: none; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 5px;
  background: var(--white); color: var(--ink);
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 8px; font-weight: 600;
}
/*
 * Still waiting for its own tick, so it is outlined rather than filled: it is named because
 * it belongs with the answer, not because it is going anywhere yet. The dot repeats that
 * without a parenthesis of explanation after every name.
 */
/*
 * Crossed off, and still on screen. A file that vanished when you dismissed it gives you
 * nothing to change your mind with, and changing your mind is most of reviewing.
 */
.sendrow .chip.off { background: none; color: var(--smoke); border-color: var(--line); }
.sendrow .chip.off .chipname { text-decoration: line-through; }
.sendrow .chip.off .mark { background: var(--line); color: var(--smoke); }
.sendrow .chip .chiplook { padding: 4px 4px 4px 7px; }
.sendrow .chip .chipx { padding: 4px 9px 4px 5px; }
.sendrow .chip.on .chipx:hover, .sendrow .chip.on .chiplook:hover { background: rgba(255, 255, 255, 0.14); }
.sendrow .chip.off .chipx:hover, .sendrow .chip.off .chiplook:hover { background: var(--sand); }

/* The name looks, the cross removes — two buttons in one pill, so neither does the other.
   Shared by the review queue and the editor, which is why it hangs off .sendrow. */
.chiplook, .chipx {
  display: inline-flex; align-items: center; gap: 6px;
  background: none; border: 0; color: inherit; font: inherit; cursor: pointer;
}
.chiplook { padding: 5px 4px 5px 8px; }
.chipx { padding: 5px 10px 5px 6px; opacity: 0.65; }
.chipx:hover, .chiplook:hover { opacity: 1; background: rgba(255, 255, 255, 0.14); }

/* A look at the thing itself, big enough to actually see it. */
.sheet.peek .sheetbody { max-width: 900px; }
/*
 * Title left, the two ways out top right, on one line however long the filename is — and
 * a phone-generated name is always long. Unscoped, because this sheet opens from the inbox
 * and from the training queue, and the training-only .queuehead left it with no layout.
 */
.peekhead { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.peekhead h3 { margin: 0; font-size: 16px; min-width: 0; overflow-wrap: anywhere; }
/* Both ways out are the same size, so neither reads as the main one. */
.peekhead .button, .peekhead button { flex: none; }
.peekimg { display: block; max-width: 100%; max-height: 72vh; margin: 0 auto; border-radius: var(--r-sm); }
.peekdoc { width: 100%; height: 72vh; border: 1px solid var(--line); border-radius: var(--r-sm); }

.clustered { margin-bottom: 8px; }
/* Two card shapes fold: the queue's .lessoncard and the deployed list's .examplecard. */
.clustered > .lessoncard, .clustered > .examplecard {
  margin-bottom: 0; border-bottom-left-radius: 0; border-bottom-right-radius: 0;
}
.alike > summary {
  cursor: pointer; list-style: none;
  font-size: 12px; color: var(--smoke);
  padding: 7px 16px;
  border: 1px solid var(--line); border-top: 0;
  border-radius: 0 0 var(--r-md) var(--r-md);
  background: var(--sand);
}
.alike > summary::-webkit-details-marker { display: none; }
.alike > summary::before { content: 'B8'; display: inline-block; margin-right: 6px; transition: transform 0.12s; }
.alike[open] > summary::before { transform: rotate(90deg); }
.alike > summary:hover { color: var(--ink); border-color: var(--edge); }
/* Indented so an opened fold cannot be mistaken for the next decision in the queue. */
.alike > .lessoncard, .alike > .examplecard { margin: 8px 0 0 20px; }
.alike > .lessoncard:last-child, .alike > .examplecard:last-child { margin-bottom: 8px; }

.lessoncard {
  background: var(--white); border: 1px solid var(--line); border-radius: var(--r-md);
  padding: 14px 16px; margin-bottom: 8px;
  transition: border-color 0.12s, background 0.12s;
}
.lessoncard:hover { border-color: var(--edge); }
.lessoncard.picked { border-color: var(--moss); background: var(--ok-face); }
.lessoncard .check { align-items: flex-start; gap: 12px; }
.lessoncard .body { display: block; flex: 1; min-width: 0; }

/* An example is an exchange: the question quoted and quiet, the answer in the company's
   own voice beneath it. */
.lessoncard .asked {
  margin: 0 0 8px; font-size: 13px; color: var(--smoke); font-style: italic;
}
.lessoncard .asked::before { content: '“'; }
.lessoncard .asked::after { content: '”'; }
.lessoncard .said {
  margin: 0; font-size: 14px; line-height: 1.5; color: var(--ink); white-space: pre-wrap;
  overflow-wrap: anywhere; border-left: 3px solid var(--moss); padding-left: 12px;
}
/* A fact is a claim, so the claim leads. */
.lessoncard .claim {
  margin: 0; font-size: 14.5px; font-weight: 500; line-height: 1.45; color: var(--ink);
  overflow-wrap: anywhere;
}
/*
 * When it happens, on a date card.
 *
 * The date is what the card is for, so it is the biggest thing on it. This used to reuse
 * .factlabel - 10px, grey, uppercase, monospace - which is right for the topic of a fact and
 * wrong here: it read as a caption, and the time pickers below ended up the most prominent
 * controls on the row, so they were taken for the date fields.
 */
.lessoncard .whenline {
  margin: 0 0 5px; font-size: 16.5px; font-weight: 650; line-height: 1.3;
  color: var(--ink); letter-spacing: -0.01em; font-variant-numeric: tabular-nums;
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
}
/* A repeat is a qualifier on the date, so it sits beside it rather than competing with it. */
.lessoncard .whenline .every {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--smoke); background: var(--sand); border-radius: var(--r-sm); padding: 2px 7px;
}
/*
 * Search-and-tick, used by both Manage dialogs on the admin page.
 *
 * Scrolls at a fixed height rather than growing the dialog: an instance with forty accounts
 * would otherwise push the search box off the top of the screen, which is the one control
 * that makes forty accounts manageable.
 */
.picklist { max-height: 46vh; overflow-y: auto; border-top: 1px solid var(--line); }
/*
 * A row of the list, not a form label — so it undoes what the base label rule assumes about
 * one: block, 13px, grey and semi-bold is right above a field and wrong for a name you are
 * picking from a list. label.check and label.switch do the same, for the same reason.
 */
.pickrow {
  display: flex; align-items: center; gap: 10px; margin: 0; padding: 9px 2px;
  border-bottom: 1px solid var(--line); cursor: pointer;
  font-size: 14px; font-weight: 400; color: var(--ink);
}
.pickrow:hover { background: var(--sand); }
/* A row that cannot be changed should not look pressable. */
.pickrow:has(input:disabled) { cursor: default; background: none; }
/*
 * width:auto, because the rule at the top of this file gives every input width:100% — so a
 * checkbox left alone eats the whole row and the name beside it wraps one letter per line.
 * Same override label.check already carries, for the same reason.
 */
.pickrow input { width: auto; flex: none; margin: 0; accent-color: var(--ink); }
.pickname { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--ink); }
/* Why the row is locked, kept on one line and never the thing that widens the dialog. */
.pickrow .note { flex: none; white-space: nowrap; font-size: 12px; }
/* What a fact is about, above what it says. */
.lessoncard .factlabel {
  margin: 0 0 3px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
  font-family: ui-monospace, SFMono-Regular, monospace; color: var(--smoke);
}
.lessoncard .nearest {
  margin: 10px 0 0; padding: 9px 12px; border-radius: var(--r-sm); background: var(--sand);
  font-size: 13px; color: var(--smoke); overflow-wrap: anywhere;
}
.lessoncard .nearest span {
  display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
  font-family: ui-monospace, SFMono-Regular, monospace; margin-bottom: 3px;
}
.lessoncard .nearest.none { background: var(--ok-face); color: var(--ok-ink); }

/* Where it came from, which is how "is this true" actually gets answered. */
.lessoncard .foot {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px;
  padding-top: 9px; border-top: 1px solid var(--line);
}
.lessoncard.picked .foot { border-top-color: rgba(0, 0, 0, 0.08); }
.lessoncard .foot .pill { font-size: 11px; }
.lessoncard .foot .note { margin: 0; }

/* A file proposal: the file itself, then when it should be sent. */
.lessoncard .proposedfile {
  display: flex; align-items: center; gap: 10px; margin-bottom: 8px;
  border: 1px solid var(--line); border-radius: var(--r-sm); padding: 8px 10px; background: var(--sand);
}
.lessoncard .proposedfile .filekind {
  flex: none; display: grid; place-items: center; width: 38px; height: 38px; border-radius: var(--r-sm);
  background: var(--ink); color: var(--white);
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px; font-weight: 600;
}
.lessoncard .proposedfile b { display: block; font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.lessoncard .proposedfile small { display: block; font-size: 11px; color: var(--smoke); }

/* Already in use: a list rather than cards. These are settled, and settled things should
   not shout as loudly as decisions. */
.lessonrow {
  display: flex; align-items: flex-start; gap: 12px;
  border-bottom: 1px solid var(--line); padding: 12px 2px;
}
.lessonrow:last-child { border-bottom: 0; }
.lessonrow .body { flex: 1; min-width: 0; }
.lessonrow .asked { margin: 0 0 3px; font-size: 13px; color: var(--smoke); font-style: italic; }
.lessonrow .said { margin: 0; font-size: 13.5px; color: var(--ink); overflow-wrap: anywhere; }
.lessonrow > button { flex: none; }
/* A search hit inside an excerpt. Toned to the theme; the browser default is a highlighter. */
.lessonrow mark { background: var(--warn-face); color: var(--warn-ink); padding: 0 1px; border-radius: 2px; }
.lessonrow .factlabel {
  margin: 0 0 3px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
  font-family: ui-monospace, SFMono-Regular, monospace; color: var(--smoke);
}
/* A settled file or link: same card as the proposal, at the size of a list row. */
.lessonrow .proposedfile {
  display: flex; align-items: center; gap: 9px; margin-bottom: 6px;
}
.lessonrow .proposedfile .filekind {
  flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: var(--r-sm);
  background: var(--ink); color: var(--white);
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 9px; font-weight: 600;
}
.lessonrow .proposedfile b { display: block; font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.lessonrow .proposedfile small { display: block; font-size: 11px; color: var(--smoke); overflow-wrap: anywhere; }

/*
 * The queue, as a door rather than a pile.
 *
 * What a bot has learned is what somebody opens this page for; what it is waiting to be
 * allowed to learn is a job, done in one sitting. So the job is one line with a count on
 * it, and the whole review happens in a sheet over the top.
 */
.approvebar {
  display: flex; align-items: center; gap: 14px; width: 100%; text-align: left;
  background: var(--white); color: var(--ink); border: 1px solid var(--line); border-radius: var(--r-md);
  padding: 14px 16px; cursor: pointer; transition: border-color 0.12s, box-shadow 0.12s;
}
.approvebar:disabled { cursor: default; opacity: 0.75; }
.approvebar.waiting { border-color: var(--moss); box-shadow: 0 1px 3px rgba(23, 23, 23, 0.06); }
.approvebar.waiting:hover { border-color: var(--ink); }
.approvebar .count {
  flex: none; display: grid; place-items: center; min-width: 34px; height: 34px; padding: 0 8px;
  border-radius: var(--r-sm); background: var(--sand); color: var(--smoke);
  font-size: 15px; font-weight: 600;
}
.approvebar.waiting .count { background: var(--moss); color: var(--white); }
.approvebar > span:nth-child(2) { flex: 1; min-width: 0; }
.approvebar strong { display: block; font-size: 14px; }
.approvebar .note { margin: 2px 0 0; }
.approvebar .go { flex: none; font-size: 13px; color: var(--moss); font-weight: 500; }

/* Wide, because a proposal is a paragraph and a queue is judged by comparison. */
dialog.sheet.reviewsheet { width: min(860px, calc(100vw - 40px)); }

@media (prefers-reduced-motion: reduce) { progress:indeterminate { animation: none; } }

.lessoncard .eventtimes { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.lessoncard .eventtimes label { display: grid; gap: 2px; margin: 0; }
.timepick { width: auto; min-width: 108px; }
.lessoncard .eventtimes .timepick { width: auto; padding: 5px 8px; font-size: 13px; }
.lessoncard .eventtimes .calpick { width: auto; max-width: 180px; padding: 5px 8px; font-size: 13px; }
.lessoncard .eventtimes > .note { flex: 1; min-width: 180px; margin: 0 0 4px; }

/*
 * The passages sheet. A native <dialog>, so the backdrop, the focus trap and
 * Escape-to-close come from the platform rather than from a few dozen lines of listeners.
 */
dialog.sheet {
  width: min(760px, calc(100vw - 40px)); max-height: 84vh; padding: 22px;
  border: 1px solid var(--line); border-radius: var(--r-md); background: var(--white); color: var(--ink);
  box-shadow: 0 18px 60px rgba(0,0,0,.22);
}
dialog.sheet::backdrop { background: rgba(23, 23, 23, .42); }
/* A sheet holding one short form rather than a document. */
dialog.sheet.narrow { width: min(460px, calc(100vw - 40px)); }

dialog.sheet.wide { width: min(860px, calc(100vw - 40px)); }

/*
 * The catch-up at the top of a card.
 *
 * Set apart from the fields under it because it is the one part that was written rather
 * than recorded. The threads it was written from stay one tab away, which is what makes it
 * safe to read quickly — it is a convenience over the record, never a replacement.
 */
.catchup {
  border: 1px solid var(--line); border-radius: var(--r-sm); padding: 12px 14px;
  background: var(--sand); margin-bottom: 16px;
}
.catchup h4 {
  margin: 0 0 6px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px;
  font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em; color: var(--smoke);
}
.catchup .said { margin: 0; font-size: 14px; line-height: 1.5; }
.catchup .note { margin: 0; }
.keypoints { margin: 0; padding-left: 18px; font-size: 13.5px; line-height: 1.5; }
.keypoints li { margin-bottom: 3px; }
/* The one place the accent appears in a sheet: these are the lines meant to catch the eye. */
.keypoints li::marker { color: var(--moss); }

/* The way on from a card, in the same place whichever tab is open. */
.sheetfoot { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); }

/*
 * One approved example, open for correction.
 *
 * Roomy on purpose: the two fields are prose somebody is rewriting, not a form to tab
 * through, and the file checklist under them is the other half of the same answer.
 */
.examplecard { margin-top: 12px; padding: 14px; }
.examplecard label { display: block; font-size: 13px; color: var(--smoke); margin-bottom: 4px; }
.examplecard textarea { font-size: 14.5px; }
/*
 * Choosing what an answer sends with it.
 *
 * What is attached sits above as chips, and everything else is a list to search. A column
 * of forty checkboxes made "what does this send?" a question you answered by reading every
 * row, when it is the one thing the control exists to say.
 */
.attachpicker { display: grid; gap: 8px; }
/*
 * One search box, everywhere there is one.
 *
 * Six of these were hand-rolled with their own inline width and their own idea of the gap
 * underneath, so a box above a list sat flush against it in one place and floated in another.
 * The shape and the breathing room live here instead.
 */
.search, .attachfind {
  font-size: 14px; padding: 8px 11px; width: 100%; max-width: 420px;
}
.search { display: block; margin: 14px 0; }
/*
 * Inside a row, the row owns both. A margin would push it out of line with whatever it sits
 * beside, and a forced full width would fight the flex sizing it is there to share.
 */
.row > .search { margin: 0; width: auto; flex: 1 1 220px; }

.pickfiles {
  display: grid; gap: 2px; max-height: 220px; overflow-y: auto;
  padding: 6px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--sand);
}
/* A row is one press, so it is a button — and one that has to stop looking like one. */
.pickfiles .filerow {
  display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  background: none; border: 0; border-radius: var(--r-sm); padding: 7px 8px;
  font: inherit; color: var(--ink); cursor: pointer;
}
.pickfiles .filerow:hover { background: var(--white); }
.pickfiles .filerow .what { flex: 1; min-width: 0; }
.pickfiles .filerow b { display: block; font-size: 13.5px; font-weight: 500; overflow-wrap: anywhere; }
.pickfiles .filerow small { display: block; font-size: 12px; color: var(--smoke); overflow-wrap: anywhere; }
.pickfiles .filerow .note { flex: none; font-variant-numeric: tabular-nums; }

/*
 * The same four characters as the chips, so a row and a badge read as one thing.
 *
 * Three places want it now — the file picker, a Media card and the attach sheet — so they
 * share the rule rather than each growing their own. Scoped rather than a bare .mark,
 * because .chip.mark is a different thing with the same word in its name.
 */
.pickfiles .filerow .mark, .card > .row > .mark, .pick > .mark {
  flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 5px;
  background: var(--ink); color: var(--white);
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 9px; font-weight: 600;
}
/*
 * And the picture that stands in for it when there is one, in the same slot so the card keeps
 * its shape either way.
 *
 * Cropped square rather than left to its own aspect ratio: .cards is three fixed columns, and a
 * portrait page next to a landscape one would make every row a different height. Anchored to
 * the top because the top of a page is where the title is.
 */
.card > .row > .thumb {
  flex: none; width: 64px; height: 64px; border-radius: 5px;
  object-fit: cover; object-position: top;
  background: var(--sand); border: 1px solid var(--line);
}
/* Inside a sheet the two source forms sit side by side only when there is room for both. */
dialog.sheet .grid.two { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
ol.passages { list-style: none; margin: 12px 0 0; padding: 0; }
ol.passages li { border-top: 1px solid var(--line); padding: 12px 0; }
ol.passages li p {
  margin: 4px 0 0; font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere;
}

/*
 * ---------------------------------------------------------------- the phone
 *
 * The rail leaves the grid and becomes a drawer, and a header row takes its place. A
 * drawer rather than a strip of links across the top: the nav is going to keep growing,
 * and a wrapping strip pushes the page itself below the fold.
 */
.topbar { display: none; }
.menubtn {
  background: none; color: var(--ink); border: 1px solid var(--edge);
  padding: 7px 10px; line-height: 0; flex: none;
}
.navscrim { position: fixed; inset: 0; z-index: 25; background: rgba(23, 23, 23, .42); border: 0; }
/* Resizing back past the breakpoint with the drawer open must not strand the scrim. */
@media (min-width: 861px) { .navscrim { display: none; } }

@media (max-width: 860px) {
  /* Written main.marketing, not a bare .marketing: the desktop rule is (0,1,1) and a bare
     class would lose to it, so the padding would silently never change. */
  main.marketing { padding: 40px 16px 60px; }
  .marketing > section + section { margin-top: 44px; }
  .shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .topbar {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--line);
  }
  .topbar .brand { padding: 0; font-size: 18px; }
  aside {
    position: fixed; top: 0; left: 0; bottom: 0; width: 264px; z-index: 30;
    background: var(--sand); padding: 20px 12px; border-right: 1px solid var(--line);
    /* visibility, not only transform — an off-screen drawer must leave the tab order. */
    transform: translateX(-100%); visibility: hidden;
    transition: transform 0.22s ease, visibility 0.22s;
    box-shadow: 0 18px 60px rgba(0,0,0,.22);
  }
  aside.open { transform: none; visibility: visible; }

  main > .page { padding: 24px 16px 48px; }
  h1 { font-size: 30px; }
  h2 { font-size: 19px; margin: 28px 0 12px; }
  p.lede { font-size: 16px; margin-bottom: 24px; }
  .card, .card.sectioncard { padding: 16px; }
  .stat { font-size: 28px; }
  /* One column everywhere: two 360px cards in a 360px viewport is one card, badly. */
  .grid, .grid.two { grid-template-columns: minmax(0, 1fr); }

  /* A dialog on a phone is the screen, so it uses it. */
  .backdrop { padding: 12px; align-items: flex-end; }
  .modal { padding: 16px; max-height: calc(100dvh - 24px); }

  /* The inbox is already one column by here; what it needs is shorter panes. */
  main:has(> .page > .fullheight) { overflow-y: auto; }
  .page:has(> .fullheight) { height: auto; display: block; }
  .fullheight, .fullheight .inboxsplit, .fullheight .inboxsplit > * { display: block; height: auto; }
  .threadlist { max-height: 42vh; }
  .msgs { max-height: 50vh; }
  .bubble { max-width: 90%; }

  /* Buttons in a connection row wrap to their own line rather than squeezing the name. */
  .acctactions { margin-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
  aside { transition: none; }
}
/* Any card holding a table scrolls sideways rather than clipping it — the page cannot
   scroll horizontally, so an overflowing table would otherwise be unreachable. */
.card:has(> table), .card:has(> div > table) { overflow-x: auto; }
`

/** Who is signed in, the workspace they are in, and whether the password is still the default. */
const me = createServerFn({ method: 'GET' }).handler(async () => {
  const s = await currentSession()
  if (!s) return null
  return {
    email: s.email,
    workspaceId: s.workspaceId,
    workspaceName: s.workspaceName,
    // Rides along with the session every navigation already loads, so the banner costs no
    // extra round trip.
    defaultPassword: await usingDefaultPassword(),
  }
})

const leave = createServerFn({ method: 'POST' }).handler(() => signOut())

/** Reachable with no session at all. Everything else goes to the sign-in form. */
const PUBLIC = ['/login']

/**
 * Where anything that has nowhere better to go sends somebody. One constant so there is a
 * single place to change it as pages are added.
 */
export const HOME = '/knowledge' as const

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    const session = await me()
    // One gate for the whole app rather than a check in every loader.
    if (!session && !PUBLIC.includes(location.pathname)) throw redirect({ to: '/login' })
    return { session }
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Arlo Desktop' },
    ],
    links: [{ rel: 'icon', href: FAVICON }],
  }),
  component: RootComponent,
})

function RootComponent() {
  const { session } = Route.useRouteContext()
  return (
    <RootDocument session={session}>
      <Outlet />
    </RootDocument>
  )
}

/**
 * Flat on purpose: a section is only a heading, and `visibleNav` drops one that ends up
 * with nothing under it. Each phase adds its own line here rather than this listing
 * routes that do not exist yet — a dead nav link is a broken app, not a placeholder.
 */
const NAV = [
  // The day's work, above any heading: this is where somebody lands and mostly stays.
  { to: '/inbox', label: 'Inbox', mark: 'inbox' },
  { sect: 'Directory' },
  { to: '/contacts', label: 'Contacts', mark: 'contacts' },
  { to: '/calendar', label: 'Calendar', mark: 'calendar' },
  // What decides how a question gets answered: the bot, and what it is allowed to read.
  { sect: 'Answering' },
  { to: '/chatbots', label: 'Chatbots', mark: 'chatbots' },
  // Directly under the bots, because it is what you do to one rather than a place of its own:
  // talk to it and find out whether what it learned is what you meant.
  { to: '/playground', label: 'Playground', mark: 'playground' },
  { to: '/knowledge', label: 'Knowledge', mark: 'knowledge' },
  // Beside Knowledge rather than under Setup: both answer “what does this workspace hold”,
  // and Media is reached while composing something rather than while configuring it.
  { to: '/media', label: 'Media', mark: 'media' },
  // Done once, then rarely.
  { sect: 'Setup' },
  { to: '/connectors', label: 'Connectors', mark: 'connectors' },
  { to: '/settings', label: 'Settings', mark: 'settings' },
] as const

/**
 * A section heading left with no links under it drops out — NAV is flat, so a heading is
 * only a heading. Nothing is hidden by permission any more; this survives because a phase
 * that removes a page should not also leave its heading behind.
 */
function visibleNav() {
  return NAV.filter((n, i) => {
    if (!('sect' in n)) return true
    const after = NAV.slice(i + 1)
    const next = after.findIndex((x) => 'sect' in x)
    return (next === -1 ? after : after.slice(0, next)).length > 0
  })
}

type Me = Awaited<ReturnType<typeof me>>

/**
 * That something is happening.
 *
 * A navigation waits for the next page's loader before anything on screen changes, so
 * without this the app looks frozen for as long as that takes — and the honest reading of
 * a frozen app is a broken one. A bar across the very top is the smallest thing that says
 * "heard you, working on it" without moving the page under somebody mid-click.
 *
 * Deliberately not a spinner over the content: the page you are leaving is still perfectly
 * readable while the next one loads, and covering it would take that away to say less.
 */
function Loading() {
  const loading = useRouterState({ select: (s) => s.status === 'pending' })
  /*
   * Always rendered and hidden with opacity, rather than mounted when a navigation starts.
   * Mounting it on demand would add a layout pass at exactly the moment the machine is
   * busiest, which is when it would be least likely to appear.
   */
  return <div className={`navload${loading ? ' on' : ''}`} aria-hidden="true" />
}

function RootDocument({ children, session }: Readonly<{ children: ReactNode; session: Me }>) {
  const location = useLocation()
  const nav = visibleNav()
  // Signed out there is one page, and it sets its own layout: the sign-in card is centred on
  // an empty screen rather than wrapped in a frame whose nav goes nowhere.
  const bare = !session
  const [menu, setMenu] = useState(false)
  const close = () => setMenu(false)

  // Escape closes the drawer, the same as tapping away from it.
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  return (
    <html lang="en">
      <head>
        <HeadContent />
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        {/* Outside the shell, so it is there on the sign-in page and the landing page too. */}
        <Loading />
        {bare ? (
          children
        ) : (
          <div className="shell">
            {/* Only below the breakpoint; above it the rail is the navigation. */}
            <header className="topbar">
              <button
                className="menubtn"
                aria-label="Menu"
                aria-expanded={menu}
                aria-controls="nav"
                onClick={() => setMenu((m) => !m)}
              >
                <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true">
                  <path d="M0 1h18M0 7h18M0 13h18" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </button>
              <Link to="/" className="brand" onClick={close}>
                <Logo />
                <span>
                  Arlo<span> Desktop</span>
                </span>
                <DesktopMark />
              </Link>
            </header>
            {menu && <button className="navscrim" aria-label="Close menu" onClick={close} />}
            <aside id="nav" className={menu ? 'open' : ''}>
              <Link to="/" className="brand" onClick={close}>
                <Logo />
                <span>
                  Arlo<span> Desktop</span>
                </span>
                <DesktopMark />
              </Link>
              {nav.map((n) =>
                'sect' in n ? (
                  <div className="sect" key={n.sect}>
                    {n.sect}
                  </div>
                ) : (
                  <Link
                    key={n.to}
                    to={n.to}
                    className="link"
                    activeProps={{ className: 'link active' }}
                    // Every nav path is a leaf, so an exact match is what "you are here"
                    // means; the loose default would light Dashboard on every page.
                    activeOptions={{ exact: true }}
                    // Navigating is the end of the menu's job.
                    onClick={close}
                  >
                    <NavIcon mark={n.mark} />
                    {n.label}
                  </Link>
                ),
              )}
              {session && <WorkspacePicker session={session} onDone={close} />}
            </aside>
            <main>
              <div className="page">
                {/*
                  Shown on every page until it is fixed, not once at sign-in.
                  A shipped credential is public knowledge, so the only thing standing
                  between this instance and anyone who can reach it is somebody actually
                  changing it — and a notice you can walk past is one you will.
                */}
                {session?.defaultPassword && (
                  <p className="err" role="alert" style={{ marginTop: 0 }}>
                    This instance still uses the default password. Anyone who can reach it can sign in.{' '}
                    <Link to="/settings" search={{ tab: 'general' }}>
                      Change it in Settings
                    </Link>
                    .
                  </p>
                )}
                {children}
              </div>
            </main>
          </div>
        )}
        <Scripts />
      </body>
    </html>
  )
}

/**
 * Who is signed in, and the way out.
 *
 * No workspace switcher: there is one workspace, and a second business means a second
 * instance. The name still shows, because knowing which one you are looking at is the
 * question a switcher used to answer in passing.
 */
function WorkspacePicker({ session, onDone }: { session: NonNullable<Me>; onDone: () => void }) {
  const router = useRouter()
  const leaveFn = useServerFn(leave)

  return (
    <div className="foot">
      <OutboundNavLinks />
      <div className="who">
        <span className="face" aria-hidden="true">
          {session.email.slice(0, 1)}
        </span>
        <span className="email" title={`${session.email} · ${session.workspaceName}`}>
          {session.email}
        </span>
        <button
          className="out"
          aria-label="Sign out"
          title="Sign out"
          onClick={async () => {
            onDone()
            await leaveFn()
            await router.invalidate()
            router.navigate({ to: '/login' })
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 13.5H3.6a1.1 1.1 0 0 1-1.1-1.1V3.6a1.1 1.1 0 0 1 1.1-1.1H6" />
            <path d="M10.4 11.2 13.5 8l-3.1-3.2M13.5 8H6" />
          </svg>
        </button>
      </div>
    </div>
  )
}
