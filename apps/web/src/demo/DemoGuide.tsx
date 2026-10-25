import { useEffect, useRef, useState } from "react";

// Public demo only: a short tour of the simulated workspace and the command
// that installs a real one. Nothing here talks to a server.
export const INSTALL_COMMAND = "npx --yes run-spaceapp@latest install";
export const INSTALL_GUIDE_URL = "https://spaceapp.dev/docs/install/";

export const DEMO_TOUR_STEPS = [
  {
    title: "Rooms",
    text: "A room keeps one piece of work together: its agents, terminals and tools. Switch rooms in the dock on the left."
  },
  {
    title: "Agent panes",
    text: "Each pane is a coding agent such as OpenCode, Codex, Claude Code or Gemini. In this demo their sessions are recorded and simulated."
  },
  {
    title: "Add what you need",
    text: "Use Create or Add panes to open more CLIs, a browser, files or live voice next to your agents."
  },
  {
    title: "Run your own",
    text: "Install SpaceApp on your machine to run real agents with your own accounts. OpenCode starts with a free model."
  }
] as const;

type Panel = "tour" | "install" | null;

export function DemoGuide() {
  const [panel, setPanel] = useState<Panel>(null);
  const [step, setStep] = useState(0);
  const [copied, setCopied] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!panel) return;
    heading.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, step]);

  const openTour = () => {
    setStep(0);
    setPanel("tour");
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be blocked in embedded frames; the command stays selectable.
      setCopied(false);
    }
  };
  const current = DEMO_TOUR_STEPS[step] ?? DEMO_TOUR_STEPS[0];
  const last = step === DEMO_TOUR_STEPS.length - 1;

  return (
    <>
      <div className="public-mock-intro">
        <span>Interactive demo · simulated in your browser</span>
        <button type="button" className="public-mock-button" onClick={openTour} aria-expanded={panel === "tour"}>
          Take the tour
        </button>
      </div>
      <button
        type="button"
        className="public-mock-button public-mock-install"
        onClick={() => setPanel(panel === "install" ? null : "install")}
        aria-expanded={panel === "install"}
      >
        Install your own
      </button>
      {panel === "tour" ? (
        <section className="public-mock-panel public-mock-tour" role="dialog" aria-labelledby="public-mock-tour-title">
          <p className="public-mock-panel-step">
            {step + 1} of {DEMO_TOUR_STEPS.length}
          </p>
          <h2 id="public-mock-tour-title" ref={heading} tabIndex={-1}>
            {current.title}
          </h2>
          <p>{current.text}</p>
          <div className="public-mock-panel-actions">
            <button type="button" className="public-mock-link" onClick={() => setPanel(null)}>
              Close
            </button>
            {step > 0 ? (
              <button type="button" className="public-mock-button" onClick={() => setStep(step - 1)}>
                Back
              </button>
            ) : null}
            {last ? (
              <button type="button" className="public-mock-button public-mock-primary" onClick={() => setPanel("install")}>
                Install your own
              </button>
            ) : (
              <button type="button" className="public-mock-button public-mock-primary" onClick={() => setStep(step + 1)}>
                Next
              </button>
            )}
          </div>
        </section>
      ) : null}
      {panel === "install" ? (
        <section className="public-mock-panel public-mock-install-panel" role="dialog" aria-labelledby="public-mock-install-title">
          <h2 id="public-mock-install-title" ref={heading} tabIndex={-1}>
            Run SpaceApp on your machine
          </h2>
          <p>One command installs and starts it. You need Node.js 20.11 or newer; Docker is installed if it is missing.</p>
          <div className="public-mock-command">
            <code>{INSTALL_COMMAND}</code>
            <button type="button" className="public-mock-button" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="public-mock-panel-actions">
            <button type="button" className="public-mock-link" onClick={() => setPanel(null)}>
              Close
            </button>
            <a className="public-mock-button public-mock-primary" href={INSTALL_GUIDE_URL} target="_blank" rel="noopener noreferrer">
              Installation guide
            </a>
          </div>
        </section>
      ) : null}
    </>
  );
}
