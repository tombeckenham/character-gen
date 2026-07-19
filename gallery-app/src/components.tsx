import { PIPELINE_STEPS } from "@character-gen/engine/gallery-data";
import type { GalleryCharacter } from "@character-gen/engine/gallery-data";

/** Per-step status chips (profile / sheet / turnaround / voice / publish). */
export function StatusChips({ character }: { character: GalleryCharacter }) {
  return (
    <ul className="chips">
      {PIPELINE_STEPS.map((step) => (
        <li
          key={step}
          className={`chip chip-${character.status[step]}`}
          title={`${step}: ${character.status[step]}`}
        >
          {step}
        </li>
      ))}
    </ul>
  );
}

/** The card/detail hero image: the master sheet, or a monogram placeholder. */
export function Portrait({ character }: { character: GalleryCharacter }) {
  const master = character.assets.find((asset) => asset.kind === "master");
  if (master) {
    return <img className="portrait" src={master.path} alt={`${character.name} — master sheet`} />;
  }
  return (
    <div className="portrait portrait-empty" aria-label={`${character.name} — no image yet`}>
      <span>{character.name.slice(0, 1).toUpperCase()}</span>
    </div>
  );
}
