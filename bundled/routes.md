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

# The design library. Install it with: npx skills add pbakaus/impeccable
when: the user wants a page designed, redesigned or polished -> impeccable
when: the user wants the interface critiqued, audited or made clearer -> impeccable

# Diagrams. Install it with: npx skills add cathrynlavery/diagram-design
when: the user wants a diagram, a chart or a schema drawn -> diagram-design
when: the user wants an architecture, a flowchart or a timeline made -> diagram-design

# Writing that sounds like a person. Install it with: npx skills add blader/humanizer
when: the user wants the writing to sound like a person and not a model -> humanizer
when: the user says the text sounds like AI slop -> humanizer

# Scraping. Install it with: npx skills add D4Vinci/Scrapling
when: the user wants a site scraped, crawled or its data extracted -> scrapling-official
when: a site blocks the fetch and the content has to come from a browser -> scrapling-official

# SEO and marketing. Install them with: npx skills add coreyhaines31/marketingskills
when: the user wants an SEO audit, or asks why the site is not ranking -> seo-audit
when: the user wants the copy written for a page or a product -> copywriting
when: the user wants the copy edited to read better -> copy-editing
when: the user wants a content plan -> content-strategy
when: the user wants a marketing plan -> marketing-plan
when: the user wants the competitors looked at -> competitor-profiling
when: the user wants pages built at scale for search -> programmatic-seo
when: the user wants the conversion rate improved -> cro
when: the user wants structured data for the search engines -> schema
when: the user wants the site to show up in AI answers -> ai-seo

# Engineering. Install them with: npx skills add mattpocock/skills
when: the user wants a code review -> code-review
when: the user wants the work written as tests first -> tdd
when: the user has a bug and wants the cause found -> diagnosing-bugs
when: the user wants a plan written before the work starts -> to-spec
when: the user wants the work broken into tickets -> to-tickets
when: the user wants the domain modelled -> domain-modeling
when: the user wants the codebase's structure questioned -> codebase-design
when: the user wants the architecture improved -> improve-codebase-architecture
when: the user wants the plan challenged before it is built -> grill-with-docs
when: the user wants a prototype before the real thing -> prototype
when: the user wants a look back at how the work went -> retro
when: the user wants the work sorted by what to do first -> triage
when: the user wants a pull request written -> pr

# Video. Install them with: npx skills add heygen-com/hyperframes
when: the user wants a promo video for a product or a site -> product-launch-video
when: the user wants a video of a website, a tour of a site -> website-to-video
when: the user wants an explainer video from text, notes or a topic -> faceless-explainer
when: the user wants captions on a video they have -> embedded-captions
when: the user wants a video of a pull request -> pr-to-video
when: the user wants a motion graphic, an animated title or a logo sting -> motion-graphics
when: the user wants a deck turned into a video -> slideshow
when: the user wants a video made from a video they have -> talking-head-recut
when: the user wants a clip of a song -> music-to-video
when: the user wants a video and it is not clear which kind -> hyperframes
