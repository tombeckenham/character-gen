import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { FACE_KINDS, selectSpinnerFrames } from "@character-gen/engine/gallery-data";
import type { GalleryAssetEntry, GalleryCharacter } from "@character-gen/engine/gallery-data";
import { StatusChips } from "./components.tsx";
import { useGallery } from "./data.ts";
import { Lightbox } from "./Lightbox.tsx";
import type { LightboxImage } from "./Lightbox.tsx";
import { TurnaroundSpinner } from "./Spinner.tsx";

const FACE_LABELS: Record<string, string> = {
  face_front: "front",
  face_three_quarter: "three-quarter",
  face_profile: "profile",
};

const PROFILE_FIELDS = [
  ["archetype", "Archetype"],
  ["personality", "Personality"],
  ["backstory", "Backstory"],
  ["visualCanon", "Visual canon"],
  ["voiceDescription", "Voice"],
] as const;

interface SectionImage {
  asset: GalleryAssetEntry;
  caption: string;
}

interface GallerySection {
  title: string;
  images: SectionImage[];
  gridClass: string;
}

/** Newest asset per key — a re-run pass replaces its earlier images (assets
 * arrive oldest-first, so the last entry per key wins). */
function latestBy(
  assets: readonly GalleryAssetEntry[],
  key: (asset: GalleryAssetEntry) => string,
): GalleryAssetEntry[] {
  const byKey = new Map<string, GalleryAssetEntry>();
  for (const asset of assets) byKey.set(key(asset), asset);
  return [...byKey.values()];
}

/**
 * The detail page's image sections, in display order. Sections render only
 * when their assets exist — the same progressive pattern as the spinner, so a
 * rich sheet fills the page in section by section while the CLI works.
 */
