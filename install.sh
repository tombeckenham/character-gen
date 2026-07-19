#!/bin/sh
# character-gen installer: clone (or update), install deps, build the gallery,
# shim the CLI into ~/.local/bin, and install the Claude Code skill.
#
#   curl -fsSL https://raw.githubusercontent.com/tombeckenham/character-gen/main/install.sh | sh
#
# Requirements: git, Node >= 22.18 (runtime), and bun (deps + gallery build).
set -eu

REPO_URL="https://github.com/tombeckenham/character-gen.git"
APP_DIR="${CHARACTER_GEN_APP_DIR:-$HOME/.character-gen/app}"
BIN_DIR="${CHARACTER_GEN_BIN_DIR:-$HOME/.local/bin}"
SKILL_DIR="$HOME/.claude/skills/cast"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}

# --- prerequisites ----------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "git is required."
command -v node >/dev/null 2>&1 || fail "Node.js >= 22.18 is required (https://nodejs.org)."

node -e '
  const [maj, min] = process.versions.node.split(".").map(Number);
  process.exit(maj > 22 || (maj === 22 && min >= 18) ? 0 : 1);
' || fail "Node $(node --version) is too old — the CLI runs TypeScript directly via type stripping (need >= 22.18)."

command -v bun >/dev/null 2>&1 || fail "bun is required for install/build (https://bun.sh — curl -fsSL https://bun.sh/install | bash)."

# --- clone or update --------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  say "Updating existing checkout at ${APP_DIR}…"
  git -C "$APP_DIR" pull --ff-only
else
  say "Cloning character-gen into ${APP_DIR}…"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

say "Installing dependencies…"
(cd "$APP_DIR" && bun install --frozen-lockfile)

say "Building the gallery…"
(cd "$APP_DIR" && bun run build:gallery)

# --- CLI shim ---------------------------------------------------------------
mkdir -p "$BIN_DIR"
SHIM="$BIN_DIR/character-gen"
cat >"$SHIM" <<EOF
#!/bin/sh
exec node "$APP_DIR/packages/cli/src/index.ts" "\$@"
EOF
chmod +x "$SHIM"
say "CLI shim installed: $SHIM"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "NOTE: $BIN_DIR is not on your PATH — add it to your shell profile." ;;
esac

# --- Claude Code skill ------------------------------------------------------
mkdir -p "$(dirname "$SKILL_DIR")"
rm -rf "$SKILL_DIR"
cp -R "$APP_DIR/skills/cast" "$SKILL_DIR"
say "Claude Code skill installed: $SKILL_DIR"

# --- key detection ----------------------------------------------------------
if [ -n "${FAL_KEY:-}" ]; then
  say "fal key: using FAL_KEY from the environment."
elif [ -f "$HOME/.genmedia/config.json" ]; then
  say "fal key: will try to reuse ~/.genmedia/config.json (run 'character-gen doctor' to verify)."
else
  say "fal key: none found — run 'character-gen setup' to store one."
fi

say ""
say "Done. Try: character-gen doctor"
