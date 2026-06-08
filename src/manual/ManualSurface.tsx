import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { SurfaceShell } from '../surfaces/SurfaceShell';
import type { ManualCorpus, ManualSection } from './manualCorpus';
import './manual-surface.css';

export type ChatPickerTarget = { id: string; title: string };

export interface ManualSurfaceProps {
  corpus: ManualCorpus;
  /** open directly to this section slug (e.g. when launched from a panel) */
  initialSlug?: string;
  /** optional scope shown when the manual is launched from a specific panel */
  scopeLabel?: string;
  /** enumerate open chat panels for the picker; called on button click */
  getChatTargets?: () => Promise<ChatPickerTarget[]>;
  /** called once the user has picked a chat (or when only one is open); targetId is undefined if none are open */
  onAskAgent?: (section: ManualSection, targetId?: string) => void;
  onClose: () => void;
}

function searchable(section: ManualSection): string {
  return [section.title, section.group, section.slug, section.body].join(' ').toLowerCase();
}

function uiLabel(value: string): string {
  return value.toLocaleLowerCase();
}

/* The reader renders its own <h1> from the section title, so a MANUAL/doc that
 * opens with a `# Heading` would show two titles. Strip a single leading H1
 * unconditionally — by convention these files lead with their own title, and
 * stripping keeps the reader's title authoritative (and avoids stale headings
 * like `# Verify` on a panel now titled "debug"). */
function stripLeadingHeading(markdown: string): string {
  const leadingWhitespace = markdown.match(/^\s*/)?.[0] ?? '';
  const body = markdown.slice(leadingWhitespace.length);
  const match = /^#\s+.+?(?:\n|$)/.exec(body);
  if (!match) return markdown;
  return body.slice(match[0].length).replace(/^\n+/, '');
}

/* Build the component map for ReactMarkdown. External links open in a new tab;
   internal links (no protocol) navigate within the manual via setActiveSlug. */
function makeComponents(navigate: (slug: string) => void) {
  return {
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      const isInternal = href && !href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('//') && !href.startsWith('#');
      if (isInternal) {
        return (
          <a href="#" onClick={(e) => { e.preventDefault(); navigate(href!); }}>
            {children}
          </a>
        );
      }
      return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
    },
  };
}

