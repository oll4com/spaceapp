import { useState } from "react";
import { dotMoods, dotPersonalities, type DotMood, type DotProfile } from "@space/contracts";
import { DotAvatar } from "./DotAvatar.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

const tones = [["polite", "Polite"], ["strict", "Strict or in a hurry"], ["professional", "Professional"], ["casual", "Casual"]] as const;
const moodLabel = (mood: DotMood) => mood[0]!.toUpperCase() + mood.slice(1);

/** Settings → Dots → Personality: who the Dot is, how it answers each tone, and every expression it can show. */
export function DotPersonalityPanel({ dot }: { dot: DotProfile }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const character = dot.appearance.character;
  const personality = dotPersonalities[character];
  const [picked, setPicked] = useState<DotMood | null>(null);
  const [hovered, setHovered] = useState<DotMood | null>(null);
  return <section className="dots-personality" aria-label={t("{name}'s personality", { name: dot.name })}>
    <div className="dots-personality-head">
      <DotAvatar character={character} mood={hovered ?? picked ?? "idle"} size={88} />
      <div>
        <strong>{personality.archetype}</strong>
        <p>{personality.summary}</p>
        <ul className="dots-personality-traits" aria-label={t("Traits")}>{personality.traits.map((trait) => <li key={trait}>{trait}</li>)}</ul>
      </div>
    </div>
    <h4>{t("How {name} answers your tone", { name: dot.name })}</h4>
    <dl className="dots-personality-tones">
      {tones.map(([tone, label]) => <div key={tone}><dt>{t(label)}</dt><dd>{personality.towards[tone]}</dd></div>)}
    </dl>
    <p className="dots-panel-hint">{t("{name} reads how each message is written and reacts in character. Your communication style in Profile wins where they differ.", { name: dot.name })}</p>
    <h4>{t("Expressions")}</h4>
    <ul className="dots-expressions" aria-label={t("{name}'s expressions", { name: dot.name })}>
      {dotMoods.map((mood) => <li key={mood}>
        <button type="button" className="dots-expression" aria-pressed={picked === mood} onClick={() => setPicked((value) => value === mood ? null : mood)}
          onPointerEnter={() => setHovered(mood)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(mood)} onBlur={() => setHovered(null)}>
          <DotAvatar character={character} mood={mood} size={52} motion={hovered === mood || picked === mood ? "on" : "off"} />
          <span>{t(moodLabel(mood))}</span>
        </button>
      </li>)}
    </ul>
  </section>;
}
