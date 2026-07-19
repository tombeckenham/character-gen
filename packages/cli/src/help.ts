export const ROOT_HELP = `character-gen — agent-first character generator (fal.ai)

Usage:
  character-gen <command> [options]

Commands:
  create "<description>"   Invent + run the pipeline for a new character
                           (--tier rich|full for face/expression/detail passes)
  list                     List all characters
  show <id|identifier>     Print a character's profile and assets
  sheet <char>             (Re)generate master sheet + expressions
  turnaround <char>        Generate the 8-angle spin frames
  voice <char>             Design the character's signature voice            (coming soon)
  speak <char> "<line>"    Speak a line in the character's voice             (coming soon)
  extract <script-file>    Emit cast JSON from a script                      (coming soon)
  publish <char>           Create/update the character on fal Assets         (coming soon)
  open                     Write the gallery and open it in a browser
  setup                    Store and validate your fal API key
  doctor                   Diagnose environment, key, and fal connectivity

Run 'character-gen <command> --help' for command-specific options.
`;

export const COMMAND_HELP: Record<string, string> = {
  create: `character-gen create "<description>" [--profile-json <file>] [--steps <list>] [--tier core|rich|full]
  Invent a profile (or take one via --profile-json) and run the pipeline.
  Steps available now: profile, sheet, turnaround — all three run by default
  (the 8-frame turnaround adds 8 generations; skip it with --steps profile,sheet).
  Creating the character (the profile step) always happens first, so --steps
  sheet still creates it, then generates the sheet. --surprise is designed for
  the create-character skill; for now pass --profile-json directly.
  --tier adds rich-sheet passes after the core sheet (default core = none):
    core  master + expression grid + outfit               (3 generations)
    rich  core + face triptych + 4 expressions + 2 details (12 generations)
    full  rich + scale + up to 4 details                   (15 generations)`,
  list: `character-gen list
  List all locally stored characters.`,
  show: `character-gen show <id|identifier>
  Print the character's profile JSON and its assets.`,
  sheet: `character-gen sheet <char> [--tier core|rich|full] [--passes <list>]
  (Re)generate the master reference sheet and expression variants.
  --tier regenerates the core sheet plus that tier's extra passes:
    core  master + expression grid + outfit               (3 generations)
    rich  core + face triptych + 4 expressions + 2 details (12 generations)
    full  rich + scale + up to 4 details                   (15 generations)
  --passes face,expressions,details,scale reruns just those passes off the
  existing master (retry granularity — no core regeneration). The two flags
  are mutually exclusive. Passes stop at the first failure; nothing generates
  past a failed pass.`,
  turnaround: `character-gen turnaround <char>
  Generate 8 turnaround views at 45° increments from the master image.
  Requires a completed sheet (run character-gen sheet first). The gallery
  detail page renders the frames as a drag-to-scrub spinner.`,
  voice: `character-gen voice <char>
  Design the character's signature voice from its voice description.`,
  speak: `character-gen speak <char> "<line>"
  Speak a line using the character's designed voice.`,
  extract: `character-gen extract <script-file>
  Parse a script to text and emit cast JSON for the skill to iterate on.`,
  publish: `character-gen publish <char>
  Create or update the character on the fal Assets Characters API.`,
  open: `character-gen open [--no-browser]
  Write the gallery files and open the file:// URL in a browser.
  --no-browser writes the gallery and prints the URL without opening it.`,
  setup: `character-gen setup [--api-key <key>]
  Prompt for (or accept) a fal API key, validate it, and store it (0600).`,
  doctor: `character-gen doctor
  Report Node version, active key source, fal ping, state dir, and DB health.`,
};
