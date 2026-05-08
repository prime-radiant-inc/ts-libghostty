---
title: "The --More-- marker indicates more text behind the current message; only space dismisses it"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-prompts-have-fixed-shapes-recognizable-without-llm, modal-prompt-grammar-has-a-finite-shape-catalog]
---

# The --More-- marker indicates more text behind the current message; only space dismisses it

The `--More--` marker appears at the end of the message line
when NetHack has accumulated more message text than fits in
one line (or wants to ensure the player has seen the current
message before proceeding). The Guidebook §3.2 lines 502–506:

> The top line of the screen is reserved for messages that
> describe things that are impossible to represent visually.
> If you see a "--More--" on the top line, this means that
> NetHack has another message to display on the screen, but it
> wants to make certain that you've read the one that is there
> first. To read the next message, just press the space bar.

Behavior:
- Only the space bar (or in some interfaces, return) dismisses
  it. Any other keystroke is queued for the post-modal state.
- It blocks all further input including movement keys.
- Multiple `--More--` paginations can chain — dismissing one may
  reveal another.

For an autopilot:

- The `modal_prompt` interrupt catches `--More--` via regex.
- The autopilot does not auto-dismiss `--More--`; it halts and
  surfaces to the LLM. This is correct: the message text behind
  `--More--` may contain critical information (HP changes,
  monster appearances, level-change events) that the LLM should
  process.
- A more aggressive future AP could auto-dismiss `--More--`
  when the accumulated message is parseable as benign (e.g. "You
  see here a..." inventory hints), but the current conservative
  default is right.

Source: NetHack Guidebook 5.0.0 §3.2 lines 499–509.