// One declarative table of the five sections; splitting it would scatter the
// display order and caption rules.
// oxlint-disable-next-line max-lines-per-function
function buildSections(character: GalleryCharacter): GallerySection[] {
  const { assets } = character;
  const faces = FACE_KINDS.flatMap((kind) =>
    latestBy(
      assets.filter((asset) => asset.kind === kind),
      () => kind,
    ),
  ).map((asset) => ({ asset, caption: FACE_LABELS[asset.kind] ?? asset.kind }));

  const sheet = latestBy(
    assets.filter(
      (asset) =>
        asset.kind === "master" ||
        asset.kind === "outfit" ||
        (asset.kind === "expression" && asset.label === undefined),
    ),
    (asset) => asset.kind,
  )
    .toSorted(
      (a, b) =>
        ["master", "expression", "outfit"].indexOf(a.kind) -
        ["master", "expression", "outfit"].indexOf(b.kind),
    )
    .map((asset) => ({
      asset,
      caption: asset.kind === "expression" ? "expression sheet" : asset.kind,
    }));

  const expressions = latestBy(
    assets.filter((asset) => asset.kind === "expression" && asset.label !== undefined),
    (asset) => asset.label ?? "",
  ).map((asset) => ({ asset, caption: asset.label ?? "expression" }));

  const details = latestBy(
    assets.filter((asset) => asset.kind === "detail"),
    (asset) => asset.subject ?? asset.path,
  ).map((asset) => ({ asset, caption: asset.caption ?? asset.subject ?? "detail" }));

  const scale = latestBy(
    assets.filter((asset) => asset.kind === "scale"),
    (asset) => asset.kind,
  ).map((asset) => ({ asset, caption: "full-body scale reference" }));

  return [
    { title: "Face", images: faces, gridClass: "grid-cols-3 max-w-2xl" },
    {
      title: "Character sheet",
      images: sheet,
      gridClass: "grid-cols-[repeat(auto-fill,minmax(200px,1fr))]",
    },
    {
      title: "Expressions",
      images: expressions,
      gridClass: "grid-cols-[repeat(auto-fill,minmax(160px,1fr))]",
    },
    {
      title: "Details",
      images: details,
      gridClass: "grid-cols-[repeat(auto-fill,minmax(200px,1fr))]",
    },
    { title: "Scale", images: scale, gridClass: "grid-cols-1 max-w-60" },
  ].filter((section) => section.images.length > 0);
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="mt-10 mb-3 font-heading text-xs font-semibold tracking-[0.25em] text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

function ImageSection({
  section,
  name,
  onOpen,
}: {
  section: GallerySection;
  name: string;
  onOpen: (path: string) => void;
}) {
  return (
    <section>
      <SectionTitle>{section.title}</SectionTitle>
      <div className={`grid gap-3 ${section.gridClass}`}>
        {section.images.map(({ asset, caption }) => (
          <figure key={asset.path} className="m-0">
            <button
              type="button"
              className="block w-full cursor-zoom-in rounded-md focus-visible:outline-2"
              onClick={() => onOpen(asset.path)}
              aria-label={`${name} — ${caption} (open fullscreen)`}
            >
              <img
                src={asset.path}
                alt={`${name} — ${caption}`}
                loading="lazy"
                className="w-full rounded-md ring-1 ring-foreground/10 transition-shadow hover:ring-foreground/30"
              />
            </button>
            <figcaption className="mt-1.5 text-xs text-muted-foreground">{caption}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

function VoiceClips({ character }: { character: GalleryCharacter }) {
  const clips = character.assets.filter(
    (asset) => asset.kind === "voice_sample" || asset.kind === "speech",
  );
  if (clips.length === 0) {
    return <p className="text-muted-foreground italic">Not designed yet.</p>;
  }
  let spokenLines = 0;
  const labelled = clips.map((clip) => {
    if (clip.kind === "voice_sample") return { clip, label: "Signature voice" };
    spokenLines += 1;
    return { clip, label: `Spoken line ${spokenLines}` };
  });
  return (
    <div className="flex max-w-md flex-col gap-3">
      {labelled.map(({ clip, label }) => (
        <figure
          key={clip.path}
          className="m-0 rounded-md bg-foreground/5 px-3 py-2.5 ring-1 ring-foreground/10"
        >
          <figcaption className="mb-1.5 text-xs tracking-[0.12em] text-muted-foreground uppercase">
            {label}
          </figcaption>
          <audio controls preload="none" src={clip.path} className="block w-full" />
        </figure>
      ))}
    </div>
  );
}

function ProfileFields({ character }: { character: GalleryCharacter }) {
  const fields = PROFILE_FIELDS.filter(([key]) => character[key]);
  if (fields.length === 0) return null;
  return (
    <dl className="m-0 grid gap-4">
      {fields.map(([key, label]) => (
        <div key={key}>
          <dt className="text-xs font-semibold tracking-[0.2em] text-muted-foreground uppercase">
            {label}
          </dt>
          <dd className="mt-0.5 ml-0 text-sm">{character[key]}</dd>
        </div>
      ))}
    </dl>
  );
}

// One linear page layout; the sections are already extracted into components.
// oxlint-disable-next-line max-lines-per-function
export function DetailPage() {
  const { identifier } = useParams({ from: "/c/$identifier" });
  const { data } = useGallery();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const character = data?.characters.find((entry) => entry.identifier === identifier);

  if (data === null) {
    return (
      <main className="mx-auto max-w-5xl px-6 pt-10 pb-16">
        <p className="text-muted-foreground italic">waiting for data.js…</p>
      </main>
    );
  }
  if (!character) {
    return (
      <main className="mx-auto max-w-5xl px-6 pt-10 pb-16">
        <p className="text-muted-foreground italic">No character “{identifier}”.</p>
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← gallery
        </Link>
      </main>
    );
  }

  const sections = buildSections(character);
  const flatImages = sections.flatMap((section) => section.images);
  const lightboxImages: LightboxImage[] = flatImages.map(({ asset, caption }) => ({
    path: asset.path,
    title: `${character.name} — ${caption}`,
    caption,
  }));
  const openAt = (path: string): void => {
    const index = flatImages.findIndex(({ asset }) => asset.path === path);
    if (index >= 0) setLightboxIndex(index);
  };

  // Data-contract mount points: the turnaround section renders the
  // drag-to-scrub spinner fed by `angle_*` assets; the voice section plays
  // `voice_sample`/`speech` clips.
  const angleFrames = selectSpinnerFrames(character.assets);

  return (
    <main className="mx-auto max-w-5xl px-6 pt-10 pb-16">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← gallery
      </Link>
      <header className="mt-4 mb-2">
        <h1 className="m-0 font-heading text-3xl font-semibold">{character.name}</h1>
        {character.archetype && (
          <p className="m-0 mt-1 text-muted-foreground">{character.archetype}</p>
        )}
        <div className="mt-3">
          <StatusChips character={character} />
        </div>
      </header>

      {sections.length === 0 && (
        <section>
          <SectionTitle>Character sheet</SectionTitle>
          <p className="text-muted-foreground italic">No sheet images yet.</p>
        </section>
      )}
      {sections.map((section) => (
        <ImageSection key={section.title} section={section} name={character.name} onOpen={openAt} />
      ))}

      <section data-mount="turnaround">
        <SectionTitle>Turnaround</SectionTitle>
        {angleFrames.length > 0 ? (
          <TurnaroundSpinner frames={angleFrames} name={character.name} />
        ) : (
          <p className="text-muted-foreground italic">Not generated yet.</p>
        )}
      </section>

      <section>
        <SectionTitle>Profile</SectionTitle>
        <ProfileFields character={character} />
      </section>

      <section data-mount="voice">
        <SectionTitle>Voice</SectionTitle>
        <VoiceClips character={character} />
      </section>

      {lightboxIndex !== null && (
        <Lightbox
          images={lightboxImages}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
        />
      )}
    </main>
  );
}
