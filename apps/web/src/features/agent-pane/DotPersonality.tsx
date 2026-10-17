import { useState } from "react";
import { dotMoods, dotPersonalities, type DotMood, type DotProfile } from "@space/contracts";
import { DotAvatar } from "./DotAvatar.js";

const tones = [["polite", "Polite"], ["strict", "Strict or in a hurry"], ["professional", "Professional"], ["casual", "Casual"]] as const;
const moodLabel = (mood: DotMood) => mood[0]!.toUpperCase() + mood.slice(1);

/** Settings → Dots → Personality: who the Dot is, how it answers each tone, and every expression it can show. */
export function DotPersonalityPanel({ dot }: { dot: DotProfile }) {
  const character = dot.appearance.character;
  const personality = dotPersonalities[character];
  const [picked, setPicked] = useState<DotMood | null>(null);
  const [hovered, setHovered] = useState<DotMood | null>(null);
  return <section className="dots-personality" aria-label={`${dot.name}'s personality`}>
    <div className="dots-personality-head">
      <DotAvatar character={character} mood={hovered ?? picked ?? "idle"} size={88} />
      <div>
        <strong>{personality.archetype}</strong>
        <p>{personality.summary}</p>
        <ul className="dots-personality-traits" aria-label="Traits">{personality.traits.map((trait) => <li key={trait}>{trait}</li>)}</ul>
      </div>
    </div>
    <h4>How {dot.name} answers your tone</h4>
    <dl className="dots-personality-tones">
      {tones.map(([tone, label]) => <div key={tone}><dt>{label}</dt><dd>{personality.towards[tone]}</dd></div>)}
    </dl>
    <p className="dots-panel-hint">{dot.name} reads how each message is written and reacts in character. Your communication style in Profile wins where they differ.</p>
    <h4>Expressions</h4>
    <ul className="dots-expressions" aria-label={`${dot.name}'s expressions`}>
      {dotMoods.map((mood) => <li key={mood}>
        <button type="button" className="dots-expression" aria-pressed={picked === mood} onClick={() => setPicked((value) => value === mood ? null : mood)}
          onPointerEnter={() => setHovered(mood)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(mood)} onBlur={() => setHovered(null)}>
          <DotAvatar character={character} mood={mood} size={52} motion={hovered === mood || picked === mood ? "on" : "off"} />
          <span>{moodLabel(mood)}</span>
        </button>
      </li>)}
    </ul>
  </section>;
}
