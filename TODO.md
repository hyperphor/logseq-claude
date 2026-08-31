# DONE include title 
in Page mode and perhaps elsewhere, its often necessary 

# TODO conversation support
Not sure how that works but without it this is just annoying to use, inferior to just using Claude and pasting if necessary

# DONE bad bug on first use
Apparently doesnt pick up the whole block for prompt
Root cause: `getBlock()` reads the persisted block content, which Logseq hasn't
flushed yet on a block's first edit in a session; fixed by reading
`logseq.Editor.getEditingBlockContent()` (the live editing state) instead, with
a prefix-aware fallback to strip a leftover slash-trigger fragment.

# TODO logo sux
coudn't get claude to do anything reaonable. 

# TODO needs more context 
either whole page, or everything above current block.
  partly DONE, uses the latter. Needs more control 

# TODO (maybe) more prompts and fanciness 
a la the OpenAI 3 plugin, whi

# TODO option to tag inserted text
Need this in AMMDI anyway...
DONE? it adds #AskClaude

# TODO publish 
https://github.com/logseq/marketplace (not sure its worthwhile)

