import { useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check } from "lucide-react";

type SubmissionState = "idle" | "submitting" | "success" | "error";

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<SubmissionState>("idle");
  const submittingRef = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !consent || submittingRef.current) return;
    submittingRef.current = true;
    setState("submitting");
    try {
      const response = await fetch("/api/public/waitlist", {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail, consent: true, website })
      });
      if (!response.ok) throw new Error("Waitlist request failed");
      setState("success");
    } catch {
      setState("error");
    } finally {
      submittingRef.current = false;
    }
  }

  return (
    <form className="homepage-waitlist-form" onSubmit={submit} noValidate={false}>
      <label htmlFor="homepage-waitlist-email">Email address</label>
      <div className="homepage-waitlist-row">
        <input
          id="homepage-waitlist-email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          required
          value={email}
          disabled={state === "success"}
          onChange={(event) => {
            setEmail(event.currentTarget.value);
            if (state === "error") setState("idle");
          }}
        />
        <button type="submit" disabled={state === "submitting" || state === "success"}>
          {state === "success" ? <Check aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
          <span>{state === "submitting" ? "Joining…" : state === "success" ? "Joined" : "Join the waitlist"}</span>
        </button>
      </div>
      <label className="homepage-consent" htmlFor="homepage-waitlist-consent">
        <input
          id="homepage-waitlist-consent"
          name="consent"
          type="checkbox"
          required
          checked={consent}
          disabled={state === "success"}
          onChange={(event) => {
            setConsent(event.currentTarget.checked);
            if (state === "error") setState("idle");
          }}
        />
        <span>Email me about Space preview access and launch updates.</span>
      </label>
      <div className="homepage-honeypot" aria-hidden="true">
        <label htmlFor="homepage-waitlist-website">Website</label>
        <input
          id="homepage-waitlist-website"
          name="website"
          type="text"
          autoComplete="off"
          tabIndex={-1}
          maxLength={200}
          value={website}
          onChange={(event) => setWebsite(event.currentTarget.value)}
        />
      </div>
      {state === "success" ? <p className="homepage-form-success" role="status">You're on the list. We'll share preview access by email.</p> : null}
      {state === "error" ? <p className="homepage-form-error" role="alert">We couldn't add you right now. Please check your connection and try again.</p> : null}
      {state === "idle" || state === "submitting" ? <p className="homepage-form-note">Private preview updates only. No noise.</p> : null}
    </form>
  );
}
