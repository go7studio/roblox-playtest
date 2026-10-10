# Walking the game like a player

Smoke tests prove systems work. A walk proves a new player can understand and enjoy them. Do one after
any change a player will see, and before every publish.

Tools: `nav` (walk the character), `keys` (keyboard), `click` (GUI by instance path), `probe` (the game's
client probe: read UI state or press a menu button the same way a click does), `hook` (set up a
situation), `shot` (screenshot; look at every one), `console` (errors).

## Rules

- Play as a first-time player: fresh profile (mock data), no dev shortcuts until the step needs one.
- Press real buttons. Prefer `click LocalPlayer.PlayerGui...` or the probe's press command over calling
  services, so the button's own click code runs.
- After each step take a `shot` and read it. Check: is the next action obvious? Is any text longer than
  a few words? Does anything overlap, cut off, or cover the character?
- Watch `console --grep Error --tail 20` after each step. A walk with new errors is a failed walk.
- Use dev shortcuts (`hook pin true`, force a level, grant coins) only to reach a state that would take
  minutes to reach naturally, and say so in the report.

## First-time-player checklist

1. **Join**: title screen shows, one clear action button. `shot`.
2. **Start**: press it (`click` / `probe title play`). Countdown or tutorial is readable. `shot`.
3. **First seconds**: move (`keys W:1500`, `keys A:600 D:600`, `keys Space`). The player isn't killed or
   flung in the first 10 s; controls hint is visible. `shot`.
4. **Core loop**: do the main thing once (hit, collect, jump a gap). Feedback (sound, effect, callout) shows.
5. **Lose**: get knocked out (walk off an edge with `nav` or `hook`). The loss screen says what happened
   and how to play again in a few words. `shot`.
6. **Win** (use `hook` to end with the player alive if needed). The end card explains rewards: what they
   got and why. `shot`.
7. **Lobby / shop**: open the shop, buy the cheapest item with starting currency, equip it. Prices and
   "need coins" states are clear. `shot`.
8. **Return**: the next round starts on its own or with one press.
9. **Phone**: repeat steps 1–3 with the Device Simulator on (Edit mode, before Play) or the game's touch
   layout audit (`probe uiAudit {"touch":true}` if the project has one). Nothing sits under the thumbstick.

## Reporting a walk

Per step: PASS / ISSUE, one line, the screenshot path. Then the top three things a kid would struggle
with, in order. Keep it to what you saw; don't guess at causes you didn't check.
