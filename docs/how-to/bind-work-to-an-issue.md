# Bind work to an issue

Set `KATA_REF=example#abcd` before launching a harness to bind an existing open issue. Use qualified refs when projects could be ambiguous. This is an explicit parent: the plugin never automatically closes it.

A successful main-agent `kata claim example#abcd` also establishes a binding after a fresh state check. Todo adapters additionally observe `kata meta set example#abcd work.attention ok`; they require matching ownership. Use a standalone command so the observer can identify it safely. `KATA_REF` takes precedence in the todo adapters.

Claude provides `/kata bind example#abcd`, `/kata unbind`, and `/kata` for status. Unbind stops new tracking until another explicit bind or claim. Todo accepts `ref` on `init`; `/todo` displays the current plan.

In Claude, a first user prompt that names an open issue (`You own Kata issue example#abcd`) binds the session to it at the first delegation, so no `claude-session` parent is created. A spawn whose description or prompt names an open issue is tracked on that issue instead of a new child: the plugin writes `claude.*` metadata and the final report there and leaves closing to the delegate. The first ref introduced as owned ("Kata issue:", "issue", "you own", "owns", "tracked as", "working on", "Kata") wins; refs introduced as context ("parent", "child of", "under", "related", "see", "blocked by", "duplicate of", "superseded by") never do; a single unmarked ref wins; several unmarked refs choose nothing. A missing, closed, busy or unverifiable named issue falls back to the usual parent or child, with `claude.binding_note` saying why.

Without an explicit binding, the first tracked Claude delegation, OMP delegation, or todo initialization creates a lazy session parent. Its typed automatic marker is what grants automatic closure. A Claude session parent is titled `Claude session: <short title>`: the first sentence of the first prompt with URLs compacted and filler dropped, cut at a clause or word boundary within 60 characters. The full prompt stays in the body. Giving `todo init` a title preserves that behavior; manually creating an issue and passing its ref does not.

A later explicit binding can adopt a previous automatic parent as a child. Bindings and pending operations retain their original workspace and qualified project refs. Resume validates stored state before writing. Outside a Kata project, the todo adapters keep a session-local plan without Kata writes; it does not survive restart.
