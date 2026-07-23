import { ArrowLeft, CircleHelp, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { helpEntries, helpSections, type HelpEntry, type HelpSection } from "./help-content.js";

function searchableText(section: HelpSection, entry: HelpEntry): string {
  return [section.title, section.summary, entry.label, entry.location, entry.description, ...(entry.badges ?? [])]
    .join(" ")
    .toLocaleLowerCase();
}

export function HelpPage({ onBack }: { onBack: () => void }) {
  const [query, setQuery] = useState("");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSections = useMemo(
    () => helpSections
      .map((section) => ({
        ...section,
        entries: normalizedQuery
          ? section.entries.filter((item) => searchableText(section, item).includes(normalizedQuery))
          : section.entries
      }))
      .filter((section) => section.entries.length > 0),
    [normalizedQuery]
  );
  const visibleCount = visibleSections.reduce((total, section) => total + section.entries.length, 0);

  useEffect(() => titleRef.current?.focus(), []);

  const resultLabel = normalizedQuery
    ? visibleCount
      ? `${visibleCount} controls matching “${query.trim()}”`
      : `No Help entries match “${query.trim()}”.`
    : `${helpEntries.length} controls documented`;

  return (
    <main className="help-page">
      <header className="help-header">
        <button type="button" className="help-back" aria-label="Back to Space" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          <span>Back to Space</span>
        </button>
        <div className="help-title-block">
          <span className="help-title-icon" aria-hidden="true"><CircleHelp /></span>
          <div>
            <h1 ref={titleRef} tabIndex={-1}>Space Help</h1>
            <p>Every workspace capability, control, icon, and availability rule in one searchable guide.</p>
          </div>
        </div>
        <label className="help-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search Space Help</span>
          <input
            id="space-help-search"
            name="space-help-search"
            type="search"
            aria-label="Search Space Help"
            placeholder="Search controls, icons, locations, or ADMIN…"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <p className="help-result-count" role="status" aria-live="polite">{resultLabel}</p>
      </header>

      <div className="help-layout">
        <nav className="help-navigation" aria-label="Help sections">
          <strong>On this page</strong>
          {visibleSections.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              <span>{section.title}</span>
              <small>{section.entries.length}</small>
            </a>
          ))}
        </nav>

        <div className="help-content">
          {visibleSections.map((section) => (
            <section className="help-section" id={section.id} key={section.id} aria-labelledby={`${section.id}-title`}>
              <header>
                <h2 id={`${section.id}-title`}>{section.title}</h2>
                <p>{section.summary}</p>
              </header>
              <ul className="help-entry-list">
                {section.entries.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li className="help-entry" key={item.id}>
                      <span className="help-entry-icon"><Icon aria-hidden="true" /></span>
                      <div className="help-entry-copy">
                        <div className="help-entry-heading">
                          <h3>{item.label}</h3>
                          {item.badges?.map((badge) => <span className={`help-badge is-${badge.toLowerCase()}`} key={badge}>{badge}</span>)}
                        </div>
                        <p>{item.description}</p>
                        <small>{item.location}</small>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
