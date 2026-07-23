import { ArrowRight, CheckCircle2, MessageCircle, Orbit, PanelTop, Radio, TerminalSquare } from "lucide-react";
import { useEffect } from "react";
import { readPublicHomepageConfig, type PublicHomepageConfig } from "./public-config.js";
import { WaitlistForm } from "./WaitlistForm.js";
import "./homepage.css";

type HomepageProps = {
  publicConfig?: PublicHomepageConfig;
};

export function Homepage({ publicConfig }: HomepageProps) {
  const config = publicConfig ?? readPublicHomepageConfig();

  useEffect(() => {
    const previousTitle = document.title;
    const existingDescription = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const description = existingDescription ?? document.head.appendChild(document.createElement("meta"));
    const previousDescription = existingDescription?.content ?? null;
    description.name = "description";
    description.content = "Space brings AI chat, terminals, browser context, media, links, and music into one room-based workspace.";
    document.title = "Space — One workspace for AI work";
    return () => {
      document.title = previousTitle;
      if (existingDescription && previousDescription !== null) existingDescription.content = previousDescription;
      else description.remove();
    };
  }, []);

  return (
    <div className="homepage-shell">
      <a className="homepage-skip-link" href="#homepage-main">Skip to content</a>
      <header className="homepage-nav-wrap">
        <nav className="homepage-nav" aria-label="Primary navigation">
          <a className="homepage-brand" href="/" aria-label="Space homepage">
            <img src="/brand/space-logo.svg" alt="" />
            <span>Space</span>
          </a>
          <div className="homepage-nav-links">
            <a href="#demo">Demo</a>
            <a href="#features">Why Space</a>
            <a href="#early-access">Early access</a>
          </div>
          <div className="homepage-nav-actions">
            {config.discordUrl ? (
              <a className="homepage-discord-link" href={config.discordUrl} target="_blank" rel="noopener noreferrer">
                <MessageCircle aria-hidden="true" />Join Discord
              </a>
            ) : null}
            <a className="homepage-nav-cta" href="#early-access">Request access</a>
          </div>
        </nav>
      </header>

      <main id="homepage-main">
        <section className="homepage-hero" aria-labelledby="homepage-title">
          <div className="homepage-eyebrow"><span />Private preview · Built for multi-agent work</div>
          <h1 id="homepage-title">Your AI work, in one Space.</h1>
          <p>
            Rooms, chat, terminals, browser context, media, links, and focus music—composed into one calm workspace for building with AI.
          </p>
          <div className="homepage-hero-actions">
            <a className="homepage-primary-cta" href="#demo">Try the interactive demo <ArrowRight aria-hidden="true" /></a>
            <a className="homepage-secondary-cta" href="#early-access">Join the private preview</a>
          </div>
          <div className="homepage-trust-line" aria-label="Demo guarantees">
            <span><CheckCircle2 aria-hidden="true" />No account needed</span>
            <span><CheckCircle2 aria-hidden="true" />No real AI calls</span>
            <span><CheckCircle2 aria-hidden="true" />Reset anytime</span>
          </div>
        </section>

        <section id="demo" className="homepage-demo-section" role="region" aria-label="Interactive Space demo">
          <div className="homepage-section-heading">
            <span>Product preview</span>
            <h2>Step inside the workspace.</h2>
            <p>Everything below is a safe, local demo. Open rooms, message a pane, organize artifacts, and tune the workspace.</p>
          </div>
          <div className="homepage-demo-frame">
            <iframe
              src="/demo-workspace"
              title="Interactive Space workspace demo"
              loading="eager"
            />
          </div>
          <p className="homepage-demo-caption"><span />Demo environment — commands and messages never leave this page.</p>
        </section>

        <section id="features" className="homepage-features" aria-labelledby="features-title">
          <div className="homepage-section-heading homepage-section-heading-left">
            <span>Designed as a system</span>
            <h2 id="features-title">Keep the work together, not just the chat.</h2>
          </div>
          <div className="homepage-feature-list">
            <article><Orbit aria-hidden="true" /><h3>Rooms hold the context</h3><p>Separate launches, research, and operations without losing the thread.</p></article>
            <article><TerminalSquare aria-hidden="true" /><h3>AI and CLI, side by side</h3><p>Move between conversation and execution without rebuilding your workspace.</p></article>
            <article><PanelTop aria-hidden="true" /><h3>Every artifact within reach</h3><p>Clipboard notes, media, trusted links, and browser previews live beside the work.</p></article>
            <article><Radio aria-hidden="true" /><h3>A workspace with a pulse</h3><p>Theme it, focus it, and put on Code Radio while the agents work.</p></article>
          </div>
        </section>

        <section id="early-access" className="homepage-access" aria-labelledby="access-title">
          <div>
            <span className="homepage-access-kicker">Early access</span>
            <h2 id="access-title">Make room for your best work.</h2>
            <p>Join the list for launch updates and a first look at the real Space app.</p>
            <p id="discord-unavailable" className="homepage-discord-note">
              {config.discordUrl ? "Prefer community updates? Join us on Discord." : "Discord invite coming soon."}
            </p>
          </div>
          <WaitlistForm />
        </section>
      </main>

      <footer className="homepage-footer">
        <a className="homepage-brand" href="/"><img src="/brand/space-logo.svg" alt="" /><span>Space</span></a>
        <p>One workspace for ambitious AI work.</p>
        <a href="http://127.0.0.1:4911/">Open Space</a>
      </footer>
    </div>
  );
}