export function ManualSurface({ corpus, initialSlug, scopeLabel, getChatTargets, onAskAgent, onClose }: ManualSurfaceProps) {
  /* default landing is the first item of the first nav group (Getting started),
     not whatever order the corpus globbed in. */
  const overviewSlug = corpus.groups[0]?.sections[0]?.slug ?? corpus.sections[0]?.slug;
  const [activeSlug, setActiveSlug] = useState(() =>
    initialSlug && corpus.get(initialSlug) ? initialSlug : overviewSlug,
  );
  const [query, setQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTargets, setPickerTargets] = useState<ChatPickerTarget[]>([]);
  const [fetchingTargets, setFetchingTargets] = useState(false);

  /* active must be computed before the callbacks that close over it */
  const active = (activeSlug ? corpus.get(activeSlug) : undefined) ?? corpus.sections[0];

  const handleAskClick = useCallback(async () => {
    if (!onAskAgent || !active) return;
    if (pickerOpen) {
      setPickerOpen(false);
      return;
    }
    if (!getChatTargets) {
      onAskAgent(active, undefined);
      return;
    }
    setFetchingTargets(true);
    try {
      const targets = await getChatTargets();
      if (targets.length <= 1) {
        onAskAgent(active, targets[0]?.id);
      } else {
        setPickerTargets(targets);
        setPickerOpen(true);
      }
    } finally {
      setFetchingTargets(false);
    }
  }, [onAskAgent, active, getChatTargets, pickerOpen]);

  const handlePickTarget = useCallback((targetId: string) => {
    setPickerOpen(false);
    if (active) onAskAgent?.(active, targetId);
  }, [active, onAskAgent]);

  useEffect(() => {
    if (initialSlug && corpus.get(initialSlug)) setActiveSlug(initialSlug);
  }, [initialSlug, corpus]);

  const groups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return corpus.groups;
    return corpus.groups
      .map((group) => ({
        ...group,
        sections: group.sections.filter((section) => searchable(section).includes(normalized)),
      }))
      .filter((group) => group.sections.length > 0);
  }, [corpus.groups, query]);

  const markdownComponents = useMemo(() => makeComponents(setActiveSlug), [setActiveSlug]);

  /* canonical reading order, for the prev/next pager */
  const ordered = useMemo(() => corpus.groups.flatMap((group) => group.sections), [corpus.groups]);
  const activeBody = active ? stripLeadingHeading(active.body) : '';
  const activeIndex = active ? ordered.findIndex((section) => section.slug === active.slug) : -1;
  const prev = activeIndex > 0 ? ordered[activeIndex - 1] : undefined;
  const next = activeIndex >= 0 && activeIndex < ordered.length - 1 ? ordered[activeIndex + 1] : undefined;
  const activeTitle = active ? uiLabel(active.title) : '';
  const activeGroup = active ? uiLabel(active.group) : '';

  const dialogLabel = scopeLabel ? `manual for ${uiLabel(scopeLabel)}` : 'manual';
  const title = scopeLabel ? `manual · ${uiLabel(scopeLabel)}` : 'manual';

  const nav = (
    <>
      <label className="surface__search">
        <span className="surface__search-icon" aria-hidden="true">⌕</span>
        <input
          value={query}
          placeholder="search the manual"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="manual-tree">
        {groups.map((group) => (
          <div className="surface__nav-group" key={group.name}>
            <span className="surface__nav-heading">{uiLabel(group.name)}</span>
            {group.sections.map((section) => (
              <button
                key={section.slug}
                type="button"
                className="surface__nav-link surface__nav-link--plain"
                aria-current={section.slug === active?.slug ? 'page' : undefined}
                onClick={() => setActiveSlug(section.slug)}
              >
                {uiLabel(section.title)}
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 && <p className="surface__nav-empty">no matching pages</p>}
      </div>
    </>
  );

  const ask = onAskAgent && active
    ? (
      <div className="manual-ask-wrap">
        {pickerOpen && (
          <>
            <div className="manual-ask-backdrop" onClick={() => setPickerOpen(false)} />
            <div className="manual-ask-picker" role="menu" aria-label="choose chat">
              {pickerTargets.map((t) => (
                <button key={t.id} type="button" role="menuitem" onClick={() => handlePickTarget(t.id)}>
                  {uiLabel(t.title)}
                </button>
              ))}
            </div>
          </>
        )}
        <button
          type="button"
          className="surface-btn surface-btn--accent surface-btn--sm"
          disabled={fetchingTargets}
          onClick={() => void handleAskClick()}
        >
          {fetchingTargets ? 'loading…' : 'ask the agent about this'}
        </button>
      </div>
    )
    : undefined;

  return (
    <SurfaceShell
      label={dialogLabel}
      title={title}
      subtitle={activeGroup}
      trailing={ask}
      closeLabel="close manual"
      navLabel="manual contents"
      nav={nav}
      onClose={onClose}
    >
      <article className="surface__content manual-reader" aria-label={active ? `${activeTitle} manual` : 'manual'}>
        {active ? (
          <div className="manual-reader__inner">
            <header className="manual-reader__head">
              <span className="manual-reader__eyebrow">{activeGroup}</span>
              <h1>{activeTitle}</h1>
            </header>

            {active.facts && (
              <dl className="manual-facts">
                <Fact term="plugin" value={active.facts.id} />
                <Fact term="version" value={active.facts.version} />
                <Fact term="category" value={active.facts.category} />
                <Fact
                  term="permissions"
                  value={active.facts.permissions.length ? active.facts.permissions.join(', ') : 'none'}
                />
                {active.facts.capabilities.length > 0 && (
                  <Fact term="capabilities" value={active.facts.capabilities.join(', ')} />
                )}
              </dl>
            )}

            <div className="manual-prose">
              {activeBody.trim()
                ? <ReactMarkdown components={markdownComponents}>{activeBody}</ReactMarkdown>
                : <p className="manual-reader__empty">no prose authored for this page yet.</p>}
            </div>

            {(prev || next) && (
              <nav className="manual-pager" aria-label="manual pages">
                {prev
                  ? (
                    <button type="button" className="manual-pager__link" onClick={() => setActiveSlug(prev.slug)}>
                      <span className="manual-pager__dir">← previous</span>
                      <span className="manual-pager__title">{uiLabel(prev.title)}</span>
                    </button>
                  )
                  : <span />}
                {next && (
                  <button type="button" className="manual-pager__link manual-pager__link--next" onClick={() => setActiveSlug(next.slug)}>
                    <span className="manual-pager__dir">next →</span>
                    <span className="manual-pager__title">{uiLabel(next.title)}</span>
                  </button>
                )}
              </nav>
            )}
          </div>
        ) : (
          <p className="manual-reader__empty">the manual is empty.</p>
        )}
      </article>
    </SurfaceShell>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="manual-fact">
      <dt>{term}</dt>
      <dd>{value}</dd>
    </div>
  );
}
