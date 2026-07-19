import { Link } from "@tanstack/react-router";
import { Portrait, StatusChips } from "./components.tsx";
import { useGallery } from "./data.ts";
import type { GalleryState } from "./data.ts";

function Masthead({ data, stale }: GalleryState) {
  if (data === null) {
    return (
      <p className="sub">
        {stale ? (
          <span className="stale">data.js is missing — gallery not written?</span>
        ) : (
          "waiting for data.js…"
        )}
      </p>
    );
  }
  const count = `${data.characters.length} character${data.characters.length === 1 ? "" : "s"}`;
  return (
    <p className="sub">
      {count} ·{" "}
      {stale ? <span className="stale">connection lost — showing last known data</span> : "live"}
    </p>
  );
}

export function GridPage() {
  const { data, stale } = useGallery();
  return (
    <main className="page">
      <header className="masthead">
        <h1>character-gen</h1>
        <Masthead data={data} stale={stale} />
      </header>
      {data !== null && data.characters.length === 0 && (
        <p className="empty">No characters yet — ask Claude to create one.</p>
      )}
      <div className="grid">
        {data?.characters.map((character) => (
          <Link
            key={character.identifier}
            to="/c/$identifier"
            params={{ identifier: character.identifier }}
            className="card"
          >
            <Portrait character={character} />
            <div className="card-body">
              <h2>{character.name}</h2>
              {character.archetype && <p className="archetype">{character.archetype}</p>}
              <StatusChips character={character} />
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
