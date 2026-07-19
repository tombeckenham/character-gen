import { PIPELINE_STEPS, selectSpinnerFrames } from "@character-gen/engine/gallery-data";
import type {
  GalleryAssetEntry,
  GalleryCharacter,
  StepState,
} from "@character-gen/engine/gallery-data";
import { Badge } from "@/components/ui/badge";
import { TurnaroundSpinner } from "./Spinner.tsx";

const STEP_BADGE: Record<StepState, string> = {
  pending: "border-border bg-transparent text-muted-foreground/70",
  running: "animate-pulse border-sky-500/30 bg-sky-500/15 text-sky-300",
  done: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
  error: "border-red-500/30 bg-red-500/15 text-red-300",
};

/** Per-step status chips (profile / sheet / turnaround / voice / publish). */
export function StatusChips({ character }: { character: GalleryCharacter }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
      {PIPELINE_STEPS.map((step) => (
        <li key={step}>
          <Badge
            variant="outline"
            className={STEP_BADGE[character.status[step]]}
            title={`${step}: ${character.status[step]}`}
          >
            {step}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** The card/detail hero: the face close-up when present, else the master. */
export function heroAsset(character: GalleryCharacter): GalleryAssetEntry | undefined {
  return (
    character.assets.find((asset) => asset.kind === "face_front") ??
    character.assets.find((asset) => asset.kind === "master")
  );
}

/** The card hero: the drag-to-scrub spinner when turnaround frames exist,
 * else face_front > master > a monogram placeholder. */
export function Portrait({ character }: { character: GalleryCharacter }) {
  const frames = selectSpinnerFrames(character.assets);
  if (frames.length > 0) {
    return <TurnaroundSpinner frames={frames} name={character.name} variant="card" />;
  }
  const hero = heroAsset(character);
  if (hero) {
    return (
      <img
        className="aspect-3/4 w-full object-cover object-top"
        src={hero.path}
        alt={`${character.name} — ${hero.kind === "face_front" ? "face" : "master sheet"}`}
      />
    );
  }
  return (
    <div
      className="flex aspect-3/4 w-full items-center justify-center bg-muted/30"
      aria-label={`${character.name} — no image yet`}
    >
      <span className="font-heading text-6xl font-semibold text-muted-foreground/60">
        {character.name.slice(0, 1).toUpperCase()}
      </span>
    </div>
  );
}
