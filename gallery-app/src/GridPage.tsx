import { Link } from "@tanstack/react-router";
import { Portrait, StatusChips } from "./components.tsx";
import { useGallery } from "./data.ts";

export function GridPage() {
  const data = useGallery();
  return (
    <main className="page">
      <header className="masthead">
        <h1>character-gen</h1>
        <p className="sub">
          {data === null
            ? "waiting for data.js…"
            : `${data.characters.length} character${data.characters.length === 1 ? "" : "s"} · live`}
        </p>
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
