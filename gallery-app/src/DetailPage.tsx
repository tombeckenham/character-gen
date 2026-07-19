import { Link, useParams } from "@tanstack/react-router";
import type { GalleryCharacter } from "@character-gen/engine/gallery-data";
import { StatusChips } from "./components.tsx";
import { useGallery } from "./data.ts";

/** Sheet image kinds shown in the images section, in display order. */
const SHEET_KINDS = ["master", "expression", "outfit"] as const;

const PROFILE_FIELDS = [
  ["archetype", "Archetype"],
  ["personality", "Personality"],
  ["backstory", "Backstory"],
  ["visualCanon", "Visual canon"],
  ["voiceDescription", "Voice"],
] as const;

function SheetImages({ character }: { character: GalleryCharacter }) {
  const images = character.assets.filter((asset) =>
    (SHEET_KINDS as readonly string[]).includes(asset.kind),
  );
  if (images.length === 0) {
    return <p className="empty">No sheet images yet.</p>;
  }
  return (
    <div className="sheet-grid">
      {images.map((asset) => (
        <figure key={asset.path} className="sheet-figure">
          <img src={asset.path} alt={`${character.name} — ${asset.kind}`} />
          <figcaption>{asset.kind}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function ProfileFields({ character }: { character: GalleryCharacter }) {
  const fields = PROFILE_FIELDS.filter(([key]) => character[key]);
  if (fields.length === 0) return null;
  return (
    <dl className="profile">
      {fields.map(([key, label]) => (
        <div key={key} className="profile-row">
          <dt>{label}</dt>
          <dd>{character[key]}</dd>
        </div>
      ))}
    </dl>
  );
}

// One linear page layout; the sections are already extracted into components.
// oxlint-disable-next-line max-lines-per-function
export function DetailPage() {
  const { identifier } = useParams({ from: "/c/$identifier" });
  const data = useGallery();
  const character = data?.characters.find((entry) => entry.identifier === identifier);

  if (data === null) {
    return (
      <main className="page">
        <p className="empty">waiting for data.js…</p>
      </main>
    );
  }
  if (!character) {
    return (
      <main className="page">
        <p className="empty">No character “{identifier}”.</p>
        <Link to="/" className="back">
          ← gallery
        </Link>
      </main>
    );
  }

  // Data contract mount points for later phases: PR4 replaces the turnaround
  // placeholder with the drag-to-scrub spinner fed by `angle_*` assets; PR5
  // fills the voice section from `voice_sample`/`speech` assets.
  const angleFrames = character.assets.filter((asset) => asset.kind.startsWith("angle_"));
  const voiceAssets = character.assets.filter(
    (asset) => asset.kind === "voice_sample" || asset.kind === "speech",
  );

  return (
    <main className="page">
      <Link to="/" className="back">
        ← gallery
      </Link>
      <header className="detail-head">
        <h1>{character.name}</h1>
        {character.archetype && <p className="archetype">{character.archetype}</p>}
        <StatusChips character={character} />
      </header>

      <section>
        <h2 className="section-title">Character sheet</h2>
        <SheetImages character={character} />
      </section>

      <section>
        <h2 className="section-title">Profile</h2>
        <ProfileFields character={character} />
      </section>

      <section data-mount="turnaround">
        <h2 className="section-title">Turnaround</h2>
        <p className="empty">
          {angleFrames.length > 0
            ? `${angleFrames.length} frames ready — spinner coming soon.`
            : "Not generated yet."}
        </p>
      </section>

      <section data-mount="voice">
        <h2 className="section-title">Voice</h2>
        <p className="empty">
          {voiceAssets.length > 0
            ? `${voiceAssets.length} clip${voiceAssets.length === 1 ? "" : "s"} ready — player coming soon.`
            : "Not designed yet."}
        </p>
      </section>
    </main>
  );
}
