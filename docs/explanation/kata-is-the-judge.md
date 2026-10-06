# Kata is the judge

A transcript records what an agent said and which commands it attempted. It does not establish that the issue owner accepted completion, that the evidence is valid, or that the latest child state is still closed.

Automatic-parent completion therefore reads Kata's current children and accepted close events. Revision and membership checks protect the final close from stale reads. This includes work completed by people or other tools, and avoids treating a process exit as success. Explicitly bound parents remain under their owner's control.

Shell-command proof parsing was dropped from automatic-parent closure and the OMP delegate path. Quoting, compound commands, stale HEAD reads, later writes, and missing tool events make a second verdict unreliable. The parent preserves the evidence Kata accepted, including non-shell evidence. A refused close remains visible as open work for review.

Claude retains a conservative child safety net for delegates that did not close themselves. It can propose a close from fresh observed verification, but Kata still validates that proposal. This narrower fallback does not overrule an already accepted child close and is not used to judge the parent.
