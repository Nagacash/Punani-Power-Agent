# The routes that ship with the app.
#
# A route says which skill answers which situation. A line that names a skill
# the machine does not have is skipped, so a route never points at nothing.
#
# These are the routes for the skills an app like this needs: a browser to
# look at a page, and a way to understand an app that was shipped as a
# binary.

when: the user wants a page opened in a browser -> browser-use
when: the user wants a screenshot of a page or of the running app -> browser-use
when: the user wants a page tested, clicked through or filled in -> browser-use
when: the user wants the running app looked at -> browser-use
when: the user wants to reverse engineer an app -> reverse-engineer-anything
when: the user wants to know how a shipped app works -> reverse-engineer-anything
when: the user wants an application decompiled, unpacked or analysed -> reverse-engineer-anything
when: the user wants a feature rebuilt from an app that already exists -> reverse-engineer-anything
when: the user points at a binary, an installer, an asar or an app bundle -> reverse-engineer-anything
