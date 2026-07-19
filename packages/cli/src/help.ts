export const ROOT_HELP = `character-gen — agent-first character generator (fal.ai)

Usage:
  character-gen <command> [options]

Commands:
  create "<description>"   Invent + run the pipeline for a new character
                           (--tier rich|full for face/expression/detail passes)
  list                     List all characters
  show <id|identifier>     Print a character's profile and assets
  sheet <char>             (Re)generate master sheet + expressions
  turnaround <char>        Generate the 12-angle spin frames
  voice <char>             Design (or preset) the character's voice
  voices                   List the TTS models and their preset voices
  speak <char> "<line>"    Speak a line in the character's voice
  extract <script-file>    Print a script's text for cast extraction
  publish <char>           Create/update the character on fal Assets (via genmedia)
  open                     Write the gallery and open it in a browser
  setup                    Store and validate your fal API key
  doctor                   Diagnose environment, key, and fal connectivity

Run 'character-gen <command> --help' for command-specific options.
`;

export const COMMAND_HELP: Record<string, string> = {
  create: `character-gen create "<description>" [--profile-json <file>] [--steps <list>] [--tier core|rich|full]
  Invent a profile (or take one via --profile-json) and run the pipeline.
  Steps available now: profile, sheet, turnaround, voice — profile, sheet, and
  turnaround run by default (the 12-frame turnaround adds 12 generations; skip it
  with --steps profile,sheet). Voice design is opt-in: add it with
  --steps profile,sheet,turnaround,voice.
  Creating the character (the profile step) always happens first, so --steps
  sheet still creates it, then generates the sheet. --surprise is designed for
  the cast skill; for now pass --profile-json directly.
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
  Generate 12 turnaround views at 30° increments from the master image.
  Requires a completed sheet (run character-gen sheet first). The gallery
  detail page renders the frames as a drag-to-scrub spinner.`,
  voice: `character-gen voice <char>
  Establish the character's voice, controlled by the profile's "voice" block:
    "voice": { "model": "minimax", "preset": "Wise_Woman" }
  With a preset (or a preset-only model), speaks a preview line in that stock
  voice. With a design-capable model and no preset (default: minimax), designs a
  bespoke voice from voiceDescription (falling back to archetype/personality) and
  stores a reusable custom voice. Either way a preview clip is saved. Run
  \`character-gen voices\` to see the models and presets. Run before speak.`,
  voices: `character-gen voices
  List the available TTS models, whether each can design a bespoke voice, and
  their preset voices — the values you put in a profile's "voice" block
  ("model" and "preset"). Pure local lookup; no key or network needed.`,
  speak: `character-gen speak <char> "<line>" [--emotion <emotion>]
  Speak a line in the character's voice. Uses the profile's "voice.preset" if
  set, else a previously designed voice, else a preset-only model's default.
  --emotion is one of: happy, sad, angry, fearful, disgusted, surprised, neutral
  (applied where the model supports it; seed-speech steers delivery, elevenlabs
  ignores it).`,
  extract: `character-gen extract <script-file>
  Print the script's text to stdout. The cast skill reads it and does the
  actual character extraction (Claude is the parser); this command just gives
  the flow a stable file-reading contract.`,
  publish: `character-gen publish <char>
  Create or update the character on the fal Assets Characters API by shelling
  out to the genmedia CLI (must be on PATH). Sends up to 20 prioritized image
  request_ids as reference_images, the master image as the cover, and a
  description distilled from the profile. Re-publishing a character that
  already has a fal id updates it in place.
  The Assets write endpoints need an ADMIN-scoped key: set FAL_ADMIN_KEY (it
  beats the regular key chain for this command). Create one at
  https://fal.ai/dashboard/keys.`,
  open: `character-gen open [--no-browser]
  Write the gallery files and open the file:// URL in a browser.
  --no-browser writes the gallery and prints the URL without opening it.`,
  setup: `character-gen setup [--api-key <key>]
  Prompt for (or accept) a fal API key, validate it, and store it (0600).`,
  doctor: `character-gen doctor
  Report Node version, active key source, fal ping, config dir, characters dir, and store health.`,
};
