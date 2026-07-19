import { Link } from "@tanstack/react-router";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Portrait, StatusChips } from "./components.tsx";
import { useGallery } from "./data.ts";
import type { GalleryState } from "./data.ts";

function Masthead({ data, stale }: GalleryState) {
  if (data === null) {
    return (
      <p className="m-0 mt-1 text-sm text-muted-foreground">
        {stale ? (
          <span className="text-red-400">data.js is missing — gallery not written?</span>
        ) : (
          "waiting for data.js…"
        )}
      </p>
    );
  }
  const count = `${data.characters.length} character${data.characters.length === 1 ? "" : "s"}`;
  return (
    <p className="m-0 mt-1 text-sm text-muted-foreground">
      {count} ·{" "}
      {stale ? (
        <span className="text-red-400">connection lost — showing last known data</span>
      ) : (
        "live"
      )}
    </p>
  );
}

export function GridPage() {
  const { data, stale } = useGallery();
  return (
    <main className="mx-auto max-w-6xl px-6 pt-10 pb-16">
      <header className="mb-8">
        <h1 className="m-0 font-heading text-xl font-semibold tracking-[0.35em] uppercase">
          character-gen
        </h1>
        <Masthead data={data} stale={stale} />
      </header>
      {data !== null && data.characters.length === 0 && (
        <p className="text-muted-foreground italic">
          No characters yet — ask Claude to create one.
        </p>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
        {data?.characters.map((character) => (
          <Link
            key={character.identifier}
            to="/c/$identifier"
            params={{ identifier: character.identifier }}
            className="group focus-visible:outline-2"
          >
            <Card className="h-full pt-0 transition-shadow group-hover:ring-foreground/25">
              <Portrait character={character} />
              <CardHeader>
                <CardTitle>{character.name}</CardTitle>
                {character.archetype && <CardDescription>{character.archetype}</CardDescription>}
                <StatusChips character={character} />
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </main>
  );
}
